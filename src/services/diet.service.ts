import { GoogleGenAI } from "@google/genai";
import { Timestamp, FieldValue } from "firebase-admin/firestore";
import { getDb } from "../lib/firebase.js";
import { env } from "../config/env.js";

// ─── Firestore Collection ─────────────────────────────────────────────────────
const COL_USERS = "users";
const COL_DIET_PLANS = "dietPlans";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MealItem {
  type: "Breakfast" | "Lunch" | "Dinner";
  menuName: string;
  contents: string;
  ingredients: string[];
  instructions?: string;
  prepTime: string;
  calories: number;
  sugarGrams: number;
  fiberGrams: number;
}

export interface DietPlan {
  target: string;
  icon: string;
  score: number;
  summary: string;
  meals: MealItem[];
}

export interface DayPlan {
  day: string;
  meals: MealItem[];
  totalCalories: number;
  totalSugar: number;
}

export interface WeeklyPlan {
  weekName: string;
  days: DayPlan[];
}

// ─── Stored Document Types ────────────────────────────────────────────────────

export interface StoredDailyPlan extends DietPlan {
  id: string;
  type: "daily";
  category: string;
  dateStr: string;   // YYYY-MM-DD (UTC) — used to check for daily duplicates
  createdAt: string; // ISO string
  /** Indices of meals already consumed by the user (persistent). */
  consumedMealIndices: number[];
}

export interface StoredWeeklyPlan extends WeeklyPlan {
  id: string;
  type: "weekly";
  category: string;
  dateStr: string;   // YYYY-MM-DD (UTC) — used to check for daily duplicates
  createdAt: string; // ISO string
  /** Keys in "dayIdx-mealIdx" format for weekly meals already consumed. */
  consumedMealKeys: string[];
}

export type StoredDietPlan = StoredDailyPlan | StoredWeeklyPlan;

export interface ActiveDietPlans {
  daily: StoredDailyPlan | null;
  weekly: StoredWeeklyPlan | null;
  /** true → user is allowed to generate a new daily plan today */
  canGenerateDaily: boolean;
  /** true → user is allowed to generate a new weekly plan (7 days since last one) */
  canGenerateWeekly: boolean;
  /** ISO string — when the daily lock expires (UTC midnight tomorrow) */
  lockedUntilDaily: string;
  /** ISO string — when the weekly lock expires (createdAt + 7 days) */
  lockedUntilWeekly: string;
}

// ─── Input Types ──────────────────────────────────────────────────────────────

export interface GenerateDailyPlanInput {
  goalText: string;
  userName: string;
  userAge: number;
  userWeight: number;
  userHeight: number;
}

export interface GenerateWeeklyPlanInput {
  goalText: string;
  userName: string;
  userAge: number;
  userWeight: number;
}

export interface SwapMealInput {
  currentMeal: MealItem;
  dietTarget: string;
}

// ─── AI Setup ─────────────────────────────────────────────────────────────────

const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
const DIET_MODEL = "gemini-2.5-flash";

// ─── Date Helpers ─────────────────────────────────────────────────────────────

/** Returns today's date in YYYY-MM-DD (UTC) format. */
function todayUTC(): string {
  return new Date().toISOString().split("T")[0];
}

/** UTC midnight tomorrow — daily plan unlock boundary. */
function midnightTomorrow(): string {
  const d = new Date();
  d.setUTCHours(24, 0, 0, 0);
  return d.toISOString();
}

/** createdAt + 7 days — weekly plan unlock boundary. */
function weeklyUnlockDate(createdAt: string): string {
  const d = new Date(createdAt);
  d.setDate(d.getDate() + 7);
  return d.toISOString();
}

function httpError(message: string, statusCode: number): Error {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = statusCode;
  return err;
}

// ─── Diet Service ─────────────────────────────────────────────────────────────

class DietService {
  // ── AI Helper ───────────────────────────────────────────────────────────────

  private async generateJSON<T>(prompt: string): Promise<T> {
    const response = await ai.models.generateContent({
      model: DIET_MODEL,
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: { responseMimeType: "application/json" },
    });

    const text = response.text ?? "";

    try {
      return JSON.parse(
        text.replace(/```json/g, "").replace(/```/g, "").trim(),
      ) as T;
    } catch {
      throw new Error("Failed to parse AI response. Please try again.");
    }
  }

  // ── Firestore Helpers ────────────────────────────────────────────────────────

  private plansCol(userId: string) {
    return getDb()
      .collection(COL_USERS)
      .doc(userId)
      .collection(COL_DIET_PLANS);
  }

  private docToStored(doc: FirebaseFirestore.QueryDocumentSnapshot) {
    const data = doc.data();
    return {
      ...data,
      id: doc.id,
      createdAt:
        data.createdAt instanceof Timestamp
          ? data.createdAt.toDate().toISOString()
          : (data.createdAt as string),
    };
  }

  /**
   * Check whether the user already has a daily plan for today.
   * Anti-cheat: dateStr == todayUTC().
   */
  private async hasGeneratedDailyToday(userId: string): Promise<boolean> {
    const snap = await this.plansCol(userId)
      .where("type", "==", "daily")
      .where("dateStr", "==", todayUTC())
      .limit(1)
      .get();
    return !snap.empty;
  }

  /**
   * Check whether the user already has a weekly plan within the last 7 days.
   * Anti-cheat: query is based on server Timestamp — cannot be manipulated by the client.
   */
  private async hasGeneratedWeeklyThisWeek(userId: string): Promise<{ exists: boolean; createdAt: string | null }> {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const snap = await this.plansCol(userId)
      .where("type", "==", "weekly")
      .where("createdAt", ">", Timestamp.fromDate(sevenDaysAgo))
      .orderBy("createdAt", "desc")
      .limit(1)
      .get();

    if (snap.empty) return { exists: false, createdAt: null };

    const data = snap.docs[0].data();
    const createdAt = data.createdAt instanceof Timestamp
      ? data.createdAt.toDate().toISOString()
      : (data.createdAt as string);

    return { exists: true, createdAt };
  }

  // ── Generate & Auto-Save Daily Plan ─────────────────────────────────────────

  async generateAndSaveDailyPlan(
    userId: string,
    category: string,
    input: GenerateDailyPlanInput,
  ): Promise<StoredDailyPlan> {
    // ── ANTI-CHEAT: reject if already generated today ───────────────────────
    if (await this.hasGeneratedDailyToday(userId)) {
      throw httpError(
        `Mission Protocol has already been generated today. Available again at ${midnightTomorrow()}.`,
        409,
      );
    }

    const plan = await this.generateDailyPlan(input);
    const now = new Date();
    const docRef = this.plansCol(userId).doc();

    const stored: StoredDailyPlan = {
      ...plan,
      id: docRef.id,
      type: "daily",
      category,
      dateStr: todayUTC(),
      createdAt: now.toISOString(),
      consumedMealIndices: [],
    };

    await docRef.set({
      ...stored,
      createdAt: Timestamp.fromDate(now),
    });

    return stored;
  }

  // ── Generate & Auto-Save Weekly Plan ────────────────────────────────────────

  async generateAndSaveWeeklyPlan(
    userId: string,
    category: string,
    input: GenerateWeeklyPlanInput,
  ): Promise<StoredWeeklyPlan> {
    // ── ANTI-CHEAT: reject if already generated within the last 7 days ──────
    const { exists, createdAt: lastCreatedAt } = await this.hasGeneratedWeeklyThisWeek(userId);
    if (exists && lastCreatedAt) {
      const unlockAt = weeklyUnlockDate(lastCreatedAt);
      throw httpError(
        `Weekly Supply is still active. Available again at ${unlockAt}.`,
        409,
      );
    }

    const plan = await this.generateWeeklyPlan(input);
    const now = new Date();
    const docRef = this.plansCol(userId).doc();

    const stored: StoredWeeklyPlan = {
      ...plan,
      id: docRef.id,
      type: "weekly",
      category,
      dateStr: todayUTC(),
      createdAt: now.toISOString(),
      consumedMealKeys: [],
    };

    await docRef.set({
      ...stored,
      createdAt: Timestamp.fromDate(now),
    });

    return stored;
  }

  // ── Get Active Plans + Generate Flags ────────────────────────────────────────

  async getActivePlans(userId: string): Promise<ActiveDietPlans> {
    const col = this.plansCol(userId);
    const today = todayUTC();

    const [dailySnap, weeklySnap] = await Promise.all([
      col.where("type", "==", "daily").orderBy("createdAt", "desc").limit(1).get(),
      col.where("type", "==", "weekly").orderBy("createdAt", "desc").limit(1).get(),
    ]);

    const daily = dailySnap.empty
      ? null
      : (this.docToStored(dailySnap.docs[0]) as StoredDailyPlan);

    const weekly = weeklySnap.empty
      ? null
      : (this.docToStored(weeklySnap.docs[0]) as StoredWeeklyPlan);

    // Daily lock: cukup cek dateStr == today
    const canGenerateDaily = daily?.dateStr !== today;

    // Weekly lock: cek apakah createdAt + 7 hari masih di masa depan
    let canGenerateWeekly = true;
    let lockedUntilWeeklyStr = midnightTomorrow(); // fallback
    if (weekly) {
      const unlockDate = new Date(weeklyUnlockDate(weekly.createdAt));
      if (unlockDate > new Date()) {
        canGenerateWeekly = false;
        lockedUntilWeeklyStr = unlockDate.toISOString();
      }
    }

    return {
      daily,
      weekly,
      canGenerateDaily,
      canGenerateWeekly,
      lockedUntilDaily: midnightTomorrow(),
      lockedUntilWeekly: lockedUntilWeeklyStr,
    };
  }

  // ── Get Plan History (ordered by date desc) ──────────────────────────────────

  async getPlanHistory(
    userId: string,
    limit = 20,
  ): Promise<StoredDietPlan[]> {
    const snap = await this.plansCol(userId)
      .orderBy("createdAt", "desc")
      .limit(limit)
      .get();

    return snap.docs.map((doc) => {
      const data = doc.data();
      return {
        ...data,
        id: doc.id,
        createdAt:
          data.createdAt instanceof Timestamp
            ? data.createdAt.toDate().toISOString()
            : data.createdAt,
      } as StoredDietPlan;
    });
  }

  // ── Update Meals After Swap (persist to Firestore) ───────────────────────────

  async updateDailyMeals(
    userId: string,
    planId: string,
    meals: MealItem[],
  ): Promise<void> {
    await this.plansCol(userId).doc(planId).update({ meals });
  }

  // ── Mark Meal as Consumed (persist to Firestore) ─────────────────────────────

  /**
   * Mark a single meal as consumed.
   * - Daily plan: appends `mealIndex` to the `consumedMealIndices` array.
   * - Weekly plan: appends key `"dayIndex-mealIndex"` to the `consumedMealKeys` array.
   * Uses `FieldValue.arrayUnion` to prevent duplicates and ensure atomic writes.
   */
  async markMealConsumed(
    userId: string,
    planId: string,
    planType: "daily" | "weekly",
    mealIndex: number,
    dayIndex?: number,
  ): Promise<void> {
    const docRef = this.plansCol(userId).doc(planId);

    if (planType === "daily") {
      await docRef.update({
        consumedMealIndices: FieldValue.arrayUnion(mealIndex),
      });
    } else {
      if (dayIndex === undefined) {
        throw new Error("dayIndex is required for weekly plans.");
      }
      const key = `${dayIndex}-${mealIndex}`;
      await docRef.update({
        consumedMealKeys: FieldValue.arrayUnion(key),
      });
    }
  }

  // ── AI Generation (internal, no Firestore) ───────────────────────────────────

  async generateDailyPlan(input: GenerateDailyPlanInput): Promise<DietPlan> {
    const prompt = `
      Act as an elite tactical nutritionist AI. Generate a strict 1-day diet plan.
      
      USER INTEL:
      - Agent: ${input.userName}, ${input.userAge}yo, ${input.userWeight}kg, ${input.userHeight}cm.
      - MISSION GOAL: "${input.goalText}"
      
      1. Analyze the goal to determine an icon (emoji) and a health score (0-100).
      2. Create 3 distinct meals: Breakfast, Lunch, Dinner tailored to the user stats.
      3. CRITICAL: Provide 'ingredients' as a simple ARRAY of strings for a shopping list.
      4. Provide brief 'instructions' (max 2 sentences).
      
      Return strictly JSON format:
      {
        "target": "${input.goalText}",
        "icon": "emoji",
        "score": number,
        "summary": "Short motivating summary (max 15 words)",
        "meals": [
          { 
              "type": "Breakfast", 
              "menuName": "...", 
              "contents": "Short description", 
              "ingredients": ["Egg", "Spinach"],
              "instructions": "Boil eggs. Mix with spinach.",
              "prepTime": "10m", 
              "calories": 0, 
              "sugarGrams": 0,
              "fiberGrams": 0
          },
          { "type": "Lunch", "menuName": "...", "contents": "...", "ingredients": [], "instructions": "...", "prepTime": "...", "calories": 0, "sugarGrams": 0, "fiberGrams": 0 },
          { "type": "Dinner", "menuName": "...", "contents": "...", "ingredients": [], "instructions": "...", "prepTime": "...", "calories": 0, "sugarGrams": 0, "fiberGrams": 0 }
        ]
      }
    `;

    return this.generateJSON<DietPlan>(prompt);
  }

  async generateWeeklyPlan(input: GenerateWeeklyPlanInput): Promise<WeeklyPlan> {
    const prompt = `
      Generate a tactical 7-day meal prep plan (Monday to Sunday).
      USER: ${input.userName}, ${input.userAge}yo, ${input.userWeight}kg.
      GOAL: "${input.goalText}"
      
      Focus on efficiency. Return strictly JSON:
      {
        "weekName": "Operation Name",
        "days": [
          {
            "day": "Monday",
            "totalCalories": 0,
            "totalSugar": 0,
            "meals": [
               { 
                  "type": "Breakfast", 
                  "menuName": "...", 
                  "contents": "...", 
                  "ingredients": ["Item 1", "Item 2"], 
                  "instructions": "...",
                  "prepTime": "...", 
                  "calories": 0, 
                  "sugarGrams": 0,
                  "fiberGrams": 0 
               },
               { "type": "Lunch", "menuName": "...", "contents": "...", "ingredients": [], "instructions": "...", "prepTime": "...", "calories": 0, "sugarGrams": 0, "fiberGrams": 0 },
               { "type": "Dinner", "menuName": "...", "contents": "...", "ingredients": [], "instructions": "...", "prepTime": "...", "calories": 0, "sugarGrams": 0, "fiberGrams": 0 }
            ]
          },
          { "day": "Tuesday", "totalCalories": 0, "totalSugar": 0, "meals": [] },
          { "day": "Wednesday", "totalCalories": 0, "totalSugar": 0, "meals": [] },
          { "day": "Thursday", "totalCalories": 0, "totalSugar": 0, "meals": [] },
          { "day": "Friday", "totalCalories": 0, "totalSugar": 0, "meals": [] },
          { "day": "Saturday", "totalCalories": 0, "totalSugar": 0, "meals": [] },
          { "day": "Sunday", "totalCalories": 0, "totalSugar": 0, "meals": [] }
        ]
      }
    `;

    return this.generateJSON<WeeklyPlan>(prompt);
  }

  async swapMeal(input: SwapMealInput): Promise<MealItem> {
    const prompt = `
      The user wants to SWAP this meal: "${input.currentMeal.menuName}".
      They dislike it or can't make it.
      
      Generate a REPLACEMENT meal that:
      1. Matches the meal type: ${input.currentMeal.type}.
      2. Has similar calories: ~${input.currentMeal.calories}.
      3. Fits the goal: ${input.dietTarget || "Healthy"}.
      4. Is completely different from the original.

      Return strictly JSON for a SINGLE MealItem object:
      { 
          "type": "${input.currentMeal.type}", 
          "menuName": "...", 
          "contents": "...", 
          "ingredients": ["..."],
          "instructions": "...",
          "prepTime": "...", 
          "calories": 0, 
          "sugarGrams": 0,
          "fiberGrams": 0
      }
    `;

    return this.generateJSON<MealItem>(prompt);
  }
}

export const dietService = new DietService();
