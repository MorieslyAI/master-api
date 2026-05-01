import { getDb } from "../lib/firebase.js";

// ─── Firestore Collection ─────────────────────────────────────────────────────
const COL_USERS = "users";

// ─── Activity Archetype Factors ───────────────────────────────────────────────
const ARCHETYPE_FACTORS: Record<string, number> = {
  desk: 1.2,
  field: 1.5,
  heavy: 1.9,
  custom: 1.0,
};

// ─── DTOs ─────────────────────────────────────────────────────────────────────

export interface DashboardQueryStats {
  sugarConsumed: number; // grams consumed today
  caloriesConsumed: number; // kcal consumed today
  proteinConsumed: number; // grams consumed today
  drinksCount: number; // number of drink items logged today
  totalItems: number; // total items logged today
}

export interface MacroTargets {
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  fiber: number;
}

export interface HealthMetrics {
  recovery: number; // 0-100 (%)
  hydration: number;
  stress: number;
  glucose: number;
}

export interface DirectiveAction {
  icon: string;
  label: string;
  value: string;
}

export interface DailyDirective {
  title: string;
  actions: DirectiveAction[];
}

export interface MetabolicInsight {
  id: string;
  title: string;
  text: string;
  type: "sugar" | "hydration" | "protein" | "optimal";
  color: string;
}

export interface DashboardMetrics {
  bioAge: number;
  macroTargets: MacroTargets;
  healthMetrics: HealthMetrics;
  dailyDirective: DailyDirective;
  metabolicInsight: MetabolicInsight;
}

// ─── Error Helper ─────────────────────────────────────────────────────────────

function httpError(message: string, statusCode: number): Error {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = statusCode;
  return err;
}

// ─── Internal Profile Shape ───────────────────────────────────────────────────

interface StoredProfile {
  gender: "male" | "female";
  age: number;
  height: number;
  weight: number;
  archetypeId: string;
  dailySteps?: number | null;
  workoutFreq?: number | null;
  workoutIntensity?: string | null;
  medicalConditions: string[];
  goalMode: string;
  sugarLimit: number;
}

// ─── TDEE Calculator ──────────────────────────────────────────────────────────

function computeTDEE(p: StoredProfile): number {
  const genderOffset = p.gender === "male" ? 5 : -161;
  const bmr = 10 * p.weight + 6.25 * p.height - 5 * p.age + genderOffset;

  let activityFactor: number;
  if (p.archetypeId === "custom") {
    let base = 1.15;
    const steps = p.dailySteps || 0;
    base += (steps / 1000) * 0.03;
    const freq = p.workoutFreq || 0;
    let intensityMult = 0.03;
    if (p.workoutIntensity === "mod") intensityMult = 0.06;
    if (p.workoutIntensity === "high") intensityMult = 0.1;
    base += freq * intensityMult;
    activityFactor = Math.min(2.4, Math.max(1.1, base));
  } else {
    activityFactor = ARCHETYPE_FACTORS[p.archetypeId] ?? 1.2;
  }

  return bmr * activityFactor;
}

// ─── Bio Age Calculator ───────────────────────────────────────────────────────

function computeBioAge(p: StoredProfile): number {
  const bmi = p.weight / Math.pow(p.height / 100, 2);
  let adjustment = 0;

  // BMI adjustment
  if (bmi < 18.5)
    adjustment += 2; // underweight
  else if (bmi < 25)
    adjustment -= 1; // healthy — slight benefit
  else if (bmi < 30)
    adjustment += 2; // overweight
  else adjustment += 5; // obese

  // Activity adjustment
  if (p.archetypeId === "desk") adjustment += 1;
  else if (p.archetypeId === "field") adjustment -= 1;
  else if (p.archetypeId === "heavy") adjustment -= 2;
  else if (p.archetypeId === "custom") {
    const freq = p.workoutFreq || 0;
    if (freq >= 5) adjustment -= 2;
    else if (freq >= 3) adjustment -= 1;
    else if (freq < 1) adjustment += 1;
  }

  // Medical penalties
  if (p.medicalConditions.includes("diabetes")) adjustment += 5;
  else if (p.medicalConditions.includes("prediabetes")) adjustment += 3;
  if (p.medicalConditions.includes("hypertension")) adjustment += 3;
  if (p.medicalConditions.includes("cholesterol")) adjustment += 2;
  if (p.medicalConditions.includes("pcos")) adjustment += 2;

  // Health-conscious goal bonus
  if (p.goalMode === "cut") adjustment -= 1;

  const bioAge = Math.round(p.age + adjustment);
  // Clamp: no lower than 5, no higher than age + 25
  return Math.max(5, Math.min(p.age + 25, bioAge));
}

// ─── Macro Targets Calculator ─────────────────────────────────────────────────

function computeMacroTargets(p: StoredProfile): MacroTargets {
  const tdee = computeTDEE(p);

  // Calorie target based on goal mode
  let calorieTarget = tdee;
  if (p.goalMode === "cut") calorieTarget = tdee - 400; // caloric deficit
  if (p.goalMode === "bulk") calorieTarget = tdee + 400; // caloric surplus
  calorieTarget = Math.round(calorieTarget);

  // Protein (g/kg bodyweight based on goal)
  const proteinPerKg =
    p.goalMode === "cut" ? 2.2 : p.goalMode === "bulk" ? 2.0 : 1.6;
  const protein = Math.round(p.weight * proteinPerKg);

  // Carbohydrates (% of calories / 4 kcal per gram)
  const carbPct =
    p.goalMode === "cut" ? 0.3 : p.goalMode === "bulk" ? 0.5 : 0.45;
  const carbs = Math.round((calorieTarget * carbPct) / 4);

  // Fat (% of calories / 9 kcal per gram)
  const fatPct =
    p.goalMode === "cut" ? 0.3 : p.goalMode === "bulk" ? 0.25 : 0.3;
  const fat = Math.round((calorieTarget * fatPct) / 9);

  // Fiber based on gender and age (DRI guidelines)
  let fiber = 25;
  if (p.gender === "male") {
    fiber = p.age < 50 ? 38 : 30;
  } else {
    fiber = p.age < 50 ? 25 : 21;
  }

  return { calories: calorieTarget, protein, carbs, fat, fiber };
}

// ─── Health Metrics Calculator ────────────────────────────────────────────────
// Replaces Math.random() with data-driven scoring.

function computeHealthMetrics(
  p: StoredProfile,
  macros: MacroTargets,
  stats: DashboardQueryStats,
): HealthMetrics {
  // Recovery (10–60%): driven by protein adequacy + sugar control
  let recovery = 25;
  if (stats.proteinConsumed >= macros.protein * 0.5) recovery += 10;
  if (stats.sugarConsumed < p.sugarLimit * 0.5) recovery += 10;
  else if (stats.sugarConsumed > p.sugarLimit) recovery -= 10;
  if (stats.caloriesConsumed > 0) recovery += 5;
  recovery = Math.round(Math.max(10, Math.min(60, recovery)));

  // Hydration (5–40%): driven by number of drinks logged
  const hydration = Math.round(
    Math.max(5, Math.min(40, Math.round((stats.drinksCount / 4) * 35 + 5))),
  );

  // Stress (5–35%): driven by sugar overconsumption + calorie excess
  let stress = 10;
  if (stats.sugarConsumed > p.sugarLimit) stress += 10;
  if (stats.caloriesConsumed > macros.calories * 0.9) stress += 5;
  if (stats.drinksCount >= 3) stress -= 5;
  stress = Math.round(Math.max(5, Math.min(35, stress)));

  // Glucose = remainder so all four segments fill the bar to ~100%
  const glucose = Math.max(5, 100 - recovery - hydration - stress);

  return { recovery, hydration, stress, glucose };
}

// ─── Daily Directive Generator ────────────────────────────────────────────────
// Returns personalised recommendations based on profile + time of day.

function computeDailyDirective(
  p: StoredProfile,
  macros: MacroTargets,
  stats: DashboardQueryStats,
): DailyDirective {
  const hour = new Date().getHours();

  // Action 1 — Hydration
  let hydrateValue = "+500ml";
  if (stats.drinksCount >= 4) hydrateValue = "Maintain";
  else if (stats.drinksCount >= 2) hydrateValue = "+300ml";

  // Action 2 — Performance (goal + calorie awareness)
  let perfLabel = "Focus";
  let perfValue = "Deep Work";
  if (p.goalMode === "cut" && stats.caloriesConsumed < macros.calories * 0.5) {
    perfLabel = "Eat";
    perfValue = `${macros.calories - stats.caloriesConsumed}kcal left`;
  } else if (
    p.goalMode === "bulk" &&
    stats.proteinConsumed < macros.protein * 0.5
  ) {
    perfLabel = "Protein";
    perfValue = `+${macros.protein - Math.round(stats.proteinConsumed)}g`;
  } else if (hour >= 12 && hour < 17) {
    perfLabel = "Energy";
    perfValue = "Peak Hours";
  } else if (hour >= 17 && hour < 21) {
    perfLabel = "Recover";
    perfValue = "Wind Down";
  }

  // Action 3 — Timing
  let timingLabel = "Sleep";
  let timingValue = "By 23:00";
  if (hour >= 5 && hour < 10) {
    timingLabel = "Breakfast";
    timingValue = "Within 1h";
  } else if (hour >= 10 && hour < 13) {
    timingLabel = "Lunch";
    timingValue = "At 12:30";
  } else if (hour >= 13 && hour < 17) {
    timingLabel = "Snack";
    timingValue = "Low GI";
  } else if (hour >= 17 && hour < 20) {
    timingLabel = "Dinner";
    timingValue = "Before 20:00";
  } else if (hour >= 20 && hour < 22) {
    timingLabel = "Fast";
    timingValue = "No snacks";
  } else {
    const sleepTarget =
      p.goalMode === "bulk"
        ? "22:00"
        : p.goalMode === "cut"
          ? "22:30"
          : "23:00";
    timingLabel = "Sleep";
    timingValue = `By ${sleepTarget}`;
  }

  const title =
    p.goalMode === "cut"
      ? "Optimize Fat Loss"
      : p.goalMode === "bulk"
        ? "Build Muscle Mass"
        : hour < 12
          ? "Morning Protocol"
          : "Daily Performance";

  return {
    title,
    actions: [
      { icon: "droplet", label: "Hydrate", value: hydrateValue },
      { icon: "zap", label: perfLabel, value: perfValue },
      { icon: "clock", label: timingLabel, value: timingValue },
    ],
  };
}

// ─── Metabolic Insight Generator ─────────────────────────────────────────────
// Replaces hardcoded ad content with data-driven insight.

function computeMetabolicInsight(
  p: StoredProfile,
  macros: MacroTargets,
  stats: DashboardQueryStats,
): MetabolicInsight {
  const isSugarHigh = stats.sugarConsumed > p.sugarLimit;
  const isHydrationLow = stats.drinksCount < 2;
  const isProteinLow =
    stats.caloriesConsumed > 100 &&
    stats.proteinConsumed < macros.protein * 0.3;

  if (isSugarHigh) {
    return {
      id: "sugar-high",
      title: "Sugar Spike Alert",
      text: `High sugar load detected (${Math.round(stats.sugarConsumed)}g of ${p.sugarLimit}g limit). Try a 15-minute brisk walk to aid glucose clearance.`,
      type: "sugar",
      color: "from-rose-500 to-orange-400",
    };
  }

  if (isHydrationLow) {
    return {
      id: "hydration-low",
      title: "Hydration Deficit",
      text: `Only ${stats.drinksCount} drink${stats.drinksCount === 1 ? "" : "s"} logged today. Aim for at least 4 glasses of water for optimal metabolic function.`,
      type: "hydration",
      color: "from-blue-400 to-cyan-500",
    };
  }

  if (isProteinLow) {
    return {
      id: "protein-low",
      title: "Protein Deficit",
      text: `Protein intake at ${Math.round(stats.proteinConsumed)}g — target is ${macros.protein}g. Add protein-rich food to protect muscle and boost satiety.`,
      type: "protein",
      color: "from-fuchsia-500 to-purple-500",
    };
  }

  return {
    id: "optimal",
    title: stats.caloriesConsumed > 0 ? "Optimal Balance" : "Ready to Track",
    text:
      stats.caloriesConsumed > 0
        ? `Solid metabolic balance today. Sugar at ${Math.round(stats.sugarConsumed)}g, protein at ${Math.round(stats.proteinConsumed)}g. Keep it up!`
        : "Log your first meal or drink to activate your metabolic intelligence engine.",
    type: "optimal",
    color: "from-emerald-400 to-teal-500",
  };
}

// ─── Dashboard Service ────────────────────────────────────────────────────────

export const dashboardService = {
  // ── GET /dashboard/home logic ───────────────────────────────────────────────
  async getHomeData(
    userId: string,
    dateStr: string,
  ): Promise<Record<string, any>> {
    const db = getDb();

    // 1. Ambil Profil User
    const doc = await db.collection(COL_USERS).doc(userId).get();
    if (!doc.exists) throw httpError("User tidak ditemukan.", 404);

    const data = doc.data() as Record<string, any>;
    const p = data["profile"] as StoredProfile | undefined;
    if (!p) throw httpError("Profil belum dikalibrasi.", 422);

    // 2. Ambil Riwayat Harian (Log Makanan/Minuman/Olahraga)
    // Asumsi: collection `logs` sebagai subcollection dari user: users/{userId}/logs
    const logsSnapshot = await db
      .collection(COL_USERS)
      .doc(userId)
      .collection("logs")
      .where("date", "==", dateStr)
      .get();

    let caloriesConsumed = 0;
    let proteinConsumed = 0;
    let carbsConsumed = 0;
    let fatConsumed = 0;
    let sugarConsumed = 0;
    let fiberConsumed = 0;
    let drinksCount = 0;
    let caloriesBurned = 0;
    const historyItems: any[] = [];

    logsSnapshot.forEach((docLog) => {
      const log = docLog.data();
      historyItems.push({ id: docLog.id, ...log });

      if (log.type === "food" || log.type === "drink") {
        caloriesConsumed += Number(log.calories) || 0;
        proteinConsumed += Number(log.protein) || 0;
        carbsConsumed += Number(log.carbs) || 0;
        fatConsumed += Number(log.fat) || 0;
        sugarConsumed += Number(log.sugar) || 0;
        fiberConsumed += Number(log.fiber) || 0;
        if (log.type === "drink") drinksCount += 1;
      } else if (log.type === "workout") {
        caloriesBurned += Number(log.caloriesBurned) || 0;
      }
    });

    const stats: DashboardQueryStats = {
      sugarConsumed,
      caloriesConsumed,
      proteinConsumed,
      drinksCount,
      totalItems: logsSnapshot.size,
    };

    // 3. Kalkulasi Metrics (Health, AI Insights, dll) sama seperti `getMetrics` sebelumnya
    const macroTargets = computeMacroTargets(p);
    const healthMetrics = computeHealthMetrics(p, macroTargets, stats);
    const metabolicInsight = computeMetabolicInsight(p, macroTargets, stats);
    const dailyDirective = computeDailyDirective(p, macroTargets, stats);

    // 4. Bangun Format BFF (Backend-For-Frontend) sesuai kesepakatan struktur
    return {
      insights: {
        highlights: [
          // Hardcoded dummy agent sementara hingga fitur Agent dinamis dibuat
          {
            id: "daily_directive",
            type: "directive",
            data: dailyDirective,
          },
          {
            id: "hypertrophy_bot",
            name: "Hypertrophy Bot",
            role: "Active Protocol",
            type: "agent",
          },
        ],
        projections: {
          trend: "positive",
          text:
            p.goalMode === "cut"
              ? "Target berat badan diproyeksi tercapai"
              : "Fase optimal",
        },
        weakness: "Asupan serat hari ini kurang memenuhi standar minimum.",
        blindspot: "Anda cenderung kekurangan kalori di pagi hari.",
        metabolicInsight: metabolicInsight.text,
      },
      goals: {
        targetWeight: p.weight - 2, // Dummy (Bisa disimpan di profile db)
        currentWeight: p.weight,
        endDate: "2026-05-11",
      },
      healthMetrics: {
        hydration: healthMetrics.hydration,
        stress: healthMetrics.stress,
        recovery: healthMetrics.recovery,
        glucose: healthMetrics.glucose,
        metabolicScore: 100 - healthMetrics.stress, // Simple calculation
      },
      nutrition: {
        summary: {
          caloriesIn: caloriesConsumed,
          caloriesBurned: caloriesBurned,
          netCalories: caloriesConsumed - caloriesBurned,
          targetCalories: macroTargets.calories,
          protein: proteinConsumed,
          proteinTarget: macroTargets.protein,
          carbs: carbsConsumed,
          carbsTarget: macroTargets.carbs,
          fat: fatConsumed,
          fatTarget: macroTargets.fat,
        },
        specific: {
          sugar: sugarConsumed,
          sugarLimit: p.sugarLimit,
          fiber: fiberConsumed,
          fiberTarget: macroTargets.fiber,
        },
      },
    };
  },

  // ── GET /dashboard/history logic ────────────────────────────────────────────
  async saveHistoryItem(userId: string, item: any): Promise<void> {
    const db = getDb();
    if (!item.id) { throw new Error("History item must have an id"); }
    await db
      .collection(COL_USERS)
      .doc(userId)
      .collection("logs")
      .doc(item.id)
      .set(item, { merge: true });
  },

  async getHistoryData(userId: string, dateStr: string): Promise<any[]> {
    const db = getDb();
    const logsSnapshot = await db
      .collection(COL_USERS)
      .doc(userId)
      .collection("logs")
      .where("date", "==", dateStr)
      .get();

    const history: any[] = [];
    logsSnapshot.forEach((docLog) => {
      history.push({ id: docLog.id, ...docLog.data() });
    });

    // Sort in memory to avoid requiring a composite index in Firestore
    history.sort((a, b) => {
      const timeA = a.timestamp ? new Date(a.timestamp).getTime() : 0;
      const timeB = b.timestamp ? new Date(b.timestamp).getTime() : 0;
      return timeA - timeB;
    });

    return history;
  },

  async getMetrics(
    userId: string,
    stats: DashboardQueryStats,
  ): Promise<DashboardMetrics> {
    const doc = await getDb().collection(COL_USERS).doc(userId).get();
    if (!doc.exists) throw httpError("User tidak ditemukan.", 404);

    const data = doc.data() as Record<string, any>;
    const p = data["profile"] as StoredProfile | undefined;

    if (!p) throw httpError("Profil belum dikalibrasi.", 422);

    const macroTargets = computeMacroTargets(p);
    const healthMetrics = computeHealthMetrics(p, macroTargets, stats);
    const dailyDirective = computeDailyDirective(p, macroTargets, stats);
    const metabolicInsight = computeMetabolicInsight(p, macroTargets, stats);
    const bioAge = computeBioAge(p);

    return {
      bioAge,
      macroTargets,
      healthMetrics,
      dailyDirective,
      metabolicInsight,
    };
  },
};
