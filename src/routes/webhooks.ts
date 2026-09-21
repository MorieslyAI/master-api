import type { FastifyInstance, FastifyReply } from "fastify";
import { env } from "../config/env.js";
import {
  handleRevenueCatWebhookEvent,
  type RevenueCatWebhookEvent,
} from "../services/revenuecat.service.js";

function handleError(err: unknown, reply: FastifyReply): void {
  const e = err as Error & { statusCode?: number };
  reply.code(e.statusCode ?? 500).send({ error: e.message ?? "Terjadi kesalahan internal." });
}

interface RevenueCatWebhookBody {
  event: RevenueCatWebhookEvent;
}

export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  // ── POST /webhooks/revenuecat ─────────────────────────────────────────────
  // Dipanggil server-to-server oleh RevenueCat, BUKAN oleh client — jadi tidak
  // pakai middleware `authenticate` (Firebase ID Token). Otentikasi request ini
  // memakai header "Authorization" statis yang dikonfigurasi di RevenueCat
  // Dashboard → Project Settings → Integrations → Webhooks.
  app.post<{ Body: RevenueCatWebhookBody }>(
    "/webhooks/revenuecat",
    {
      config: { rateLimit: { max: 300, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      if (!env.REVENUECAT_WEBHOOK_AUTH_HEADER) {
        request.log.error(
          "[revenuecat] REVENUECAT_WEBHOOK_AUTH_HEADER belum dikonfigurasi — menolak semua webhook.",
        );
        return reply.code(503).send({ error: "Webhook belum dikonfigurasi." });
      }

      const authHeader = request.headers["authorization"];
      if (authHeader !== env.REVENUECAT_WEBHOOK_AUTH_HEADER) {
        return reply.code(401).send({ error: "Signature/otorisasi webhook tidak valid." });
      }

      const event = request.body?.event;
      if (!event) {
        return reply.code(400).send({ error: 'Payload tidak memiliki field "event".' });
      }

      try {
        await handleRevenueCatWebhookEvent(event);
        return reply.code(200).send({ received: true });
      } catch (err) {
        request.log.error(err, "[revenuecat] Gagal memproses webhook.");
        return handleError(err, reply);
      }
    },
  );
}
