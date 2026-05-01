import type { FastifyInstance, FastifyReply } from "fastify";
import { trainingService, type GenerateTrainingInput } from "../services/training.service.js";
import { authenticate } from "../middleware/authenticate.js";

// ─── Error Helper ─────────────────────────────────────────────────────────────

function handleError(err: unknown, reply: FastifyReply): void {
  const e = err as Error & { statusCode?: number };
  reply
    .code(e.statusCode ?? 500)
    .send({ error: e.message ?? "An internal server error occurred." });
}

// ─── Body Types ───────────────────────────────────────────────────────────────

interface GenerateBody {
  mode: "burn" | "build";
  inputMode: "auto" | "manual";
  focusArea?: string;
  intensity?: "Low" | "Medium" | "High";
  equipment?: string;
  customParams?: string;
  userProfile: {
    age: number;
    weight: number;
    gender: string;
  };
}

interface MarkCompletedBody {
  planId: string;
  type: "workout" | "meal";
  blockIndex: number;
}

// ─── Training Routes ──────────────────────────────────────────────────────────

export async function trainingRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authenticate);

  // ── POST /training/generate ───────────────────────────────────────────────
  // Generate and save today's training plan (one per day).
  app.post<{ Body: GenerateBody }>(
    "/training/generate",
    {
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      schema: {
        body: {
          type: "object",
          required: ["mode", "inputMode", "userProfile"],
          properties: {
            mode:         { type: "string", enum: ["burn", "build"] },
            inputMode:    { type: "string", enum: ["auto", "manual"] },
            focusArea:    { type: "string" },
            intensity:    { type: "string", enum: ["Low", "Medium", "High"] },
            equipment:    { type: "string" },
            customParams: { type: "string" },
            userProfile: {
              type: "object",
              required: ["age", "weight", "gender"],
              properties: {
                age:    { type: "number", minimum: 1 },
                weight: { type: "number", minimum: 1 },
                gender: { type: "string" },
              },
            },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      try {
        const { mode, inputMode, focusArea, intensity, equipment, customParams, userProfile } =
          request.body;

        const input: GenerateTrainingInput = {
          mode,
          inputMode,
          focusArea,
          intensity,
          equipment,
          customParams,
          userAge: userProfile.age,
          userWeight: userProfile.weight,
          userGender: userProfile.gender,
        };

        const plan = await trainingService.generateAndSavePlan(
          request.user.uid,
          input,
        );

        return reply.send(plan);
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );

  // ── GET /training/active ──────────────────────────────────────────────────
  // Fetch today's active training plan + lock status.
  // Response: { plan, canGenerate, lockedUntil }
  app.get(
    "/training/active",
    {
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      try {
        const result = await trainingService.getActivePlan(request.user.uid);
        return reply.send(result);
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );

  // ── POST /training/completed ──────────────────────────────────────────────
  // Mark a single block (workout / meal) as completed.
  // Status is persisted in Firestore — survives page refresh.
  app.post<{ Body: MarkCompletedBody }>(
    "/training/completed",
    {
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: {
        body: {
          type: "object",
          required: ["planId", "type", "blockIndex"],
          properties: {
            planId:     { type: "string", minLength: 1 },
            type:       { type: "string", enum: ["workout", "meal"] },
            blockIndex: { type: "number", minimum: 0 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      try {
        const { planId, type, blockIndex } = request.body;
        await trainingService.markCompleted(
          request.user.uid,
          planId,
          type,
          blockIndex,
        );
        return reply.code(200).send({ ok: true });
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );

  // ══════════════════════════════════════════════════════════════════════════
  // ALIAS ROUTES — FE compat (/training/plans/...)
  // FE memanggil path /training/plans/*, BE lama menggunakan /training/*.
  // ══════════════════════════════════════════════════════════════════════════

  // ── POST /training/plans/generate (alias → /training/generate) ───────────
  app.post<{ Body: GenerateBody }>(
    "/training/plans/generate",
    {
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      schema: {
        body: {
          type: "object",
          required: ["mode", "inputMode", "userProfile"],
          properties: {
            mode:         { type: "string" },
            inputMode:    { type: "string", enum: ["auto", "manual"] },
            focusArea:    { type: "string" },
            intensity:    { type: "string" },
            equipment:    { type: "string" },
            customParams: { type: "string" },
            userProfile: {
              type: "object",
              required: ["age", "weight", "gender"],
              properties: {
                age:    { type: "number", minimum: 1 },
                weight: { type: "number", minimum: 1 },
                gender: { type: "string" },
              },
            },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      try {
        const { mode, inputMode, focusArea, intensity, equipment, customParams, userProfile } =
          request.body;
        const input: GenerateTrainingInput = {
          mode,
          inputMode,
          focusArea,
          intensity,
          equipment,
          customParams,
          userAge:    userProfile.age,
          userWeight: userProfile.weight,
          userGender: userProfile.gender,
        };
        const plan = await trainingService.generateAndSavePlan(request.user.uid, input);
        return reply.send(plan);
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );

  // ── GET /training/plans/active (alias → /training/active) ────────────────
  app.get(
    "/training/plans/active",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request, reply) => {
      try {
        const result = await trainingService.getActivePlan(request.user.uid);
        return reply.send(result);
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );

  // ── POST /training/plans/:planId/complete (alias → /training/completed) ───
  // FE mengirim planId di URL param, kind & index di body.
  // BE lama memakai: type (bukan kind), blockIndex (bukan index).
  app.post<{
    Params: { planId: string };
    Body: { kind: "workout" | "meal"; index: number };
  }>(
    "/training/plans/:planId/complete",
    {
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: {
        params: {
          type: "object",
          required: ["planId"],
          properties: { planId: { type: "string" } },
        },
        body: {
          type: "object",
          required: ["kind", "index"],
          properties: {
            kind:  { type: "string", enum: ["workout", "meal"] },
            index: { type: "number", minimum: 0 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      try {
        const { kind, index } = request.body;
        const planId = request.params.planId;
        await trainingService.markCompleted(
          request.user.uid,
          planId,
          kind,   // "workout" | "meal" — sama dengan type
          index,  // sama dengan blockIndex
        );
        return reply.code(200).send({ success: true });
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );
}
