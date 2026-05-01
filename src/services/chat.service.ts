import { FieldValue } from "firebase-admin/firestore";
import { GoogleGenAI } from "@google/genai";
import { getDb } from "../lib/firebase.js";
import { env } from "../config/env.js";

// ─── Firestore Schema ─────────────────────────────────────────────────────────
//
//  users/{uid}/chat_sessions/{sessionId}          ← session metadata
//  users/{uid}/chat_sessions/{sessionId}/messages/{msgId}  ← messages
//
const COL_USERS    = "users";
const SUB_SESSIONS = "chat_sessions";
const SUB_MESSAGES = "messages";

// ─── Types ────────────────────────────────────────────────────────────────────

export type SessionType = "chat" | "video" | "clinical";
export type SessionStatus = "active" | "ended";

export interface ChatSessionDoc {
  id: string;
  sessionType: SessionType;
  status: SessionStatus;
  summary: string;
  advice: string;
  messageCount: number;
  createdAt: string;   // ISO
  updatedAt: string;   // ISO
}

export interface ChatMessageDoc {
  id: string;
  sessionId: string;
  role: "user" | "model";
  text: string;
  timestamp: string;   // ISO
}

export interface SessionWithMessages {
  session: ChatSessionDoc;
  messages: ChatMessageDoc[];
}

// ─── Chat Service ─────────────────────────────────────────────────────────────

export const chatService = {

  // ── Create a new session ────────────────────────────────────────────────────
  async createSession(
    userId: string,
    sessionType: SessionType = "chat",
  ): Promise<ChatSessionDoc> {
    const db  = getDb();
    const ref = db
      .collection(COL_USERS)
      .doc(userId)
      .collection(SUB_SESSIONS)
      .doc();

    const now = new Date().toISOString();
    const session: ChatSessionDoc = {
      id:           ref.id,
      sessionType,
      status:       "active",
      summary:      "",
      advice:       "",
      messageCount: 0,
      createdAt:    now,
      updatedAt:    now,
    };

    await ref.set(session);
    return session;
  },

  // ── List all sessions for a user (newest first) ─────────────────────────────
  async getSessions(userId: string, limit = 30): Promise<ChatSessionDoc[]> {
    const db = getDb();
    const snap = await db
      .collection(COL_USERS)
      .doc(userId)
      .collection(SUB_SESSIONS)
      .orderBy("createdAt", "desc")
      .limit(limit)
      .get();

    return snap.docs.map((d) => d.data() as ChatSessionDoc);
  },

  // ── Get a single session + its messages ─────────────────────────────────────
  async getSession(
    userId: string,
    sessionId: string,
  ): Promise<SessionWithMessages> {
    const db          = getDb();
    const sessionSnap = await db
      .collection(COL_USERS)
      .doc(userId)
      .collection(SUB_SESSIONS)
      .doc(sessionId)
      .get();

    if (!sessionSnap.exists) {
      const err = new Error("Chat session not found.") as Error & { statusCode: number };
      err.statusCode = 404;
      throw err;
    }

    const session = sessionSnap.data() as ChatSessionDoc;

    const msgsSnap = await db
      .collection(COL_USERS)
      .doc(userId)
      .collection(SUB_SESSIONS)
      .doc(sessionId)
      .collection(SUB_MESSAGES)
      .orderBy("timestamp", "asc")
      .get();

    const messages = msgsSnap.docs.map((d) => d.data() as ChatMessageDoc);
    return { session, messages };
  },

  // ── Persist a single message ────────────────────────────────────────────────
  async addMessage(
    userId: string,
    sessionId: string,
    message: ChatMessageDoc,
  ): Promise<void> {
    const db = getDb();
    const sessionRef = db
      .collection(COL_USERS)
      .doc(userId)
      .collection(SUB_SESSIONS)
      .doc(sessionId);

    await sessionRef
      .collection(SUB_MESSAGES)
      .doc(message.id)
      .set(message);

    // Bump messageCount + updatedAt atomically
    await sessionRef.update({
      messageCount: FieldValue.increment(1),
      updatedAt:    new Date().toISOString(),
    });
  },

  // ── Stream Gemini response (async generator) ────────────────────────────────
  async *generateStream(
    userProfile: { name: string; age: number; weight: number },
    history: Array<{ role: "user" | "model"; text: string }>,
    userMessage: string,
    imageBase64?: string,
  ): AsyncGenerator<string> {
    const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });

    const systemInstruction = [
      `You are "Dr. Moriesly", a gentle, polite, and caring health consultant.`,
      `USER INFO: ${userProfile.name}, ${userProfile.age}yo, ${userProfile.weight}kg.`,
      `TONE: Warm, empathetic, professional but accessible. Like a kind doctor talking to a patient they care about.`,
      `LANGUAGE: You MUST always respond exclusively in English, regardless of the language the user writes in.`,
      `If the user writes in any other language, still reply fully in English.`,
    ].join(" ");

    // Build Gemini conversation history
    const historyPayload = history.map((m) => ({
      role:  m.role,
      parts: [{ text: m.text }],
    }));

    // Build current turn parts (supports optional image)
    const currentParts: any[] = [];
    if (imageBase64) {
      currentParts.push({
        inlineData: { mimeType: "image/jpeg", data: imageBase64 },
      });
      currentParts.push({
        text: `${userMessage}\n\n[USER SENT AN IMAGE] Look at this photo. Tell me exactly what it is, guess the sugar (grams), and give me a verdict. Be honest but talk like a friend.`,
      });
    } else {
      currentParts.push({ text: userMessage });
    }

    const fullContents = [
      ...historyPayload,
      { role: "user", parts: currentParts },
    ];

    const stream = await ai.models.generateContentStream({
      model:    "gemini-2.5-flash",
      contents: fullContents,
      config:   { systemInstruction, temperature: 0.7 },
    });

    for await (const chunk of stream) {
      const token = chunk.text;
      if (token) yield token;
    }
  },

  // ── Generate AI summary (helper) ────────────────────────────────────────────
  async generateSessionSummary(
    transcript: Array<{ role: string; text: string }>,
  ): Promise<{ summary: string; advice: string }> {
    let summary = "Session completed.";
    let advice  = "Keep up the great work!";

    if (transcript.length > 1) {
      try {
        const ai            = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
        const transcriptTxt = transcript
          .map((m) => `${m.role.toUpperCase()}: ${m.text}`)
          .join("\n");

        const prompt = `
          Analyze this consultation transcript between a User and Dr. Moriesly.
          1. Write a concise "Summary" of the discussion (max 20 words).
          2. Write a gentle "Advice" or suggestion based on the conversation.
          IMPORTANT: Both "summary" and "advice" MUST be written in English only.
          Return strictly JSON: { "summary": "...", "advice": "..." }
          TRANSCRIPT: ${transcriptTxt}
        `;

        const response = await ai.models.generateContent({
          model:    "gemini-2.5-flash",
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          config:   { responseMimeType: "application/json" },
        });

        if (response.text) {
          const raw  = response.text.replace(/```json/g, "").replace(/```/g, "").trim();
          const data = JSON.parse(raw);
          summary    = data.summary || summary;
          advice     = data.advice  || advice;
        }
      } catch (e) {
        console.error("[chat.service] Failed to generate session summary:", e);
      }
    }

    return { summary, advice };
  },

  // ── Save Video Call as Chat Session ─────────────────────────────────────────
  async saveVideoCallAsChatSession(
    userId: string,
    sessionId: string,
    transcript: Array<{ role: string; text: string }>,
  ): Promise<{ summary: string; advice: string }> {
    const { summary, advice } = await this.generateSessionSummary(transcript);
    
    const db = getDb();
    const now = new Date().toISOString();
    const sessionRef = db
      .collection(COL_USERS)
      .doc(userId)
      .collection(SUB_SESSIONS)
      .doc(sessionId);

    const session: ChatSessionDoc = {
      id: sessionId,
      sessionType: "video",
      status: "ended",
      summary,
      advice,
      messageCount: transcript.length,
      createdAt: now,
      updatedAt: now,
    };

    const batch = db.batch();
    batch.set(sessionRef, session);

    transcript.forEach((m, idx) => {
      const msgRef = sessionRef.collection(SUB_MESSAGES).doc();
      batch.set(msgRef, {
        id: msgRef.id,
        sessionId: sessionId,
        role: m.role === "user" ? "user" : "model",
        text: m.text,
        timestamp: new Date(Date.now() + idx).toISOString(),
      });
    });

    await batch.commit();

    return { summary, advice };
  },

  // ── End a session: generate AI summary, mark as ended ──────────────────────
  async endSession(
    userId: string,
    sessionId: string,
    transcript: Array<{ role: string; text: string }>,
  ): Promise<{ summary: string; advice: string }> {
    const { summary, advice } = await this.generateSessionSummary(transcript);

    await getDb()
      .collection(COL_USERS)
      .doc(userId)
      .collection(SUB_SESSIONS)
      .doc(sessionId)
      .update({
        status:    "ended",
        summary,
        advice,
        updatedAt: new Date().toISOString(),
      });

    return { summary, advice };
  },

  // ── Delete session + all its messages (batch) ───────────────────────────────
  async deleteSession(userId: string, sessionId: string): Promise<void> {
    const db         = getDb();
    const sessionRef = db
      .collection(COL_USERS)
      .doc(userId)
      .collection(SUB_SESSIONS)
      .doc(sessionId);

    // Delete messages subcollection first
    const msgsSnap = await sessionRef.collection(SUB_MESSAGES).get();
    const batch    = db.batch();
    msgsSnap.docs.forEach((d) => batch.delete(d.ref));
    batch.delete(sessionRef);
    await batch.commit();
  },
};
