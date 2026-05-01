import type { FastifyInstance, FastifyReply } from "fastify";
import { notificationsService } from "../services/notifications.service.js";
import { authenticate } from "../middleware/authenticate.js";

// ─── Route Error Handler ──────────────────────────────────────────────────────

function handleError(err: unknown, reply: FastifyReply): void {
  const e = err as Error & { statusCode?: number };
  reply
    .code(e.statusCode ?? 500)
    .send({ error: e.message ?? "An internal server error occurred." });
}

// ─── Notification Routes ──────────────────────────────────────────────────────

export async function notificationRoutes(app: FastifyInstance): Promise<void> {

  // ── GET /notifications ──────────────────────────────────────────────────────
  // Returns the user's recent notifications (newest first) + unread count.
  // Query params:
  //   limit  — max number to return (default: 30)
  app.get<{ Querystring: { limit?: number } }>(
    "/notifications",
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
        const result = await notificationsService.getAll(
          request.user.uid,
          request.query.limit ?? 30,
        );
        return reply.send(result);
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );

  // ── GET /notifications/unread-count ────────────────────────────────────────
  // Lightweight endpoint for badge refresh — returns only the unread count.
  app.get(
    "/notifications/unread-count",
    {
      preHandler: authenticate,
      config: { rateLimit: { max: 120, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      try {
        const count = await notificationsService.getUnreadCount(request.user.uid);
        return reply.send({ unreadCount: count });
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );

  // ── PUT /notifications/read-all ─────────────────────────────────────────────
  // Marks all unread notifications as read.
  app.put(
    "/notifications/read-all",
    {
      preHandler: authenticate,
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      try {
        await notificationsService.markAllRead(request.user.uid);
        return reply.send({ success: true });
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );

  // ── DELETE /notifications/:id ───────────────────────────────────────────────
  // Deletes a single notification by its ID.
  app.delete<{ Params: { id: string } }>(
    "/notifications/:id",
    {
      preHandler: authenticate,
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: {
        params: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        await notificationsService.deleteOne(request.user.uid, request.params.id);
        return reply.send({ success: true });
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );
}
