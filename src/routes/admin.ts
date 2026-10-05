import type { FastifyInstance, FastifyReply } from "fastify";
import { authenticate } from "../middleware/authenticate.js";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { adminService } from "../services/admin.service.js";

function handleError(err: unknown, reply: FastifyReply): void {
  const e = err as Error & { statusCode?: number };
  reply
    .code(e.statusCode ?? 500)
    .send({ error: e.message ?? "Terjadi kesalahan internal." });
}

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authenticate);
  app.addHook("preHandler", requireAdmin);

  app.get("/admin/overview", async (_request, reply) => {
    try {
      return reply.send(await adminService.getOverview());
    } catch (err) {
      return handleError(err, reply);
    }
  });

  app.get<{
    Querystring: {
      search?: string;
      role?: "admin" | "user";
      plan?: string;
      status?: "active" | "suspended" | "deleted";
      sortBy?: "email" | "displayName" | "createdAt" | "updatedAt" | "expiredAt";
      sortDir?: "asc" | "desc";
      page?: number;
      limit?: number;
    };
  }>(
    "/admin/users",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            search: { type: "string" },
            role: { type: "string", enum: ["admin", "user"] },
            plan: { type: "string" },
            status: { type: "string", enum: ["active", "suspended", "deleted"] },
            sortBy: {
              type: "string",
              enum: ["email", "displayName", "createdAt", "updatedAt", "expiredAt"],
            },
            sortDir: { type: "string", enum: ["asc", "desc"] },
            page: { type: "number", minimum: 1 },
            limit: { type: "number", minimum: 1, maximum: 100 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      try {
        return reply.send(await adminService.listUsers(request.query));
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );

  app.get<{ Params: { userId: string } }>(
    "/admin/users/:userId",
    async (request, reply) => {
      try {
        return reply.send(await adminService.getUserDetail(request.params.userId));
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );

  app.patch<{ Params: { userId: string }; Body: { role: "admin" | "user" } }>(
    "/admin/users/:userId/role",
    {
      schema: {
        body: {
          type: "object",
          required: ["role"],
          properties: {
            role: { type: "string", enum: ["admin", "user"] },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      try {
        return reply.send(
          await adminService.updateUserRole(
            request.params.userId,
            request.body.role,
            request.user.uid,
          ),
        );
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );

  app.patch<{
    Params: { userId: string };
    Body: { status: "active" | "suspended" | "deleted" };
  }>(
    "/admin/users/:userId/status",
    {
      schema: {
        body: {
          type: "object",
          required: ["status"],
          properties: {
            status: {
              type: "string",
              enum: ["active", "suspended", "deleted"],
            },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      try {
        return reply.send(
          await adminService.updateUserStatus(
            request.params.userId,
            request.body.status,
            request.user.uid,
          ),
        );
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );

  app.get("/admin/plans", async (_request, reply) => {
    try {
      return reply.send({ items: await adminService.listPlans() });
    } catch (err) {
      return handleError(err, reply);
    }
  });

  app.post("/admin/plans/seed-defaults", async (request, reply) => {
    try {
      return reply.send(await adminService.seedDefaultPlans(request.user.uid));
    } catch (err) {
      return handleError(err, reply);
    }
  });

  app.put<{
    Params: { planId: string };
    Body: {
      name?: string;
      description?: string;
      status?: "active" | "inactive";
      features?: Record<string, unknown>;
      limits?: Record<string, unknown>;
      sortOrder?: number;
    };
  }>(
    "/admin/plans/:planId",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            name: { type: "string" },
            description: { type: "string" },
            status: { type: "string", enum: ["active", "inactive"] },
            features: { type: "object", additionalProperties: true },
            limits: { type: "object", additionalProperties: true },
            sortOrder: { type: "number" },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      try {
        return reply.send(
          await adminService.upsertPlan(
            request.params.planId,
            request.body,
            request.user.uid,
          ),
        );
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );

  app.get("/admin/features", async (_request, reply) => {
    try {
      return reply.send(await adminService.listFeatures());
    } catch (err) {
      return handleError(err, reply);
    }
  });

  app.patch<{
    Params: { userId: string };
    Body: {
      plan?: string;
      status?: "trial" | "active" | "expired" | "cancelled";
      startedAt?: string | null;
      expiresAt?: string | null;
      source?: string;
      note?: string;
    };
  }>(
    "/admin/users/:userId/subscription",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            plan: { type: "string" },
            status: {
              type: "string",
              enum: ["trial", "active", "expired", "cancelled"],
            },
            startedAt: { anyOf: [{ type: "string" }, { type: "null" }] },
            expiresAt: { anyOf: [{ type: "string" }, { type: "null" }] },
            source: { type: "string" },
            note: { type: "string" },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      try {
        return reply.send(
          await adminService.updateSubscription(
            request.params.userId,
            request.body,
            request.user.uid,
          ),
        );
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );

  app.get<{ Querystring: { limit?: number } }>(
    "/admin/activity-logs",
    {
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
        return reply.send({
          items: await adminService.listActivityLogs(request.query.limit),
        });
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );
}
