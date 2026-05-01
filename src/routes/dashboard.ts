import type { FastifyInstance, FastifyReply } from "fastify";
import {
  dashboardService,
  type DashboardQueryStats,
  type TimeRange,
  type UserStatusResponse,
} from "../services/dashboard.service.js";
import { authenticate } from "../middleware/authenticate.js";

// ─── Route Error Handler ──────────────────────────────────────────────────────

function handleError(err: unknown, reply: FastifyReply): void {
  const e = err as Error & { statusCode?: number };
  reply
    .code(e.statusCode ?? 500)
    .send({ error: e.message ?? "Terjadi kesalahan internal." });
}

// ─── Dashboard Routes ─────────────────────────────────────────────────────────

export async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  // ── GET /dashboard/home ───────────────────────────────────────────────────
  // Mengembalikan data komprehensif untuk halaman Home/Dashboard aplikasi.
  // Termasuk AI Insights, Goals, Health Metrics, dan Nutrition Summary hari ini.
  app.get<{ Querystring: { date?: string } }>(
    "/dashboard/home",
    {
      preHandler: authenticate,
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: {
        querystring: {
          type: "object",
          properties: {
            date: {
              type: "string",
              pattern: "^\\d{4}-\\d{2}-\\d{2}$",
              description: "Format YYYY-MM-DD",
            },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      try {
        const targetDate =
          request.query.date || new Date().toISOString().split("T")[0];
        const homeData = await dashboardService.getHomeData(
          request.user.uid,
          targetDate,
        );
        return reply.send(homeData);
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );

  // ── GET /dashboard/history ────────────────────────────────────────────────
  // Mengembalikan log timeline makanan/olahraga pada hari tertentu
  app.get<{ Querystring: { date: string } }>(
    "/dashboard/history",
    {
      preHandler: authenticate,
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: {
        querystring: {
          type: "object",
          required: ["date"],
          properties: {
            date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      try {
        const historyData = await dashboardService.getHistoryData(
          request.user.uid,
          request.query.date,
        );
        return reply.send(historyData);
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );

  // --- POST /dashboard/history ----------------------------------------------------------
  // Menyimpan history log baru (saat consume/reject hasil scan)
  app.post<any>(
    "/dashboard/history",
    {
      preHandler: [authenticate],
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } }
    },
    async (request, reply) => {
      try {
        const item = request.body as any;
        if (!item.date && item.timestamp) {
          item.date = new Date(item.timestamp).toISOString().split('T')[0];
        } else if (!item.date) {
          item.date = new Date().toISOString().split('T')[0];
        }
        await dashboardService.saveHistoryItem(request.user.uid, item);
        return reply.send({ success: true, id: item.id });
      } catch (err) {
        return handleError(err, reply);
      }
    }
  );

  // ── GET /dashboard/metrics (Legacy) ────────────────────────────────────────

  // Mengembalikan metrik dashboard yang dipersonalisasi berdasarkan profil user
  // + statistik konsumsi hari ini (opsional, dari query params).
  //
  // Query params (semua opsional, default ke 0):
  //   sugarConsumed    — gula yang sudah dikonsumsi hari ini (gram)
  //   caloriesConsumed — kalori yang sudah dikonsumsi hari ini (kcal)
  //   proteinConsumed  — protein yang sudah dikonsumsi hari ini (gram)
  //   drinksCount      — jumlah minuman yang dicatat hari ini
  //   totalItems       — total item yang dicatat hari ini
  app.get<{ Querystring: Partial<DashboardQueryStats> }>(
    "/dashboard/metrics",
    {
      preHandler: authenticate,
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: {
        querystring: {
          type: "object",
          properties: {
            sugarConsumed: { type: "number", minimum: 0 },
            caloriesConsumed: { type: "number", minimum: 0 },
            proteinConsumed: { type: "number", minimum: 0 },
            drinksCount: { type: "number", minimum: 0 },
            totalItems: { type: "number", minimum: 0 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      try {
        const stats: DashboardQueryStats = {
          sugarConsumed: request.query.sugarConsumed ?? 0,
          caloriesConsumed: request.query.caloriesConsumed ?? 0,
          proteinConsumed: request.query.proteinConsumed ?? 0,
          drinksCount: request.query.drinksCount ?? 0,
          totalItems: request.query.totalItems ?? 0,
        };

        const metrics = await dashboardService.getMetrics(
          request.user.uid,
          stats,
        );
        return reply.send(metrics);
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );

  // ── GET /dashboard/range-metrics ──────────────────────────────────────────
  // Mengembalikan metabolicTrend dan energyTrend untuk range waktu tertentu.
  // Query param: range (30S | 1M | 15M | 1H | 24H | 7D | 30D)
  app.get<{ Querystring: { range: TimeRange } }>(
    "/dashboard/range-metrics",
    {
      preHandler: authenticate,
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: {
        querystring: {
          type: "object",
          required: ["range"],
          properties: {
            range: {
              type: "string",
              enum: ["30S", "1M", "15M", "1H", "24H", "7D", "30D"],
            },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      try {
        const result = await dashboardService.getRangeMetrics(
          request.user.uid,
          request.query.range,
        );
        return reply.send(result);
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );

  // ── GET /dashboard/status ─────────────────────────────────────────────────
  // Mengembalikan data lengkap untuk halaman Agent Status.
  // Includes: profil, XP, performance score, diet adherence, alerts, trajectory.
  app.get<{ Querystring: { date?: string } }>(
    "/dashboard/status",
    {
      preHandler: authenticate,
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: {
        querystring: {
          type: "object",
          properties: {
            date: {
              type: "string",
              pattern: "^\\d{4}-\\d{2}-\\d{2}$",
              description: "Format YYYY-MM-DD",
            },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      try {
        const targetDate =
          request.query.date || new Date().toISOString().split("T")[0];
        const statusData = await dashboardService.getStatusData(
          request.user.uid,
          targetDate,
        );
        return reply.send(statusData);
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );
}
