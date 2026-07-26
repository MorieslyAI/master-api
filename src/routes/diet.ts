import type { FastifyInstance, FastifyReply } from "fastify";
import { dietService, type MealItem } from "../services/diet.service.js";
import { authenticate } from "../middleware/authenticate.js";

// ─── Route Error Handler ──────────────────────────────────────────────────────

function handleError(err: unknown, reply: FastifyReply): void {
  const e = err as Error & { statusCode?: number };
  reply
    .code(e.statusCode ?? 500)
    .send({ error: e.message ?? "An internal server error occurred." });
}

// ─── Request Body Types ───────────────────────────────────────────────────────

interface GenerateDailyBody {
  category: string;
  manualGoal?: string;
  inputMode: "auto" | "manual";
  userProfile: {
    name: string;
    age: number;
    weight: number;
    height: number;
  };
}

interface GenerateWeeklyBody {
  category: string;
  manualGoal?: string;
  inputMode: "auto" | "manual";
  userProfile: {
    name: string;
    age: number;
    weight: number;
  };
}

interface SwapMealBody {
  planId: string;
  mealIndex: number;
  currentMeal: MealItem;
  dietTarget: string;
}

interface MarkConsumedBody {
  planId: string;
  planType: "daily" | "weekly";
  mealIndex: number;
  dayIndex?: number;
}

// ─── Diet Categories ──────────────────────────────────────────────────────────

const DIET_CATEGORIES: Record<string, { title: string; desc: string }> = {
  fat_loss: {
    title: "Operation Shred",
    desc: "Aggressive fat loss via caloric deficit. High protein to spare muscle.",
  },
  muscle: {
    title: "Iron Clad Bulk",
    desc: "Hypertrophy focus. Caloric surplus with strict macro ratios.",
  },
  maintenance: {
    title: "Vitality Ops",
    desc: "Performance maintenance. Balanced macros for sustained energy.",
  },
  keto: {
    title: "Ketogenic Stealth",
    desc: "Metabolic shift. High fat, ultra-low carb to eliminate glucose spikes.",
  },
};

// ─── Diet Routes ──────────────────────────────────────────────────────────────

export async function dietRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authenticate);

  // ── POST /diet/generate ───────────────────────────────────────────────────
  // Generate and auto-save today's daily meal plan (Mission Protocol).
  app.post<{ Body: GenerateDailyBody }>(
    "/diet/generate",
    {
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      schema: {
        body: {
          type: "object",
          required: ["category", "inputMode", "userProfile"],
          properties: {
            category: { type: "string" },
            manualGoal: { type: "string" },
            inputMode: { type: "string", enum: ["auto", "manual"] },
            userProfile: {
              type: "object",
              required: ["name", "age", "weight", "height"],
              properties: {
                name: { type: "string", minLength: 1 },
                age: { type: "number", minimum: 1 },
                weight: { type: "number", minimum: 1 },
                height: { type: "number", minimum: 1 },
              },
            },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      try {
        const { category, manualGoal, inputMode, userProfile } = request.body;

        const cat = DIET_CATEGORIES[category];
        const goalText =
          inputMode === "auto" && cat
            ? `${cat.title} (${cat.desc}). Strict adherence.`
            : (manualGoal ?? "Healthy balanced diet");

        const plan = await dietService.generateAndSaveDailyPlan(
          request.user.uid,
          category,
          {
            goalText,
            userName: userProfile.name,
            userAge: userProfile.age,
            userWeight: userProfile.weight,
            userHeight: userProfile.height,
          },
        );

        return reply.send(plan);
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );

  // ── POST /diet/weekly ─────────────────────────────────────────────────────
  // Generate and auto-save a 7-day meal plan (Weekly Supply).
  app.post<{ Body: GenerateWeeklyBody }>(
    "/diet/weekly",
    {
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        body: {
          type: "object",
          required: ["category", "inputMode", "userProfile"],
          properties: {
            category: { type: "string" },
            manualGoal: { type: "string" },
            inputMode: { type: "string", enum: ["auto", "manual"] },
            userProfile: {
              type: "object",
              required: ["name", "age", "weight"],
              properties: {
                name: { type: "string", minLength: 1 },
                age: { type: "number", minimum: 1 },
                weight: { type: "number", minimum: 1 },
              },
            },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      try {
        const { category, manualGoal, inputMode, userProfile } = request.body;

        const cat = DIET_CATEGORIES[category];
        const goalText =
          inputMode === "auto" && cat
            ? `${cat.title} (${cat.desc}). Focus on meal prep efficiency.`
            : (manualGoal ?? "Healthy balanced diet");

        const plan = await dietService.generateAndSaveWeeklyPlan(
          request.user.uid,
          category,
          {
            goalText,
            userName: userProfile.name,
            userAge: userProfile.age,
            userWeight: userProfile.weight,
          },
        );

        return reply.send(plan);
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );

  // ── POST /diet/swap ───────────────────────────────────────────────────────
  // Replace a single meal and update the existing Firestore document.
  app.post<{ Body: SwapMealBody }>(
    "/diet/swap",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        body: {
          type: "object",
          required: ["planId", "mealIndex", "currentMeal", "dietTarget"],
          properties: {
            planId: { type: "string", minLength: 1 },
            mealIndex: { type: "number", minimum: 0 },
            currentMeal: {
              type: "object",
              required: ["type", "menuName", "calories"],
              properties: {
                type: { type: "string", enum: ["Breakfast", "Lunch", "Dinner"] },
                menuName: { type: "string" },
                contents: { type: "string" },
                ingredients: { type: "array", items: { type: "string" } },
                instructions: { type: "string" },
                prepTime: { type: "string" },
                calories: { type: "number" },
                sugarGrams: { type: "number" },
                fiberGrams: { type: "number" },
              },
            },
            dietTarget: { type: "string" },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      try {
        const { planId, mealIndex, currentMeal, dietTarget } = request.body;

        const newMeal = await dietService.swapMeal({ currentMeal, dietTarget }, request.user.uid);

        // Fetch the latest plan and update meals
        const active = await dietService.getActivePlans(request.user.uid);
        const dailyPlan = active.daily;

        if (dailyPlan && dailyPlan.id === planId) {
          const updatedMeals = [...dailyPlan.meals];
          updatedMeals[mealIndex] = newMeal;
          await dietService.updateDailyMeals(request.user.uid, planId, updatedMeals);
        }

        return reply.send(newMeal);
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );

  // ── GET /diet/active ──────────────────────────────────────────────────────
  // Fetch the user's latest active plans (daily + weekly).
  app.get(
    "/diet/active",
    {
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      try {
        const plans = await dietService.getActivePlans(request.user.uid);
        return reply.send(plans);
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );

  // ── POST /diet/consumed ───────────────────────────────────────────────────
  // Mark a single meal as consumed. Status is persisted in the diet plan
  // document (not in logs), so it survives page refresh.
  app.post<{ Body: MarkConsumedBody }>(
    "/diet/consumed",
    {
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: {
        body: {
          type: "object",
          required: ["planId", "planType", "mealIndex"],
          properties: {
            planId:    { type: "string", minLength: 1 },
            planType:  { type: "string", enum: ["daily", "weekly"] },
            mealIndex: { type: "number", minimum: 0 },
            dayIndex:  { type: "number", minimum: 0 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      try {
        const { planId, planType, mealIndex, dayIndex } = request.body;
        await dietService.markMealConsumed(
          request.user.uid,
          planId,
          planType,
          mealIndex,
          dayIndex,
        );
        return reply.code(200).send({ ok: true });
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );

  // ── GET /diet/history ─────────────────────────────────────────────────────
  // History of all generated plans (max 20, newest first).
  app.get<{ Querystring: { limit?: number } }>(
    "/diet/history",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        querystring: {
          type: "object",
          properties: {
            limit: { type: "number", minimum: 1, maximum: 50 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      try {
        const limit = request.query.limit ?? 20;
        const history = await dietService.getPlanHistory(request.user.uid, limit);
        return reply.send(history);
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );

  // ══════════════════════════════════════════════════════════════════════════
  // ALIAS ROUTES — FE compat (/diet/plans/...)
  // FE memanggil path /diet/plans/*, BE lama menggunakan /diet/*.
  // Alias ini mendelegasikan ke service yang sama tanpa mengubah logika.
  // ══════════════════════════════════════════════════════════════════════════

  // ── POST /diet/plans/daily (alias → /diet/generate) ───────────────────────
  app.post<{ Body: GenerateDailyBody }>(
    "/diet/plans/daily",
    {
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      schema: {
        body: {
          type: "object",
          required: ["category", "inputMode", "userProfile"],
          properties: {
            category:   { type: "string" },
            manualGoal: { type: "string" },
            inputMode:  { type: "string", enum: ["auto", "manual"] },
            userProfile: {
              type: "object",
              required: ["name", "age", "weight"],
              properties: {
                name:   { type: "string", minLength: 1 },
                age:    { type: "number", minimum: 1 },
                weight: { type: "number", minimum: 1 },
                height: { type: "number", minimum: 1 },
              },
            },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      try {
        const { category, manualGoal, inputMode, userProfile } = request.body;
        const cat = DIET_CATEGORIES[category];
        const goalText =
          inputMode === "auto" && cat
            ? `${cat.title} (${cat.desc}). Strict adherence.`
            : (manualGoal ?? "Healthy balanced diet");
        const plan = await dietService.generateAndSaveDailyPlan(
          request.user.uid,
          category,
          {
            goalText,
            userName:   userProfile.name,
            userAge:    userProfile.age,
            userWeight: userProfile.weight,
            userHeight: userProfile.height ?? 170,
          },
        );
        return reply.send(plan);
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );

  // ── POST /diet/plans/weekly (alias → /diet/weekly) ────────────────────────
  app.post<{ Body: GenerateWeeklyBody }>(
    "/diet/plans/weekly",
    {
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        body: {
          type: "object",
          required: ["category", "inputMode", "userProfile"],
          properties: {
            category:   { type: "string" },
            manualGoal: { type: "string" },
            inputMode:  { type: "string", enum: ["auto", "manual"] },
            userProfile: {
              type: "object",
              required: ["name", "age", "weight"],
              properties: {
                name:   { type: "string", minLength: 1 },
                age:    { type: "number", minimum: 1 },
                weight: { type: "number", minimum: 1 },
              },
            },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      try {
        const { category, manualGoal, inputMode, userProfile } = request.body;
        const cat = DIET_CATEGORIES[category];
        const goalText =
          inputMode === "auto" && cat
            ? `${cat.title} (${cat.desc}). Focus on meal prep efficiency.`
            : (manualGoal ?? "Healthy balanced diet");
        const plan = await dietService.generateAndSaveWeeklyPlan(
          request.user.uid,
          category,
          {
            goalText,
            userName:   userProfile.name,
            userAge:    userProfile.age,
            userWeight: userProfile.weight,
          },
        );
        return reply.send(plan);
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );

  // ── GET /diet/plans/active (alias → /diet/active) ─────────────────────────
  app.get(
    "/diet/plans/active",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request, reply) => {
      try {
        const plans = await dietService.getActivePlans(request.user.uid);
        return reply.send(plans);
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );

  // ── POST /diet/plans/daily/:planId/swap (alias → /diet/swap) ─────────────
  // FE mengirim planId di URL param, target di body field "target".
  app.post<{
    Params: { planId: string };
    Body: { mealIndex: number; currentMeal: MealItem; target: string };
  }>(
    "/diet/plans/daily/:planId/swap",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        params: {
          type: "object",
          required: ["planId"],
          properties: { planId: { type: "string" } },
        },
        body: {
          type: "object",
          required: ["mealIndex", "currentMeal", "target"],
          properties: {
            mealIndex:   { type: "number", minimum: 0 },
            currentMeal: { type: "object" },
            target:      { type: "string" },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      try {
        const { mealIndex, currentMeal, target } = request.body;
        const planId = request.params.planId;

        const newMeal = await dietService.swapMeal({ currentMeal, dietTarget: target }, request.user.uid);

        const active = await dietService.getActivePlans(request.user.uid);
        const dailyPlan = active.daily;
        if (dailyPlan && dailyPlan.id === planId) {
          const updatedMeals = [...dailyPlan.meals];
          updatedMeals[mealIndex] = newMeal;
          await dietService.updateDailyMeals(request.user.uid, planId, updatedMeals);
        }

        return reply.send(newMeal);
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );

  // ── POST /diet/plans/:planId/consume (alias → /diet/consumed) ────────────
  // FE mengirim planId di URL param, scope & mealIndex di body.
  app.post<{
    Params: { planId: string };
    Body: { scope: "daily" | "weekly"; mealIndex: number; dayIndex?: number };
  }>(
    "/diet/plans/:planId/consume",
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
          required: ["scope", "mealIndex"],
          properties: {
            scope:     { type: "string", enum: ["daily", "weekly"] },
            mealIndex: { type: "number", minimum: 0 },
            dayIndex:  { type: "number", minimum: 0 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      try {
        const { scope, mealIndex, dayIndex } = request.body;
        const planId = request.params.planId;
        await dietService.markMealConsumed(
          request.user.uid,
          planId,
          scope,          // "daily" | "weekly"  (sama dengan planType)
          mealIndex,
          dayIndex,
        );
        return reply.code(200).send({ success: true });
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );
}
