import { randomUUID } from "crypto";
import { PassThrough } from "stream";
import type { FastifyInstance, FastifyReply } from "fastify";
import { GoogleGenAI, type LiveServerMessage, Modality } from "@google/genai";
import type { RawData, WebSocket } from "ws";
import { chatService, type SessionType } from "../services/chat.service.js";
import { videoCallService } from "../services/video-call.service.js";
import { authenticate } from "../middleware/authenticate.js";
import { verifySocketToken } from "../lib/jwt.js";
import { env } from "../config/env.js";
import { checkAndIncrementUsage } from "../services/usage.service.js";

// ─── Route Error Handler ──────────────────────────────────────────────────────

function handleError(err: unknown, reply: FastifyReply): void {
  const e = err as Error & { statusCode?: number; code?: string };
  reply.code(e.statusCode ?? 500).send({
    error: e.message ?? "An internal server error occurred.",
    ...(e.code ? { code: e.code } : {}),
  });
}

interface ProxyClientMessage {
  type: "init" | "audio" | "video" | "close";
  systemInstruction?: string;
  data?: string;
  mimeType?: string;
}

function parseProxyMessage(raw: RawData): ProxyClientMessage | null {
  try {
    const text = Array.isArray(raw)
      ? Buffer.concat(raw).toString("utf8")
      : typeof raw === "string"
        ? raw
        : raw instanceof ArrayBuffer
          ? Buffer.from(new Uint8Array(raw)).toString("utf8")
          : raw.toString("utf8");
    return JSON.parse(text) as ProxyClientMessage;
  } catch {
    return null;
  }
}

function safeSend(socket: WebSocket, payload: Record<string, unknown>): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

// ─── Chat Routes ──────────────────────────────────────────────────────────────

export async function chatRoutes(app: FastifyInstance): Promise<void> {
  const geminiLive = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });

  // ── GET /chat/video/quota ─────────────────────────────────────────────────
  // Returns today's quota + active session status for the authenticated user.
  app.get(
    "/chat/video/quota",
    {
      preHandler: authenticate,
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      try {
        const quota = await videoCallService.getQuota(request.user.uid);
        return reply.send(quota);
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );

  // ── POST /chat/video/sessions/start ───────────────────────────────────────
  // Reserve a server-authorized video call slot before opening Gemini Live.
  app.post(
    "/chat/video/sessions/start",
    {
      preHandler: authenticate,
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      try {
        const session = await videoCallService.startSession(request.user.uid);
        return reply.code(201).send(session);
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );

  // ── POST /chat/video/sessions/:id/heartbeat ───────────────────────────────
  // Keep session alive and enforce time limits server-side.
  app.post<{ Params: { id: string } }>(
    "/chat/video/sessions/:id/heartbeat",
    {
      preHandler: authenticate,
      config: { rateLimit: { max: 120, timeWindow: "1 minute" } },
      schema: {
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", minLength: 1 } },
        },
      },
    },
    async (request, reply) => {
      try {
        const status = await videoCallService.heartbeat(
          request.user.uid,
          request.params.id,
        );
        return reply.send(status);
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );

  // ── POST /chat/video/sessions/:id/end ─────────────────────────────────────
  // End session manually. Idempotent on already-ended sessions.
  app.post<{
    Params: { id: string };
    Body?: {
      reason?: string;
      transcript?: Array<{ role: string; text: string }>;
    };
  }>(
    "/chat/video/sessions/:id/end",
    {
      preHandler: authenticate,
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: {
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", minLength: 1 } },
        },
        body: {
          type: "object",
          properties: {
            reason: { type: "string", maxLength: 80 },
            transcript: {
              type: "array",
              items: {
                type: "object",
                required: ["role", "text"],
                properties: {
                  role: { type: "string" },
                  text: { type: "string" },
                },
              },
            },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      try {
        const result = await videoCallService.endSession(
          request.user.uid,
          request.params.id,
          request.body?.reason ?? "manual_end",
        );

        let summaryData = null;
        if (request.body?.transcript && request.body.transcript.length > 0) {
          summaryData = await chatService.saveVideoCallAsChatSession(
            request.user.uid,
            request.params.id,
            request.body.transcript,
          );
        }

        return reply.send({ ...result, ...(summaryData || {}) });
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );

  // ── WS /chat/video/live ───────────────────────────────────────────────────
  // Secure backend Gemini Live relay. FE sends audio/video chunks through this
  // socket so Gemini API key stays on server-side.
  app.get("/chat/video/live", { websocket: true }, (connection, request) => {
    const ws = connection.socket;
    const token = (request.query as { token?: string })?.token;
    const sessionId = (request.query as { sessionId?: string })?.sessionId;

    if (!token || !sessionId) {
      safeSend(ws, {
        type: "error",
        message: "Missing token or sessionId.",
        code: "VIDEO_SOCKET_BAD_REQUEST",
      });
      ws.close(1008, "bad_request");
      return;
    }

    let userId = "";
    try {
      const payload = verifySocketToken(token);
      if (payload.scope !== "video" && payload.scope !== "all") {
        safeSend(ws, {
          type: "error",
          message: "Socket token scope is invalid.",
          code: "VIDEO_SOCKET_SCOPE_INVALID",
        });
        ws.close(1008, "invalid_scope");
        return;
      }
      userId = payload.sub;
    } catch {
      safeSend(ws, {
        type: "error",
        message: "Socket token invalid or expired.",
        code: "VIDEO_SOCKET_TOKEN_INVALID",
      });
      ws.close(1008, "invalid_token");
      return;
    }

    let isSessionValidated = false;
    let isClosed = false;
    let hasInitializedLive = false;
    let liveSessionPromise: Promise<any> | null = null;

    const policyInterval = setInterval(async () => {
      if (!isSessionValidated || isClosed) return;

      try {
        const beat = await videoCallService.heartbeat(userId, sessionId);
        safeSend(ws, { type: "policy", ...beat });

        if (beat.shouldEnd || beat.status === "ended") {
          safeSend(ws, {
            type: "policy_end",
            reason: beat.reason ?? "policy_end",
          });
          ws.close(1000, "policy_end");
        }
      } catch (err) {
        const e = err as Error;
        safeSend(ws, {
          type: "error",
          message: e.message,
          code: "VIDEO_POLICY_CHECK_FAILED",
        });
        ws.close(1011, "policy_check_failed");
      }
    }, 10_000);

    void (async () => {
      try {
        const session = await videoCallService.getSessionSnapshot(
          userId,
          sessionId,
        );
        if (session.status !== "active") {
          safeSend(ws, {
            type: "error",
            message: "Sesi video tidak aktif.",
            code: "VIDEO_SESSION_NOT_ACTIVE",
          });
          ws.close(1008, "session_not_active");
          return;
        }

        isSessionValidated = true;
        safeSend(ws, { type: "ready", sessionId });
      } catch (err) {
        const e = err as Error & { code?: string };
        safeSend(ws, {
          type: "error",
          message: e.message,
          code: e.code ?? "VIDEO_SESSION_VALIDATE_FAILED",
        });
        ws.close(1008, "session_validate_failed");
      }
    })();

    ws.on("message", (raw) => {
      if (!isSessionValidated) {
        safeSend(ws, {
          type: "error",
          message: "Session is not ready yet.",
          code: "VIDEO_SOCKET_NOT_READY",
        });
        return;
      }

      const message = parseProxyMessage(raw as RawData);
      if (!message) {
        safeSend(ws, {
          type: "error",
          message: "Invalid JSON payload.",
          code: "VIDEO_SOCKET_BAD_PAYLOAD",
        });
        return;
      }

      if (message.type === "close") {
        ws.close(1000, "client_close");
        return;
      }

      if (message.type === "init") {
        if (hasInitializedLive) {
          safeSend(ws, {
            type: "error",
            message: "Live session already initialized.",
            code: "VIDEO_SOCKET_ALREADY_INIT",
          });
          return;
        }

        hasInitializedLive = true;
        liveSessionPromise = geminiLive.live.connect({
          model: "gemini-2.5-flash-native-audio-latest",
          config: {
            systemInstruction: {
              parts: [{ text: message.systemInstruction ?? "" }],
            },
            responseModalities: [Modality.AUDIO],
            speechConfig: {
              voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } },
            },
            inputAudioTranscription: {},
            outputAudioTranscription: {},
          },
          callbacks: {
            onopen: () => {
              safeSend(ws, { type: "open" });
            },
            onmessage: (serverMessage: LiveServerMessage) => {
              if (serverMessage.serverContent?.outputTranscription?.text) {
                safeSend(ws, {
                  type: "transcript",
                  text: serverMessage.serverContent.outputTranscription.text,
                  isUser: false,
                });
              }

              if (serverMessage.serverContent?.inputTranscription?.text) {
                safeSend(ws, {
                  type: "transcript",
                  text: serverMessage.serverContent.inputTranscription.text,
                  isUser: true,
                });
              }

              const base64Audio =
                serverMessage.serverContent?.modelTurn?.parts?.[0]?.inlineData
                  ?.data;

              if (base64Audio) {
                safeSend(ws, {
                  type: "audio",
                  data: base64Audio,
                });
              }
            },
            onclose: () => {
              safeSend(ws, { type: "closed" });
              if (!isClosed) {
                ws.close(1000, "gemini_closed");
              }
            },
            onerror: (err) => {
              const e = err as Error;
              safeSend(ws, {
                type: "error",
                message: e.message,
                code: "VIDEO_GEMINI_ERROR",
              });
              if (!isClosed) {
                ws.close(1011, "gemini_error");
              }
            },
          },
        });

        liveSessionPromise.catch((err) => {
          const e = err as Error;
          safeSend(ws, {
            type: "error",
            message: e.message || "Failed to connect to Gemini Live",
            code: "VIDEO_GEMINI_CONNECT_FAILED",
          });
          if (!isClosed) {
            ws.close(1011, "gemini_connect_failed");
          }
        });

        return;
      }

      if (!liveSessionPromise) {
        safeSend(ws, {
          type: "error",
          message: "Live session is not initialized.",
          code: "VIDEO_SOCKET_NOT_INITIALIZED",
        });
        return;
      }

      if (message.type === "audio" && message.data) {
        void liveSessionPromise
          .then((session) =>
            session.sendRealtimeInput({
              audio: {
                data: message.data,
                mimeType: message.mimeType ?? "audio/pcm;rate=16000",
              },
            }),
          )
          .catch(() => {
            safeSend(ws, {
              type: "error",
              message: "Failed to forward audio frame.",
              code: "VIDEO_AUDIO_FORWARD_FAILED",
            });
          });
        return;
      }

      if (message.type === "video" && message.data) {
        void liveSessionPromise
          .then((session) =>
            session.sendRealtimeInput({
              video: {
                data: message.data,
                mimeType: message.mimeType ?? "image/jpeg",
              },
            }),
          )
          .catch(() => {
            safeSend(ws, {
              type: "error",
              message: "Failed to forward video frame.",
              code: "VIDEO_FRAME_FORWARD_FAILED",
            });
          });
      }
    });

    ws.on("close", () => {
      if (isClosed) return;
      isClosed = true;
      clearInterval(policyInterval);

      if (liveSessionPromise) {
        void liveSessionPromise
          .then((session) => {
            if (typeof session.close === "function") {
              session.close();
            }
          })
          .catch(() => {});
      }

      void videoCallService
        .endSession(userId, sessionId, "socket_closed")
        .catch(() => {});
    });

    ws.on("error", () => {
      if (isClosed) return;
      isClosed = true;
      clearInterval(policyInterval);
      void videoCallService
        .endSession(userId, sessionId, "socket_error")
        .catch(() => {});
    });
  });

  // ── POST /chat/sessions ─────────────────────────────────────────────────────
  // Create a new chat session. Returns the new session metadata.
  app.post<{ Body: { sessionType?: SessionType } }>(
    "/chat/sessions",
    {
      preHandler: authenticate,
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      schema: {
        body: {
          type: "object",
          properties: {
            sessionType: {
              type: "string",
              enum: ["chat", "video", "clinical"],
            },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      try {
        const session = await chatService.createSession(
          request.user.uid,
          request.body.sessionType ?? "chat",
        );
        return reply.code(201).send(session);
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );

  // ── GET /chat/sessions ──────────────────────────────────────────────────────
  // List all sessions for the authenticated user (newest first).
  app.get<{ Querystring: { limit?: number } }>(
    "/chat/sessions",
    {
      preHandler: authenticate,
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: {
        querystring: {
          type: "object",
          properties: {
            limit: { type: "number", minimum: 1, maximum: 100 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      try {
        const sessions = await chatService.getSessions(
          request.user.uid,
          request.query.limit ?? 30,
        );
        return reply.send({ sessions });
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );

  // ── GET /chat/sessions/:id ──────────────────────────────────────────────────
  // Get one session + its full message history.
  app.get<{ Params: { id: string } }>(
    "/chat/sessions/:id",
    {
      preHandler: authenticate,
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: {
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
      },
    },
    async (request, reply) => {
      try {
        const result = await chatService.getSession(
          request.user.uid,
          request.params.id,
        );
        return reply.send(result);
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );

  // ── POST /chat/sessions/:id/message ────────────────────────────────────────
  // Send a user message and stream back the AI response via SSE.
  //
  // Request body:
  //   message      — the user's text
  //   history      — prior turns [{ role, text }]
  //   userProfile  — { name, age, weight } for Dr. Moriesly's system prompt
  //   imageBase64  — optional attached image (base64, no data URI prefix)
  //
  // Response: text/event-stream
  //   data: { token: "..." }      ← streamed tokens
  //   data: [DONE]                ← stream complete
  //   data: { error: "..." }      ← on failure
  app.post<{
    Params: { id: string };
    Body: {
      message: string;
      history: Array<{ role: "user" | "model"; text: string }>;
      userProfile: { name: string; age: number; weight: number };
      imageBase64?: string;
    };
  }>(
    "/chat/sessions/:id/message",
    {
      preHandler: authenticate,
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const { id: sessionId } = request.params;
      const { message, history, userProfile, imageBase64 } = request.body;
      const userId = request.user.uid;
      // Check chat limits
      const usage = await checkAndIncrementUsage(userId, "chat");
      if (!usage.allowed) {
        return reply.status(429).send({
          error: `Limit chat harian Anda telah mencapai batas maksimal (${usage.limit} pesan/hari).`,
        });
      }
      // ── Create a PassThrough stream so Fastify (+ CORS plugin) processes
      //    headers normally before we start writing tokens.
      const sseStream = new PassThrough();

      reply.headers({
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });

      // Fastify will pipe sseStream → socket and apply all hooks (incl. CORS).
      reply.send(sseStream);

      // ── Save user message to Firestore ─────────────────────────────────────
      try {
        await chatService.addMessage(userId, sessionId, {
          id: randomUUID(),
          sessionId,
          role: "user",
          text: message,
          timestamp: new Date().toISOString(),
        });
      } catch (saveErr) {
        app.log.warn({ err: saveErr }, "Failed to save user message.");
      }

      // ── Stream Gemini response ──────────────────────────────────────────────
      let fullText = "";
      try {
        const geminiStream = chatService.generateStream(
          userProfile,
          history,
          message,
          imageBase64,
        );

        for await (const token of geminiStream) {
          fullText += token;
          sseStream.write(`data: ${JSON.stringify({ token })}\n\n`);
        }

        // ── Save model reply to Firestore after stream completes ─────────────
        await chatService.addMessage(userId, sessionId, {
          id: randomUUID(),
          sessionId,
          role: "model",
          text: fullText,
          timestamp: new Date().toISOString(),
        });

        sseStream.write("data: [DONE]\n\n");
      } catch (streamErr: any) {
        app.log.error("Chat stream error:", streamErr);
        sseStream.write(
          `data: ${JSON.stringify({ error: streamErr.message ?? "Generation failed." })}\n\n`,
        );
      } finally {
        sseStream.end();
      }
    },
  );

  // ── PUT /chat/sessions/:id/end ──────────────────────────────────────────────
  // End a session: generate summary + advice from transcript, mark as ended.
  // Body: { transcript: [{ role, text }] }
  app.put<{
    Params: { id: string };
    Body: { transcript: Array<{ role: string; text: string }> };
  }>(
    "/chat/sessions/:id/end",
    {
      preHandler: authenticate,
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      schema: {
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        body: {
          type: "object",
          required: ["transcript"],
          properties: {
            transcript: {
              type: "array",
              items: {
                type: "object",
                required: ["role", "text"],
                properties: {
                  role: { type: "string", enum: ["user", "model"] },
                  text: { type: "string" },
                },
              },
            },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      try {
        const result = await chatService.endSession(
          request.user.uid,
          request.params.id,
          request.body.transcript,
        );
        return reply.send(result);
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );

  // ── DELETE /chat/sessions/:id ───────────────────────────────────────────────
  // Delete a session and all its messages.
  app.delete<{ Params: { id: string } }>(
    "/chat/sessions/:id",
    {
      preHandler: authenticate,
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      schema: {
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
      },
    },
    async (request, reply) => {
      try {
        await chatService.deleteSession(request.user.uid, request.params.id);
        return reply.send({ success: true });
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );
}
