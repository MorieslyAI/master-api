import type { FastifyInstance, FastifyReply } from "fastify";
import { trackService } from "../services/track.service.js";
import { authenticate } from "../middleware/authenticate.js";

// ─── Route Error Handler ──────────────────────────────────────────────────────

function handleError(err: unknown, reply: FastifyReply): void {
  const e = err as Error & { statusCode?: number };
  reply.code(e.statusCode ?? 500).send({ error: e.message ?? "Terjadi kesalahan internal." });
}

// ─── Track Routes ─────────────────────────────────────────────────────────────

export async function trackRoutes(app: FastifyInstance): Promise<void> {

  // ── GET /track/data ───────────────────────────────────────────────────────
  // Semua data yang dibutuhkan halaman Track: weight history, sugar chart, macros.
  app.get<{ Querystring: { date?: string } }>(
    "/track/data",
    {
      preHandler: authenticate,
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: {
        querystring: {
          type: "object",
          properties: {
            date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      try {
        const todayStr = request.query.date ?? new Date().toISOString().split("T")[0];
        const data = await trackService.getTrackData(request.user.uid, todayStr);
        return reply.send(data);
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );

  // ── POST /track/weight ────────────────────────────────────────────────────
  // Log berat badan baru.
  app.post<{ Body: { weight: number; date?: string } }>(
    "/track/weight",
    {
      preHandler: authenticate,
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        body: {
          type: "object",
          required: ["weight"],
          properties: {
            weight: { type: "number", minimum: 1, maximum: 500 },
            date:   { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      try {
        const dateStr = request.body.date ?? new Date().toISOString().split("T")[0];
        const entry = await trackService.logWeight(
          request.user.uid,
          request.body.weight,
          dateStr,
        );
        return reply.code(201).send({ success: true, entry });
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );

  // ── GET /track/notes ──────────────────────────────────────────────────────
  // Ambil semua field notes user.
  app.get(
    "/track/notes",
    {
      preHandler: authenticate,
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      try {
        const notes = await trackService.getNotes(request.user.uid);
        return reply.send({ notes });
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );

  // ── POST /track/notes ─────────────────────────────────────────────────────
  // Buat field note baru.
  app.post<{ Body: { text: string; date?: string } }>(
    "/track/notes",
    {
      preHandler: authenticate,
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      schema: {
        body: {
          type: "object",
          required: ["text"],
          properties: {
            text: { type: "string", minLength: 1, maxLength: 1000 },
            date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      try {
        const dateStr = request.body.date ?? new Date().toISOString().split("T")[0];
        const note = await trackService.createNote(
          request.user.uid,
          request.body.text,
          dateStr,
        );
        return reply.code(201).send({ success: true, note });
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );

  // ── DELETE /track/notes/:id ───────────────────────────────────────────────
  // Hapus field note berdasarkan ID.
  app.delete<{ Params: { id: string } }>(
    "/track/notes/:id",
    {
      preHandler: authenticate,
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      schema: {
        params: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "string", minLength: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        await trackService.deleteNote(request.user.uid, request.params.id);
        return reply.send({ success: true });
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );
}
