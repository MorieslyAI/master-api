import type { FastifyInstance } from "fastify";
import { authenticate } from "../middleware/authenticate.js";
import { requireAdmin } from "../middleware/requireAdmin.js";
import {
  accountDeletionService,
  type AccountDeletionFilters,
  type UpdateAccountDeletionStatusDTO,
} from "../services/account-deletion.service.js";

interface ListQuery {
  search?: string;
  status?: AccountDeletionFilters["status"];
}

interface RequestParams {
  requestId: string;
}

export async function adminAccountDeletionRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.get<{ Querystring: ListQuery }>(
    "/api/admin/account-deletion-requests",
    {
      preHandler: [authenticate, requireAdmin],
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            search: { type: "string", maxLength: 120 },
            status: {
              type: "string",
              enum: ["pending", "processing", "completed", "rejected"],
            },
          },
        },
      },
    },
    async (request, reply) => {
      const result = await accountDeletionService.listForAdmin(request.query);
      return reply.send(result);
    },
  );

  app.patch<{
    Params: RequestParams;
    Body: UpdateAccountDeletionStatusDTO;
  }>(
    "/api/admin/account-deletion-requests/:requestId/status",
    {
      preHandler: [authenticate, requireAdmin],
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        params: {
          type: "object",
          required: ["requestId"],
          properties: {
            requestId: { type: "string", minLength: 1, maxLength: 128 },
          },
        },
        body: {
          type: "object",
          required: ["status"],
          additionalProperties: false,
          properties: {
            status: {
              type: "string",
              enum: ["processing", "completed", "rejected"],
            },
            adminNote: {
              anyOf: [
                { type: "string", maxLength: 1000 },
                { type: "null" },
              ],
            },
          },
        },
      },
    },
    async (request, reply) => {
      if (request.body.status === "rejected" && !request.body.adminNote?.trim()) {
        return reply.code(400).send({
          error: "Catatan admin wajib diisi ketika menolak permintaan.",
        });
      }

      const item = await accountDeletionService.updateStatus(
        request.params.requestId,
        request.user.uid,
        request.body,
      );
      return reply.send({
        message: "Status permintaan penghapusan berhasil diperbarui.",
        item,
      });
    },
  );
}
