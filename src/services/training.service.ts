import { Timestamp, FieldValue } from "firebase-admin/firestore";
import { getDb } from "../lib/firebase.js";
import {
  generateContentTracked,
  type NormalizedGeminiUsage,
} from "../lib/gemini.js";

// ─── Firestore Collection ─────────────────────────────────────────────────────
const COL_USERS = "users";
const COL_TRAINING_PLANS = "trainingPlans";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TimeBlock {
  phase: "Morning" | "Afternoon" | "Evening" | "Night";
  timeLabel: string;
  actionName: string;
  actionDetail: string;
  fuelName: string;
  fuelDetail: string;
  /** Negative = calories burned (workout). Positive = food consumed. */
  sugarImpact: number;
}

export interface OperationPlan {
  codename: string;
  totalCaloriesBurn: number;
  schedule: TimeBlock[];
}

export interface StoredTrainingPlan extends OperationPlan {
  id: string;
  dateStr: string;   // YYYY-MM-DD — used for daily upsert key
  createdAt: string; // ISO string
  mode: "burn" | "build";
  /** Indices of schedule[] (workout blocks) that have been completed. */
  completedWorkoutIndices: number[];
  /** Indices of schedule[] (fuel blocks) that have been consumed. */
  completedMealIndices: number[];
}

export interface GenerateTrainingInput {
  mode: "burn" | "build";
  inputMode: "auto" | "manual";
  // auto mode
  focusArea?: string;
  intensity?: "Low" | "Medium" | "High";
  equipment?: string;
  // manual mode
  customParams?: string;
  // user profile
  userAge: number;
  userWeight: number;
  userGender: string;
}

// ─── AI Setup ─────────────────────────────────────────────────────────────────

const TRAINING_MODEL = "gemini-2.5-flash";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function todayUTC(): string {
  return new Date().toISOString().split("T")[0];
}

/** UTC midnight tomorrow — training plan unlock boundary. */
function midnightTomorrow(): string {
  const d = new Date();
  d.setUTCHours(24, 0, 0, 0);
  return d.toISOString();
}

function httpError(message: string, statusCode: number): Error {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = statusCode;
  return err;
}

export interface ActiveTrainingResult {
  plan: StoredTrainingPlan | null;
  /** true → user is allowed to generate a new training plan today */
  canGenerate: boolean;
  /** ISO string — when the lock expires (UTC midnight tomorrow) */
  lockedUntil: string;
}

// ─── Training Service ─────────────────────────────────────────────────────────

class TrainingService {
  private plansCol(userId: string) {
    return getDb()
      .collection(COL_USERS)
      .doc(userId)
      .collection(COL_TRAINING_PLANS);
  }

  private docToStored(
    doc: FirebaseFirestore.DocumentSnapshot,
  ): StoredTrainingPlan {
    const data = doc.data()!;
    return {
      ...data,
      id: doc.id,
      createdAt:
        data.createdAt instanceof Timestamp
          ? data.createdAt.toDate().toISOString()
          : (data.createdAt as string),
    } as StoredTrainingPlan;
  }

  // ── AI Generation ────────────────────────────────────────────────────────────

  private async generatePlan(
    input: GenerateTrainingInput,
    userId: string,
  ): Promise<{ data: OperationPlan; usage: NormalizedGeminiUsage | undefined }> {
    const constraints =
      input.inputMode === "manual"
        ? input.customParams ?? "None"
        : `Focus Area: ${input.focusArea ?? "Full Body"}. Intensity: ${input.intensity ?? "Medium"}. Equipment: ${input.equipment ?? "Bodyweight"}.`;

    const prompt = `
      Act as a Tactical Performance Coach.
      User Profile: ${input.userAge}yo, ${input.userWeight}kg, ${input.userGender}.
      Goal: ${input.mode === "burn" ? "Fat Loss" : "Muscle Build"}.
      Constraints & Preferences: "${constraints}"

      Generate a Full Day Operation Schedule (Morning, Afternoon, Evening, Night).

      IMPORTANT RULES:
      1. Scale workout difficulty based on User Age and selected Intensity.
      2. Respect the Focus Area. If 'Upper', focus on arms/chest/back. If 'Core', focus on abs. If 'Custom', interpret user's specific text.
      3. Use the Available Equipment strictly.

      Provide:
      1. Time Label: Use standard 12-hour format (e.g. "07:00 AM"). NO military time.
      2. Action Name: Short 1-2 words (e.g. "Morning Run", "Heavy Squats"). Use verbs.
      3. Action Detail: Specific Reps/Sets tailored to the intensity.
      4. Fuel Name: Meal title (e.g. Grilled Chicken Salad). Be descriptive.
      5. Fuel Detail: Ingredients and portion.
      6. Sugar Impact: number (negative = burn calories from workout).

      Strict JSON Format:
      {
        "codename": "Mission Name (e.g. Operation Iron Core)",
        "totalCaloriesBurn": number,
        "schedule": [
          {
            "phase": "Morning",
            "timeLabel": "07:00 AM",
            "actionName": "string",
            "actionDetail": "string",
            "fuelName": "string",
            "fuelDetail": "string",
            "sugarImpact": -20
          }
        ]
      }
    `;

    const { response, usage } = await generateContentTracked(
      {
        model: TRAINING_MODEL,
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        config: { responseMimeType: "application/json" },
      },
      { feature: "training.plan", userId },
    );

    const text = response.text ?? "";
    try {
      const data = JSON.parse(
        text.replace(/```json/g, "").replace(/```/g, "").trim(),
      ) as OperationPlan;
      return { data, usage };
    } catch {
      throw new Error("Failed to parse AI response. Please try again.");
    }
  }

  // ── Generate & Save (upsert per hari) ────────────────────────────────────────

  /**
   * Generate a new training plan and save it to Firestore.
   * Only 1 plan per day — throws 409 if one already exists for today.
   */
  async generateAndSavePlan(
    userId: string,
    input: GenerateTrainingInput,
  ): Promise<{ plan: StoredTrainingPlan; usage: NormalizedGeminiUsage | undefined }> {
    const dateStr = todayUTC();
    const docRef = this.plansCol(userId).doc(dateStr);

    // Anti-cheat: reject if already generated today
    const existing = await docRef.get();
    if (existing.exists) {
      throw httpError(
        `Mission Protocol has already been generated today. Available again at UTC midnight — ${midnightTomorrow()}.`,
        409,
      );
    }

    const { data: plan, usage } = await this.generatePlan(input, userId);
    const now = new Date();

    const stored: StoredTrainingPlan = {
      ...plan,
      id: dateStr,
      dateStr,
      createdAt: now.toISOString(),
      mode: input.mode,
      completedWorkoutIndices: [],
      completedMealIndices: [],
    };

    await docRef.set({
      ...stored,
      createdAt: Timestamp.fromDate(now),
    });

    return { plan: stored, usage };
  }

  // ── Get Active Plan (today) ──────────────────────────────────────────────────

  async getActivePlan(userId: string): Promise<ActiveTrainingResult> {
    const dateStr = todayUTC();
    const docRef = this.plansCol(userId).doc(dateStr);
    const snap = await docRef.get();

    const plan = snap.exists ? this.docToStored(snap) : null;
    const canGenerate = !snap.exists;

    return {
      plan,
      canGenerate,
      lockedUntil: midnightTomorrow(),
    };
  }

  // ── Mark Block as Completed ──────────────────────────────────────────────────

  async markCompleted(
    userId: string,
    planId: string,
    type: "workout" | "meal",
    blockIndex: number,
  ): Promise<void> {
    const docRef = this.plansCol(userId).doc(planId);
    const snap = await docRef.get();
    if (!snap.exists) {
      throw httpError("Training plan not found.", 404);
    }

    const field =
      type === "workout" ? "completedWorkoutIndices" : "completedMealIndices";

    await docRef.update({
      [field]: FieldValue.arrayUnion(blockIndex),
    });
  }
}

export const trainingService = new TrainingService();
