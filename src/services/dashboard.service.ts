import { getDb } from "../lib/firebase.js";

// ─── Time Range Helper ────────────────────────────────────────────────────────

export type TimeRange = "30S" | "1M" | "15M" | "1H" | "24H" | "7D" | "30D";

function timeRangeToMs(range: TimeRange): number {
  const map: Record<TimeRange, number> = {
    "30S": 30 * 1000,
    "1M": 60 * 1000,
    "15M": 15 * 60 * 1000,
    "1H": 60 * 60 * 1000,
    "24H": 24 * 60 * 60 * 1000,
    "7D": 7 * 24 * 60 * 60 * 1000,
    "30D": 30 * 24 * 60 * 60 * 1000,
  };
  return map[range];
}

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
  totalGI: number; // total Glycemic Index from all items
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

export interface UserStatusAlert {
  type: "danger" | "warning" | "info";
  title: string;
  message: string;
}

export interface UserStatusResponse {
  // Profil & XP
  name: string;
  rankTitle: string;
  level: number;
  currentXp: number;
  nextLevelXp: number;
  streak: number;
  weight: number | null;
  // Performa
  performanceScore: number;
  dietAdherence: number;
  // Alerts
  activeAlerts: UserStatusAlert[];
  // Mission trajectory
  targetCalories: number;
  caloriesConsumedToday: number;
  nextEvaluation: string;
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

function computeMetabolicScore(
  p: StoredProfile | undefined,
  macros: MacroTargets,
  stats: DashboardQueryStats,
): number {
  if (stats.totalItems <= 0) return 0;

  if (!p) {
    return Math.round(
      Math.min(100, Math.max(0, 100 - stats.sugarConsumed * 2)),
    );
  }

  const healthMetrics = computeHealthMetrics(p, macros, stats);

  // Hitung base glucose control dari total sugar vs limit
  let glucoseControl =
    100 -
    Math.min(100, (stats.sugarConsumed / Math.max(1, p.sugarLimit)) * 100);

  // IMPLEMENTASI LAMA: Hitung rata-rata GI & Terapkan penalti jika GI > 55
  const avgGI = stats.totalItems > 0 ? stats.totalGI / stats.totalItems : 0;
  if (avgGI > 55) {
    const giPenalty = (avgGI - 55) * 0.5;
    glucoseControl = Math.max(0, glucoseControl - giPenalty);
  }

  const calorieControl =
    100 -
    Math.min(
      100,
      (stats.caloriesConsumed / Math.max(1, macros.calories)) * 100,
    );
  const proteinAdequacy = Math.min(
    100,
    (stats.proteinConsumed / Math.max(1, macros.protein)) * 100,
  );
  const hydrationAdequacy = Math.min(100, (stats.drinksCount / 4) * 100);

  const score =
    glucoseControl * 0.35 +
    proteinAdequacy * 0.25 +
    hydrationAdequacy * 0.2 +
    calorieControl * 0.1 +
    (100 - healthMetrics.stress) * 0.1;

  return Math.round(Math.min(100, Math.max(0, score)));
}

// ─── Daily Directive Generator ────────────────────────────────────────────────

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
    let nutritionItems = 0;
    let totalGI = 0;
    const historyItems: any[] = [];

    logsSnapshot.forEach((docLog) => {
      const log = docLog.data();
      historyItems.push({ id: docLog.id, ...log });

      if (log.type === "food" || log.type === "drink") {
        caloriesConsumed += Number(log.calories) || 0;
        proteinConsumed += Number(log.protein) || 0;
        carbsConsumed += Number(log.carbs) || 0;
        fatConsumed += Number(log.fat) || 0;
        sugarConsumed += Number(log.sugar) || Number(log.sugarg) || 0;
        fiberConsumed += Number(log.fiber) || 0;
        totalGI += Number(log.glycemicIndex) || 0; // Tracking total GI

        if (log.type === "drink") drinksCount += 1;
        nutritionItems += 1;
      } else if (log.type === "workout") {
        caloriesBurned += Number(log.caloriesBurned) || 0;
      }
    });

    const stats: DashboardQueryStats = {
      sugarConsumed,
      caloriesConsumed,
      proteinConsumed,
      drinksCount,
      totalItems: nutritionItems,
      totalGI,
    };

    // 3. Kalkulasi Metrics (Health, AI Insights, dll)
    const macroTargets = computeMacroTargets(p);
    const healthMetrics = computeHealthMetrics(p, macroTargets, stats);
    const metabolicScore = computeMetabolicScore(p, macroTargets, stats);
    const metabolicInsight = computeMetabolicInsight(p, macroTargets, stats);
    const dailyDirective = computeDailyDirective(p, macroTargets, stats);

    // 4. Bangun Format BFF (Backend-For-Frontend)
    return {
      insights: {
        highlights: [
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
        metabolicScore,
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
    if (!item.id) {
      throw new Error("History item must have an id");
    }
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

  // ── GET /dashboard/range-metrics logic ─────────────────────────────────────
  async getRangeMetrics(
    userId: string,
    range: TimeRange,
  ): Promise<{
    timeRange: TimeRange;
    metabolicScore: number;
    metabolicTrend: number;
    energyTrend: number;
  }> {
    const db = getDb();

    const doc = await db.collection(COL_USERS).doc(userId).get();
    const data = doc.data() || {};
    const p = data["profile"] as StoredProfile | undefined;
    const macroTargets = p
      ? computeMacroTargets(p)
      : { calories: 2000, protein: 120, carbs: 250, fat: 65, fiber: 25 };

    const rangeMs = timeRangeToMs(range);
    const nowMs = Date.now();
    const currentStartMs = nowMs - rangeMs;
    const previousStartMs = currentStartMs - rangeMs;

    const sinceDate = new Date(previousStartMs).toISOString().split("T")[0];
    const snapshot = await db
      .collection(COL_USERS)
      .doc(userId)
      .collection("logs")
      .where("date", ">=", sinceDate)
      .get();

    const createBucket = () => ({
      totalCalories: 0,
      totalSugar: 0,
      totalProtein: 0,
      drinksCount: 0,
      totalItems: 0,
      totalGI: 0,
      uniqueDays: new Set<string>(),
    });

    const current = createBucket();
    const previous = createBucket();

    const addLog = (
      bucket: ReturnType<typeof createBucket>,
      log: FirebaseFirestore.DocumentData,
      timestampMs: number,
    ) => {
      bucket.totalCalories += Number(log.calories) || 0;
      bucket.totalSugar += Number(log.sugar) || Number(log.sugarg) || 0;
      bucket.totalProtein += Number(log.protein) || 0;
      bucket.totalGI += Number(log.glycemicIndex) || 0;
      if (log.type === "drink") bucket.drinksCount += 1;
      bucket.totalItems += 1;
      bucket.uniqueDays.add(
        log.date || new Date(timestampMs).toISOString().split("T")[0],
      );
    };

    snapshot.forEach((docLog) => {
      const log = docLog.data();
      if (log.type !== "food" && log.type !== "drink") return;

      const timestampMs = log.timestamp
        ? new Date(log.timestamp).getTime()
        : log.date
          ? new Date(`${log.date}T00:00:00.000Z`).getTime()
          : 0;

      if (
        !Number.isFinite(timestampMs) ||
        timestampMs < previousStartMs ||
        timestampMs > nowMs
      )
        return;

      if (timestampMs >= currentStartMs) {
        addLog(current, log, timestampMs);
      } else {
        addLog(previous, log, timestampMs);
      }
    });

    const toStats = (
      bucket: ReturnType<typeof createBucket>,
    ): DashboardQueryStats => {
      const daysCount = Math.max(1, bucket.uniqueDays.size);

      return {
        sugarConsumed: bucket.totalSugar / daysCount,
        caloriesConsumed: bucket.totalCalories / daysCount,
        proteinConsumed: bucket.totalProtein / daysCount,
        drinksCount: bucket.drinksCount / daysCount,
        totalItems: bucket.totalItems, // raw sum over range
        totalGI: bucket.totalGI, // raw sum over range
      };
    };

    const currentStats = toStats(current);
    const previousStats = toStats(previous);
    const metabolicScore = computeMetabolicScore(p, macroTargets, currentStats);
    const previousMetabolicScore = computeMetabolicScore(
      p,
      macroTargets,
      previousStats,
    );

    const metabolicTrend =
      previous.totalItems === 0
        ? 0
        : Math.round(metabolicScore - previousMetabolicScore);

    const currentEnergy = Math.min(
      100,
      (currentStats.proteinConsumed / Math.max(1, macroTargets.protein)) * 100,
    );
    const previousEnergy = Math.min(
      100,
      (previousStats.proteinConsumed / Math.max(1, macroTargets.protein)) * 100,
    );
    const energyTrend =
      previous.totalItems === 0
        ? 0
        : Math.round(currentEnergy - previousEnergy);

    return { timeRange: range, metabolicScore, metabolicTrend, energyTrend };
  },

  // ── GET /dashboard/status logic ─────────────────────────────────────────────
  async getStatusData(
    userId: string,
    dateStr: string,
  ): Promise<UserStatusResponse> {
    const db = getDb();
    const doc = await db.collection(COL_USERS).doc(userId).get();
    if (!doc.exists) throw httpError("User tidak ditemukan.", 404);

    const data = doc.data() as Record<string, any>;
    const p = data["profile"] as StoredProfile | undefined;

    const logsSnapshot = await db
      .collection(COL_USERS)
      .doc(userId)
      .collection("logs")
      .where("date", "==", dateStr)
      .get();

    let caloriesConsumed = 0;
    let sugarConsumed = 0;
    let totalSugarAllTime = 0;
    let totalItems = 0;
    const activeAlerts: Array<{
      type: "danger" | "warning" | "info";
      title: string;
      message: string;
    }> = [];

    logsSnapshot.forEach((docLog) => {
      const log = docLog.data();
      if (log.type === "food" || log.type === "drink") {
        caloriesConsumed += Number(log.calories) || 0;
        sugarConsumed += Number(log.sugar) || Number(log.sugarg) || 0;
        totalSugarAllTime += Number(log.sugarg) || Number(log.sugar) || 0;
        totalItems++;
      }
    });

    const sugarLimit = p?.sugarLimit ?? 25;
    const macroTargets = p
      ? computeMacroTargets(p)
      : { calories: 2000, protein: 120, carbs: 250, fat: 65, fiber: 25 };

    const sugarDebt = Math.max(0, sugarConsumed - sugarLimit);
    if (sugarDebt > 0) {
      activeAlerts.push({
        type: "danger",
        title: "Sugar Debt Active",
        message: `Kamu sudah melampaui ${Math.round(sugarDebt * 10) / 10}g batas gula hari ini. Lakukan aktivitas fisik ringan untuk membakarnya.`,
      });
    }

    const medicalConditions: string[] =
      p?.medicalConditions ?? data["medicalConditions"] ?? [];
    if (medicalConditions.length > 0) {
      activeAlerts.push({
        type: "info",
        title: "Medical Monitoring",
        message: `Pemantauan aktif untuk: ${medicalConditions.join(", ")}.`,
      });
    }

    const level = data["level"] ?? 1;
    const avgSugar =
      totalItems > 0 ? sugarConsumed / Math.max(totalItems, 1) : 0;
    const performanceScore = Math.min(
      100,
      Math.max(0, Math.round(100 - avgSugar * 2 + level * 5)),
    );

    const dietAdherence =
      macroTargets.calories > 0
        ? Math.min(
            100,
            Math.round((caloriesConsumed / macroTargets.calories) * 100),
          )
        : 0;

    const nextEval = new Date();
    nextEval.setDate(nextEval.getDate() + 7);
    const nextEvalStr = `${nextEval.getDate()} ${nextEval.toLocaleString("id-ID", { month: "long" })} ${nextEval.getFullYear()}`;

    return {
      name: data["displayName"] ?? "Agent",
      rankTitle: data["rankTitle"] ?? "Rookie Agent",
      level,
      currentXp: data["currentXp"] ?? 0,
      nextLevelXp: data["nextLevelXp"] ?? 100,
      streak: data["streak"] ?? 0,
      weight: p?.weight ?? null,
      performanceScore,
      dietAdherence,
      activeAlerts,
      targetCalories: macroTargets.calories,
      caloriesConsumedToday: Math.round(caloriesConsumed),
      nextEvaluation: nextEvalStr,
    };
  },
};
