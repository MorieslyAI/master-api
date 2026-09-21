import type { FastifyInstance, FastifyReply } from "fastify";
import {
  bioSynergyService,
  BioSynergyError,
} from "../services/bio-synergy.service.js";
import { authenticate } from "../middleware/authenticate.js";

// ─── Error Helper ─────────────────────────────────────────────────────────────

function handleError(err: unknown, reply: FastifyReply): void {
  // Cooldown / in-progress: sertakan status agar klien bisa langsung menampilkan
  // hasil yang sudah ada + kapan boleh generate lagi, tanpa request tambahan.
  if (err instanceof BioSynergyError) {
    reply.code(err.statusCode).send({
      error: err.message,
      code: err.code,
      ...err.status,
    });
    return;
  }
  const e = err as Error & { statusCode?: number };
  reply
    .code(e.statusCode ?? 500)
    .send({ error: e.message ?? "An internal server error occurred." });
}

// ─── Bio-Synergy Routes ───────────────────────────────────────────────────────

export async function bioSynergyRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authenticate);

  // ── GET /bio-synergy ──────────────────────────────────────────────────────
  // Hasil analisis terakhir + status cooldown.
  // Response: { report: { text, model, createdAt } | null, canGenerate, nextAvailableAt }
  app.get(
    "/bio-synergy",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request, reply) => {
      try {
        return reply.send(await bioSynergyService.getStatus(request.user.uid));
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );

  // ── POST /bio-synergy/generate ────────────────────────────────────────────
  // Jalankan engine. Maks. 1x per 24 jam per user; di dalam cooldown → 409
  // (BIO_SYNERGY_COOLDOWN) dengan hasil terakhir tetap disertakan.
  // Body (opsional): { localDate: "YYYY-MM-DD" } — acuan "hari ini" di perangkat user.
  app.post<{ Body: { localDate?: string } | undefined }>(
    "/bio-synergy/generate",
    {
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
      schema: {
        body: {
          type: ["object", "null"],
          properties: {
            localDate: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      try {
        const { status, usage } = await bioSynergyService.generate(
          request.user.uid,
          request.body?.localDate,
        );
        return reply.send({ ...status, usage });
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );
}
