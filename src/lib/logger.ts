import pino from "pino";
import { env } from "../config/env.js";

/**
 * Shared Pino instance. Passed into Fastify (so `app.log`/`request.log` use it
 * directly) and imported by plain service modules that have no Fastify
 * instance to log through — this keeps route logs and service logs in one
 * consistent structured format.
 */
export const logger = pino({
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
});
