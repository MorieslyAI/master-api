import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import { env } from "./config/env.js";
import { healthRoutes } from "./routes/health.js";
import { authRoutes } from "./routes/auth.js";
import { userRoutes } from "./routes/user.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { scanRoutes } from "./routes/scan.js";
import { chatRoutes } from "./routes/chat.js";
import { exploreRoutes } from "./routes/explore.js";
import { dietRoutes } from "./routes/diet.js";
import { trainingRoutes } from "./routes/training.js";
import { notificationRoutes } from "./routes/notifications.js";
import { trackRoutes } from "./routes/track.js";
import { groupChatRoutes } from "./routes/group-chat.js";

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: env.NODE_ENV === "production" ? "info" : "debug",
      ...(env.NODE_ENV !== "production" && {
        transport: {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "SYS:HH:MM:ss",
            ignore: "pid,hostname",
          },
        },
      }),
    },
    trustProxy: true,
  });

  // ── Security Headers ────────────────────────────────────────────────────────
  await app.register(helmet, { contentSecurityPolicy: false });

  // ── CORS ───────────────────────────────────────────────────────────────────
  // Di mobile (Capacitor), origin biasanya salah satu dari:
  // - Android: https://localhost (karena androidScheme: "https")
  // - iOS:     capacitor://localhost
  // Jadi kita dukung daftar origin via env.CORS_ORIGIN (comma-separated).
  const corsAllowedOrigins = new Set(
    env.CORS_ORIGIN.split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

  // Default tambahan yang aman untuk development mobile.
  corsAllowedOrigins.add("https://localhost");
  corsAllowedOrigins.add("http://localhost");
  corsAllowedOrigins.add("capacitor://localhost");

  await app.register(cors, {
    origin: (origin, cb) => {
      // Jika tidak ada Origin header (mis. curl / server-to-server), allow.
      if (!origin) return cb(null, true);
      if (corsAllowedOrigins.has(origin)) return cb(null, true);
      return cb(new Error(`CORS blocked for origin: ${origin}`), false);
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  });

  // ── Cookie ─────────────────────────────────────────────────────────────────
  await app.register(cookie);

  // ── WebSocket ──────────────────────────────────────────────────────────────
  await app.register(websocket);

  // ── Rate Limiting (in-memory) ──────────────────────────────────────────────
  await app.register(rateLimit, {
    global: true,
    max: 100,
    timeWindow: "1 minute",
    keyGenerator: (req) => req.ip,
    errorResponseBuilder: (_req, context) => ({
      error: "Terlalu banyak permintaan. Coba lagi sebentar.",
      statusCode: 429,
      retryAfter: context.after,
    }),
  });

  // ── Global Error Handler ────────────────────────────────────────────────────
  app.setErrorHandler((err, _request, reply) => {
    if (err.validation) {
      return reply.code(400).send({
        error: "Input tidak valid.",
        detail: err.message,
      });
    }
    app.log.error(err);
    return reply.code(err.statusCode ?? 500).send({
      error: err.message ?? "Terjadi kesalahan internal.",
    });
  });

  // ── Not Found Handler ───────────────────────────────────────────────────────
  app.setNotFoundHandler((_request, reply) => {
    reply.code(404).send({ error: "Endpoint tidak ditemukan." });
  });

  // ── Routes ─────────────────────────────────────────────────────────────────
  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(userRoutes);
  await app.register(dashboardRoutes);
  await app.register(chatRoutes);
  await app.register(scanRoutes, { prefix: "/scan" });
  await app.register(exploreRoutes);
  await app.register(dietRoutes);
  await app.register(trainingRoutes);
  await app.register(notificationRoutes);
  await app.register(trackRoutes);
  await app.register(groupChatRoutes);

  return app;
}
