import { Timestamp } from "firebase-admin/firestore";
import { getDb } from "../lib/firebase.js";
import { v4 as uuidv4 } from "uuid";

// ─── Firestore Collections ─────────────────────────────────────────────────────
const COL_USERS = "users";

// ─── Error Helper ─────────────────────────────────────────────────────────────
function httpError(message: string, statusCode: number): Error {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = statusCode;
  return err;
}

// ─── DTOs ─────────────────────────────────────────────────────────────────────

export interface WeightEntry {
  date: string;   // YYYY-MM-DD
  weight: number; // kg
}

export interface DailySugarPoint {
  date: string;   // "Sen", "Sel", etc. (weekday short)
  dateKey: string; // YYYY-MM-DD
  sugar: number;
}

export interface MacroSummary {
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  fiber: number;
  sugar: number;
  vitamins: Array<{ name: string; amount: string; percent: number }>;
}

export interface TrackDataResponse {
  // Body tab
  goal: {
    eventName: string;
    startDate: string;
    targetDate: string;
    startWeight: number;
    currentWeight: number;
    targetWeight: number;
  };
  weightHistory: WeightEntry[];
  // Nutrition tab
  sugarLast7Days: DailySugarPoint[];
  todayMacros: MacroSummary;
  sugarLimit: number;
  calorieTarget: number;
}

export interface FieldNote {
  id: string;
  text: string;
  date: string;       // YYYY-MM-DD
  createdAt: string;  // ISO timestamp
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isoToWeekdayShort(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString("id-ID", { weekday: "short" });
}

// ─── Track Service ─────────────────────────────────────────────────────────────

export const trackService = {

  // ── GET /track/data ──────────────────────────────────────────────────────────
  // Mengembalikan semua data yang dibutuhkan halaman Track (body + nutrition tab).
  async getTrackData(userId: string, todayStr: string): Promise<TrackDataResponse> {
    const db = getDb();
    const userDoc = await db.collection(COL_USERS).doc(userId).get();
    if (!userDoc.exists) throw httpError("User tidak ditemukan.", 404);

    const data = userDoc.data() as Record<string, any>;
    const profile = data["profile"] as Record<string, any> | undefined;
    if (!profile) throw httpError("Profil belum dikalibrasi.", 422);

    // 1. Weight history dari subcollection weight_logs
    const weightSnap = await db
      .collection(COL_USERS).doc(userId)
      .collection("weight_logs")
      .orderBy("date", "asc")
      .limit(30)
      .get();

    const weightHistory: WeightEntry[] = [];
    weightSnap.forEach((doc) => {
      const d = doc.data();
      weightHistory.push({ date: d["date"], weight: d["weight"] });
    });

    // Jika belum ada weight log, gunakan berat dari profil sebagai titik awal
    if (weightHistory.length === 0 && profile["weight"]) {
      weightHistory.push({ date: todayStr, weight: profile["weight"] });
    }

    const currentWeight = weightHistory.length > 0
      ? weightHistory[weightHistory.length - 1].weight
      : (profile["weight"] ?? 70);

    // 2. Sugar 7 hari terakhir dari logs
    const last7Days: string[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      last7Days.push(d.toISOString().split("T")[0]);
    }

    const oldestDate = last7Days[0];
    const logsSnap = await db
      .collection(COL_USERS).doc(userId)
      .collection("logs")
      .where("date", ">=", oldestDate)
      .get();

    // Aggregate sugar per hari
    const sugarByDay: Record<string, number> = {};
    // Aggregate nutrition hari ini
    let todayCalories = 0;
    let todayProtein = 0;
    let todayCarbs = 0;
    let todayFat = 0;
    let todayFiber = 0;
    let todaySugar = 0;
    const vitaminMap: Record<string, { amount: string; percent: number }> = {};

    logsSnap.forEach((docLog) => {
      const log = docLog.data();
      if (log["type"] === "food" || log["type"] === "drink") {
        const logDate = log["date"] as string;
        const sugarVal = Number(log["sugar"]) || Number(log["sugarg"]) || 0;
        sugarByDay[logDate] = (sugarByDay[logDate] ?? 0) + sugarVal;

        // Akumulasi nutrisi hari ini
        if (logDate === todayStr) {
          todayCalories += Number(log["calories"]) || 0;
          todayProtein  += Number(log["protein"])  || Number(log["macros"]?.protein) || 0;
          todayCarbs    += Number(log["carbs"])    || Number(log["macros"]?.carbs)   || 0;
          todayFat      += Number(log["fat"])      || Number(log["macros"]?.fat)     || 0;
          todayFiber    += Number(log["fiber"])    || Number(log["macros"]?.fiber)   || 0;
          todaySugar    += sugarVal;

          // Akumulasi vitamin
          const vitamins = log["vitamins"] as any[] | undefined;
          if (Array.isArray(vitamins)) {
            vitamins.forEach((v: any) => {
              if (v.name) {
                vitaminMap[v.name] = { amount: v.amount ?? "—", percent: v.percent ?? 0 };
              }
            });
          }
        }
      }
    });

    const sugarLast7Days: DailySugarPoint[] = last7Days.map((dateKey) => ({
      date: isoToWeekdayShort(dateKey),
      dateKey,
      sugar: Math.round((sugarByDay[dateKey] ?? 0) * 10) / 10,
    }));

    // 3. Calorie target dari profil
    const goalMode = profile["goalMode"] ?? "maintain";
    const weight = profile["weight"] ?? 70;
    const height = profile["height"] ?? 170;
    const age    = profile["age"]    ?? 30;
    const gender = profile["gender"] ?? "male";
    const genderOffset = gender === "male" ? 5 : -161;
    const bmr = 10 * weight + 6.25 * height - 5 * age + genderOffset;
    const af = { desk: 1.2, field: 1.5, heavy: 1.9, custom: 1.2 }[profile["archetypeId"] as string] ?? 1.2;
    const tdee = bmr * af;
    const calorieTarget = Math.round(
      goalMode === "cut" ? tdee - 400 : goalMode === "bulk" ? tdee + 400 : tdee
    );

    // 4. Goal config
    const goal = {
      eventName: profile["goalMode"] === "cut"
        ? "Fat Loss Mission"
        : profile["goalMode"] === "bulk"
          ? "Muscle Gain Mission"
          : "Maintain Performance",
      startDate: profile["calibratedAt"]
        ? new Date(profile["calibratedAt"].toDate()).toISOString().split("T")[0]
        : todayStr,
      targetDate: (() => {
        const d = new Date();
        d.setDate(d.getDate() + 90);
        return d.toISOString().split("T")[0];
      })(),
      startWeight: profile["weight"] ?? 70,
      currentWeight,
      targetWeight: profile["goalMode"] === "cut"
        ? Math.round((profile["weight"] ?? 70) - 5)
        : profile["goalMode"] === "bulk"
          ? Math.round((profile["weight"] ?? 70) + 5)
          : (profile["weight"] ?? 70),
    };

    return {
      goal,
      weightHistory,
      sugarLast7Days,
      todayMacros: {
        calories: Math.round(todayCalories),
        protein:  Math.round(todayProtein),
        carbs:    Math.round(todayCarbs),
        fat:      Math.round(todayFat),
        fiber:    Math.round(todayFiber),
        sugar:    Math.round(todaySugar * 10) / 10,
        vitamins: Object.entries(vitaminMap).map(([name, v]) => ({
          name,
          amount: v.amount,
          percent: v.percent,
        })),
      },
      sugarLimit: profile["sugarLimit"] ?? 25,
      calorieTarget,
    };
  },

  // ── POST /track/weight ───────────────────────────────────────────────────────
  // Catat berat badan baru dan update field weight di profil.
  async logWeight(userId: string, weight: number, dateStr: string): Promise<WeightEntry> {
    const db = getDb();
    const userRef = db.collection(COL_USERS).doc(userId);
    const userDoc = await userRef.get();
    if (!userDoc.exists) throw httpError("User tidak ditemukan.", 404);

    // Simpan ke subcollection weight_logs (upsert per hari)
    await db
      .collection(COL_USERS).doc(userId)
      .collection("weight_logs")
      .doc(dateStr)  // doc ID = tanggal, jadi 1 entry per hari
      .set({ date: dateStr, weight, loggedAt: Timestamp.now() });

    // Update berat di profil utama
    await userRef.update({
      "profile.weight": weight,
      updatedAt: Timestamp.now(),
    });

    return { date: dateStr, weight };
  },

  // ── GET /track/notes ────────────────────────────────────────────────────────
  // Ambil semua field notes user.
  async getNotes(userId: string): Promise<FieldNote[]> {
    const db = getDb();
    const snap = await db
      .collection(COL_USERS).doc(userId)
      .collection("notes")
      .orderBy("createdAt", "desc")
      .limit(50)
      .get();

    const notes: FieldNote[] = [];
    snap.forEach((doc) => {
      const d = doc.data();
      notes.push({
        id: doc.id,
        text: d["text"],
        date: d["date"],
        createdAt: d["createdAt"]?.toDate().toISOString() ?? new Date().toISOString(),
      });
    });
    return notes;
  },

  // ── POST /track/notes ───────────────────────────────────────────────────────
  // Buat catatan baru.
  async createNote(userId: string, text: string, dateStr: string): Promise<FieldNote> {
    const db = getDb();
    const id = uuidv4();
    const now = Timestamp.now();

    await db
      .collection(COL_USERS).doc(userId)
      .collection("notes")
      .doc(id)
      .set({ text, date: dateStr, createdAt: now });

    return { id, text, date: dateStr, createdAt: now.toDate().toISOString() };
  },

  // ── DELETE /track/notes/:id ─────────────────────────────────────────────────
  // Hapus catatan berdasarkan ID.
  async deleteNote(userId: string, noteId: string): Promise<void> {
    const db = getDb();
    const noteRef = db
      .collection(COL_USERS).doc(userId)
      .collection("notes")
      .doc(noteId);

    const snap = await noteRef.get();
    if (!snap.exists) throw httpError("Catatan tidak ditemukan.", 404);

    await noteRef.delete();
  },
};
