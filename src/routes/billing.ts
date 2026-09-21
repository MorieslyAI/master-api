import type { FastifyInstance, FastifyReply } from "fastify";
import { billingService } from "../services/billing.service.js";
import { authenticate } from "../middleware/authenticate.js";

function handleError(err: unknown, reply: FastifyReply): void {
  const e = err as Error & { statusCode?: number };
  reply.code(e.statusCode ?? 500).send({ error: e.message ?? "Terjadi kesalahan internal." });
}

export async function billingRoutes(app: FastifyInstance): Promise<void> {
  // ── GET /billing/status ───────────────────────────────────────────────────
  // Plan aktif user + batas fitur + pemakaian hari ini. Dipakai FE untuk
  // menampilkan status langganan dan sisa kuota (scan/chat).
  app.get(
    "/billing/status",
    {
      preHandler: authenticate,
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      try {
        const status = await billingService.getStatus(request.user.uid);
        return reply.send(status);
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );
}
