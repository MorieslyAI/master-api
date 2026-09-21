import { FieldValue } from "firebase-admin/firestore";
import { getDb } from "../lib/firebase.js";
import {
  generateContentTracked,
  type NormalizedGeminiUsage,
} from "../lib/gemini.js";
import { dietService } from "./diet.service.js";
import { trainingService } from "./training.service.js";
import { chatService } from "./chat.service.js";

// ─── Firestore ────────────────────────────────────────────────────────────────
// users/{uid}/bioSynergy/latest  — satu dokumen per user (hasil terakhir + kunci).
const COL_USERS = "users";
const SUB_BIO = "bioSynergy";
const DOC_LATEST = "latest";

// ─── Config ───────────────────────────────────────────────────────────────────

const BIO_MODEL = "gemini-2.5-flash";
/** Cooldown antar analisis sukses, dihitung dari waktu analisis dibuat. */
export const COOLDOWN_MS = 24 * 60 * 60 * 1000;
/** Kunci "sedang generate" dianggap basi (mis. server crash) setelah ini. */
const GENERATING_TTL_MS = 2 * 60 * 1000;
const WINDOW_DAYS = 7;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BioSynergyReport {
  text: string;
  model: string;
  createdAt: string; // ISO
}

export interface BioSynergyStatus {
  /** Hasil terakhir — tetap dikembalikan walau cooldown sudah lewat. */
  report: BioSynergyReport | null;
  canGenerate: boolean;
  /** ISO — kapan boleh generate lagi. null bila sudah boleh sekarang. */
  nextAvailableAt: string | null;
}

export type BioSynergyErrorCode =
  | "BIO_SYNERGY_COOLDOWN"
  | "BIO_SYNERGY_IN_PROGRESS";

export class BioSynergyError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code: BioSynergyErrorCode,
    public readonly status: BioSynergyStatus,
  ) {
    super(message);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isoDate(d: Date): string {
  return d.toISOString().split("T")[0];
}

/** YYYY-MM-DD dikurangi N hari (aritmetika UTC murni, aman dari timezone server). */
function shiftDate(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return isoDate(d);
}

function toStatus(data: FirebaseFirestore.DocumentData | undefined): BioSynergyStatus {
  const createdAt: string | undefined = data?.createdAt;
  const nextAt: string | undefined = data?.nextAvailableAt;
  const report: BioSynergyReport | null =
    data?.text && createdAt
      ? { text: data.text, model: data.model ?? BIO_MODEL, createdAt }
      : null;

  const locked = !!nextAt && new Date(nextAt).getTime() > Date.now();
  return {
    report,
    canGenerate: !locked,
    nextAvailableAt: locked ? nextAt! : null,
  };
}

const r1 = (n: number) => Math.round(n * 10) / 10;

// ─── Service ──────────────────────────────────────────────────────────────────

export const bioSynergyService = {
  ref(userId: string) {
    return getDb()
      .collection(COL_USERS)
      .doc(userId)
      .collection(SUB_BIO)
      .doc(DOC_LATEST);
  },

  // ── GET: hasil terakhir + status cooldown ───────────────────────────────────
  async getStatus(userId: string): Promise<BioSynergyStatus> {
    const snap = await this.ref(userId).get();
    return toStatus(snap.data());
  },

  // ── POST: generate (maks. 1x per 24 jam per user) ──────────────────────────
  async generate(
    userId: string,
    clientLocalDate?: string,
  ): Promise<{ status: BioSynergyStatus; usage: NormalizedGeminiUsage | undefined }> {
    const db = getDb();
    const ref = this.ref(userId);

    // 1) Klaim slot secara atomik SEBELUM memanggil Gemini, sehingga dua request
    //    bersamaan tidak bisa sama-sama lolos (dan tidak membakar token dobel).
    const claim = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.data();
      const status = toStatus(data);

      if (!status.canGenerate) {
        return { ok: false as const, reason: "cooldown" as const, status };
      }
      const since: string | undefined = data?.generatingSince;
      if (since && Date.now() - new Date(since).getTime() < GENERATING_TTL_MS) {
        return { ok: false as const, reason: "in_progress" as const, status };
      }
      tx.set(ref, { generatingSince: new Date().toISOString() }, { merge: true });
      return { ok: true as const };
    });

    if (!claim.ok) {
      if (claim.reason === "cooldown") {
        throw new BioSynergyError(
          "Bio-Synergy Engine hanya bisa dijalankan sekali per 24 jam.",
          409,
          "BIO_SYNERGY_COOLDOWN",
          claim.status,
        );
      }
      throw new BioSynergyError(
        "Analisis sedang diproses. Tunggu sebentar.",
        409,
        "BIO_SYNERGY_IN_PROGRESS",
        claim.status,
      );
    }

    // 2) Generate. Jika gagal, lepas kunci → jatah harian TIDAK terpakai.
    try {
      const localDate =
        clientLocalDate && DATE_RE.test(clientLocalDate)
          ? clientLocalDate
          : isoDate(new Date());

      const context = await this.buildContext(userId, localDate);
      const { response, usage } = await generateContentTracked(
        {
          model: BIO_MODEL,
          contents: [
            { role: "user", parts: [{ text: context }, { text: PROMPT }] },
          ],
        },
        { feature: "bio-synergy.report", userId },
      );

      const text = (response.text ?? "").trim();
      if (!text) {
        const err = new Error("AI tidak mengembalikan analisis. Coba lagi.") as Error & {
          statusCode: number;
        };
        err.statusCode = 502;
        throw err;
      }

      // 3) Simpan hasil + mulai cooldown dari SEKARANG.
      const now = new Date();
      const createdAt = now.toISOString();
      const nextAvailableAt = new Date(now.getTime() + COOLDOWN_MS).toISOString();
      // set() tanpa merge menimpa seluruh dokumen → kunci generatingSince ikut hilang.
      // (FieldValue.delete() tidak boleh dipakai di set() tanpa {merge:true}.)
      await ref.set({
        text,
        model: BIO_MODEL,
        createdAt,
        nextAvailableAt,
      });

      return {
        status: {
          report: { text, model: BIO_MODEL, createdAt },
          canGenerate: false,
          nextAvailableAt,
        },
        usage,
      };
    } catch (err) {
      await ref
        .set({ generatingSince: FieldValue.delete() }, { merge: true })
        .catch(() => {});
      throw err;
    }
  },

  // ── Susun konteks dari data server (bukan dari klien) ───────────────────────
  async buildContext(userId: string, localDate: string): Promise<string> {
    const db = getDb();
    const userRef = db.collection(COL_USERS).doc(userId);
    const since = shiftDate(localDate, WINDOW_DAYS - 1);

    const [userSnap, logsSnap, skinSnap, diet, training, sessions] =
      await Promise.all([
        userRef.get(),
        // Field mask: log skin menyimpan imageBase64 besar — jangan ikut terbaca.
        userRef
          .collection("logs")
          .where("date", ">=", since)
          .where("date", "<=", localDate)
          .select("date", "action", "sugarg", "itemType")
          .get(),
        userRef
          .collection("logs")
          .where("itemType", "==", "skin")
          .select("timestamp", "metadata")
          .get(),
        dietService.getActivePlans(userId).catch(() => null),
        trainingService.getActivePlan(userId).catch(() => null),
        chatService.getSessions(userId, 1).catch(() => []),
      ]);

    const u = userSnap.data() ?? {};
    const p = u.profile ?? {};

    // Profil
    const height = Number(p.height) || 0;
    const weight = Number(p.weight) || 0;
    const bmi = height > 0 && weight > 0 ? r1(weight / ((height / 100) ** 2)) : null;
    const limit = Number(p.sugarLimit) || 0;

    // Gula: hari ini + jendela 7 hari
    let todaySugar = 0;
    let windowSugar = 0;
    let scans = 0;
    const activeDays = new Set<string>();
    logsSnap.forEach((d) => {
      const l = d.data();
      scans += 1;
      if (l.action === "consumed") {
        const s = Number(l.sugarg) || 0;
        windowSugar += s;
        activeDays.add(l.date);
        if (l.date === localDate) todaySugar += s;
      }
    });
    const avgPerDay = activeDays.size ? r1(windowSugar / activeDays.size) : 0;

    // Skin scan terbaru (urut di memori; jumlahnya kecil, hindari composite index)
    const latestSkin = skinSnap.docs
      .map((d) => d.data())
      .sort((a, b) => String(b.timestamp ?? "").localeCompare(String(a.timestamp ?? "")))[0];
    const skinLine = latestSkin?.metadata
      ? `Age ${latestSkin.metadata.biologicalAge}, Glycation ${latestSkin.metadata.glycationLevel}`
      : "No Scan";

    const dailyPlan = diet?.daily;
    const trainingPlan = training?.plan;
    const lastSession = sessions[0];

    return `
PROFILE: ${p.name ?? "User"}, ${p.age ?? "?"}y, ${p.gender ?? "?"}, ${weight || "?"}kg, BMI ${bmi ?? "?"}.
MEDICAL: ${(p.medicalConditions ?? []).join(", ") || "None"}.
STATUS: Sugar Intake today ${r1(todaySugar)}/${limit || "?"}g. Streak: ${u.streak ?? 0}.

RECENT DATA:
- Diet Plan (today): ${dailyPlan ? dailyPlan.target : "None"}
- Training (today): ${trainingPlan ? trainingPlan.codename : "None"}
- Skin: ${skinLine}
- Last Chat: ${lastSession?.summary || "None"}
- Last ${WINDOW_DAYS} days: ${scans} logged items, ${r1(windowSugar)}g total sugar consumed, ${avgPerDay}g average per active day (${activeDays.size} active day${activeDays.size === 1 ? "" : "s"}).
`.trim();
  },
};

const PROMPT = `
Act as a "Bio-Synergy Architect". Analyze the user's unified data above.
Generate a personalized "Executive Summary" (3 paragraphs):
1. Status Report: Current biological state based on sugar/BMI/Skin.
2. Synergy Check: How their diet aligns with their training and skin data.
3. Tactical Directive: One specific, high-impact habit change to implement immediately.

Rules:
- Base every statement on the data above. If a data source says "None" or "No Scan", say it is missing instead of inventing values.
- Write plain text only: no markdown symbols (no **, #, or bullet asterisks). Put each section title on its own line, then its paragraph.

Tone: Professional, Elite, Encouraging yet strict.
`.trim();
