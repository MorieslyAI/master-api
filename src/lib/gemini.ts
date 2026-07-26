import { FieldValue } from "firebase-admin/firestore";
import {
  GoogleGenAI,
  type GenerateContentParameters,
  type GenerateContentResponse,
} from "@google/genai";
import { getDb } from "./firebase.js";
import { logger } from "./logger.js";
import { env } from "../config/env.js";

/**
 * Single shared Gemini client for the whole app. Replaces the several
 * `new GoogleGenAI(...)` instantiations that used to live in each service.
 */
export const geminiClient = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });

// ─── Types ────────────────────────────────────────────────────────────────────

export interface GeminiCallMeta {
  /** Stable label identifying which call site produced this usage, e.g. "scan.food", "chat.live". */
  feature: string;
  /** request.user.uid, when available. */
  userId?: string;
  /** Only set for long-lived sessions (Gemini Live). */
  sessionId?: string;
}

/**
 * Fields shared between `GenerateContentResponseUsageMetadata` (generateContent/
 * generateContentStream) and Gemini Live's `UsageMetadata`. Live uses
 * `responseTokenCount` where the rest of the SDK uses `candidatesTokenCount` —
 * callers normalize that before calling `recordGeminiUsage`.
 */
export interface UsageMetadataLike {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
  thoughtsTokenCount?: number;
  cachedContentTokenCount?: number;
}

/** Client-facing token usage shape, attached to Gemini-backed API responses. */
export interface NormalizedGeminiUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

function normalizeUsage(usage: UsageMetadataLike | undefined): NormalizedGeminiUsage | undefined {
  if (!usage) return undefined;
  return {
    inputTokens: usage.promptTokenCount,
    outputTokens: usage.candidatesTokenCount,
    totalTokens: usage.totalTokenCount,
  };
}

interface GeminiUsageRecord {
  feature: string;
  model: string;
  userId?: string;
  sessionId?: string;
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
  thoughtsTokenCount?: number;
  cachedContentTokenCount?: number;
  status: "ok" | "no_usage_data";
  createdAt: FirebaseFirestore.FieldValue;
}

// ─── Core recording primitive ──────────────────────────────────────────────────

/**
 * Logs + persists token usage for a single Gemini request/session. Never
 * throws — this is a best-effort audit/observability layer and must never
 * affect the underlying Gemini call's behavior toward the end user.
 */
export function recordGeminiUsage(
  meta: GeminiCallMeta & { model: string },
  usage: UsageMetadataLike | undefined,
): void {
  try {
    const record: GeminiUsageRecord = {
      feature: meta.feature,
      model: meta.model,
      userId: meta.userId,
      sessionId: meta.sessionId,
      promptTokenCount: usage?.promptTokenCount,
      candidatesTokenCount: usage?.candidatesTokenCount,
      totalTokenCount: usage?.totalTokenCount,
      thoughtsTokenCount: usage?.thoughtsTokenCount,
      cachedContentTokenCount: usage?.cachedContentTokenCount,
      status: usage ? "ok" : "no_usage_data",
      createdAt: FieldValue.serverTimestamp(),
    };

    logger.info(
      {
        feature: record.feature,
        model: record.model,
        userId: record.userId,
        sessionId: record.sessionId,
        promptTokenCount: record.promptTokenCount,
        candidatesTokenCount: record.candidatesTokenCount,
        totalTokenCount: record.totalTokenCount,
        thoughtsTokenCount: record.thoughtsTokenCount,
        cachedContentTokenCount: record.cachedContentTokenCount,
        status: record.status,
      },
      "gemini.usage",
    );

    // Fire-and-forget: never block/delay the caller's response on this write.
    const docRef = record.userId
      ? getDb()
          .collection("users")
          .doc(record.userId)
          .collection("geminiUsage")
          .doc()
      : getDb().collection("geminiUsageUnattributed").doc();

    void docRef.set(record).catch((err) => {
      logger.warn({ err, feature: meta.feature }, "gemini.usage.persist_failed");
    });
  } catch (err) {
    // Must never throw out of this function.
    logger.warn({ err, feature: meta.feature }, "gemini.usage.record_failed");
  }
}

// ─── Tracked wrappers ───────────────────────────────────────────────────────────

/**
 * Wraps `geminiClient.models.generateContent`: records token usage server-side
 * (log + Firestore, via `recordGeminiUsage`) and also returns a normalized
 * `usage` object the caller can surface back to the API client.
 */
export async function generateContentTracked(
  params: GenerateContentParameters,
  meta: GeminiCallMeta,
): Promise<{ response: GenerateContentResponse; usage: NormalizedGeminiUsage | undefined }> {
  const response = await geminiClient.models.generateContent(params);
  recordGeminiUsage({ ...meta, model: String(params.model) }, response.usageMetadata);
  return { response, usage: normalizeUsage(response.usageMetadata) };
}

/**
 * Wraps `geminiClient.models.generateContentStream`: records token usage
 * server-side once the stream completes (or is exited early), and yields
 * chunks through unchanged. The final normalized `usage` is available as the
 * generator's *return* value (i.e. via manual `.next()` iteration, or as the
 * value on the last `{ done: true }` result) — `for await...of` alone
 * discards it, so callers that need it must drive iteration manually.
 */
export async function* generateContentStreamTracked(
  params: GenerateContentParameters,
  meta: GeminiCallMeta,
): AsyncGenerator<GenerateContentResponse, NormalizedGeminiUsage | undefined> {
  let lastUsage: UsageMetadataLike | undefined;
  try {
    const stream = await geminiClient.models.generateContentStream(params);
    for await (const chunk of stream) {
      if (chunk.usageMetadata) lastUsage = chunk.usageMetadata;
      yield chunk;
    }
  } finally {
    recordGeminiUsage({ ...meta, model: String(params.model) }, lastUsage);
  }
  return normalizeUsage(lastUsage);
}
