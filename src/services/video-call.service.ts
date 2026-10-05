import { getDb } from "../lib/firebase.js";
import { env } from "../config/env.js";
import { getPlanLimits, getUserPlan } from "./plan.service.js";

const COL_USERS = "users";
const COL_SYSTEM = "system";
const SUB_VIDEO_DAYS = "video_call_days";
const SUB_VIDEO_MONTHS = "video_call_months";
const SUB_VIDEO_SESSIONS = "video_call_sessions";
const DOC_VIDEO_RUNTIME = "video_call_runtime";

type SessionStatus = "active" | "ended";

interface VideoCallDayDoc {
  dayKey: string;
  startedCount: number;
  completedCount: number;
  consumedSeconds: number;
  activeSessions: number;
  updatedAt: string;
}

interface VideoCallMonthDoc {
  monthKey: string;
  consumedSeconds: number;
  updatedAt: string;
}

interface VideoCallSessionDoc {
  id: string;
  dayKey: string;
  monthKey: string;
  status: SessionStatus;
  startedAt: string;
  lastHeartbeatAt: string;
  endedAt?: string;
  maxDurationSeconds: number;
  dailyMaxSeconds: number;
  monthlyMaxSeconds: number;
  consumedSeconds: number;
  endReason?: string;
  updatedAt: string;
}

interface VideoCallRuntimeDoc {
  activeSessions: number;
  updatedAt: string;
}

export interface VideoCallPolicy {
  /** Batas durasi satu sesi (anti-abuse, sama untuk semua plan berbayar). */
  maxDurationSeconds: number;
  /** Batas jumlah sesi per hari (anti-abuse). */
  dailyMaxCalls: number;
  /** Batas detik per hari (anti-abuse, plafon di atas kuota bulanan). */
  dailyMaxSeconds: number;
  maxConcurrentSessions: number;
  /** Kuota nyata sesuai plan RevenueCat (menit/bulan → detik). 0 = fitur tidak tersedia. */
  monthlyMaxSeconds: number;
}

export interface VideoCallQuotaResult {
  dayKey: string;
  monthKey: string;
  policy: VideoCallPolicy;
  startedCountToday: number;
  completedCountToday: number;
  activeSessionsToday: number;
  consumedSecondsToday: number;
  consumedSecondsThisMonth: number;
  remainingCallsToday: number;
  remainingSecondsToday: number;
  remainingSecondsThisMonth: number;
  activeSession: {
    sessionId: string;
    remainingSessionSeconds: number;
  } | null;
}

export interface VideoCallStartResult {
  sessionId: string;
  dayKey: string;
  monthKey: string;
  policy: VideoCallPolicy;
  maxDurationSeconds: number;
  remainingCallsToday: number;
  remainingSecondsToday: number;
  remainingSecondsThisMonth: number;
  expiresAt: string;
}

export interface VideoCallHeartbeatResult {
  status: SessionStatus;
  shouldEnd: boolean;
  reason?: string;
  remainingSessionSeconds: number;
  remainingSecondsToday: number;
  remainingSecondsThisMonth: number;
}

export interface VideoCallEndResult {
  status: SessionStatus;
  sessionId: string;
  dayKey: string;
  consumedSeconds: number;
  reason: string;
}

export interface VideoCallSessionSnapshot {
  id: string;
  dayKey: string;
  status: SessionStatus;
  startedAt: string;
  lastHeartbeatAt: string;
  maxDurationSeconds: number;
  dailyMaxSeconds: number;
  consumedSeconds: number;
}

function getDayKey(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

function getMonthKey(date = new Date()): string {
  return date.toISOString().slice(0, 7); // YYYY-MM
}

function monthKeyFromDayKey(dayKey: string): string {
  return dayKey.slice(0, 7);
}

function clampInt(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function toIso(value: unknown, fallback: string): string {
  if (typeof value === "string" && value) return value;
  return fallback;
}

function parseDayDoc(
  raw: Record<string, unknown> | undefined,
  dayKey: string,
): VideoCallDayDoc {
  const nowIso = new Date().toISOString();
  return {
    dayKey,
    startedCount: clampInt(raw?.["startedCount"], 0, 0, 100000),
    completedCount: clampInt(raw?.["completedCount"], 0, 0, 100000),
    consumedSeconds: clampInt(raw?.["consumedSeconds"], 0, 0, 86400),
    activeSessions: clampInt(raw?.["activeSessions"], 0, 0, 1000),
    updatedAt: toIso(raw?.["updatedAt"], nowIso),
  };
}

function parseMonthDoc(
  raw: Record<string, unknown> | undefined,
  monthKey: string,
): VideoCallMonthDoc {
  const nowIso = new Date().toISOString();
  return {
    monthKey,
    consumedSeconds: clampInt(raw?.["consumedSeconds"], 0, 0, 100_000_000),
    updatedAt: toIso(raw?.["updatedAt"], nowIso),
  };
}

function parseSessionDoc(
  raw: Record<string, unknown>,
  id: string,
): VideoCallSessionDoc {
  const nowIso = new Date().toISOString();
  const dayKey = String(raw["dayKey"] ?? getDayKey());
  return {
    id,
    dayKey,
    monthKey: String(raw["monthKey"] ?? monthKeyFromDayKey(dayKey)),
    status: raw["status"] === "ended" ? "ended" : "active",
    startedAt: toIso(raw["startedAt"], nowIso),
    lastHeartbeatAt: toIso(raw["lastHeartbeatAt"], nowIso),
    endedAt: typeof raw["endedAt"] === "string" ? raw["endedAt"] : undefined,
    maxDurationSeconds: clampInt(
      raw["maxDurationSeconds"],
      env.VIDEO_CALL_MAX_DURATION_SECONDS,
      60,
      86400,
    ),
    dailyMaxSeconds: clampInt(
      raw["dailyMaxSeconds"],
      env.VIDEO_CALL_DAILY_MAX_SECONDS,
      60,
      86400,
    ),
    monthlyMaxSeconds: clampInt(raw["monthlyMaxSeconds"], 0, 0, 100_000_000),
    consumedSeconds: clampInt(raw["consumedSeconds"], 0, 0, 86400),
    endReason:
      typeof raw["endReason"] === "string" ? raw["endReason"] : undefined,
    updatedAt: toIso(raw["updatedAt"], nowIso),
  };
}

function parseRuntimeDoc(
  raw: Record<string, unknown> | undefined,
): VideoCallRuntimeDoc {
  const nowIso = new Date().toISOString();
  return {
    activeSessions: clampInt(raw?.["activeSessions"], 0, 0, 1000000),
    updatedAt: toIso(raw?.["updatedAt"], nowIso),
  };
}

function httpError(message: string, statusCode: number, code?: string): Error {
  const err = new Error(message) as Error & {
    statusCode: number;
    code?: string;
  };
  err.statusCode = statusCode;
  if (code) err.code = code;
  return err;
}

async function resolvePolicy(userId: string): Promise<VideoCallPolicy> {
  const db = getDb();
  const userSnap = await db.collection(COL_USERS).doc(userId).get();
  const userData = (userSnap.data() ?? {}) as Record<string, unknown>;

  const plan = await getUserPlan(userId);
  const limits = getPlanLimits(plan);

  const userPolicyRaw = (userData["videoPolicy"] ?? {}) as Record<
    string,
    unknown
  >;

  // maxDurationSeconds/dailyMaxCalls/dailyMaxSeconds adalah plafon anti-abuse
  // (sama untuk semua plan berbayar) — kuota bisnis sebenarnya berasal dari
  // monthlyMaxSeconds, yang mengikuti plan RevenueCat user (lihat plan.constants.ts).
  const basePolicy: VideoCallPolicy = {
    maxDurationSeconds: clampInt(
      env.VIDEO_CALL_MAX_DURATION_SECONDS,
      900,
      60,
      7200,
    ),
    dailyMaxCalls: clampInt(env.VIDEO_CALL_DAILY_MAX_CALLS, 5, 1, 200),
    dailyMaxSeconds: clampInt(
      env.VIDEO_CALL_DAILY_MAX_SECONDS,
      3600,
      60,
      86400,
    ),
    maxConcurrentSessions: clampInt(
      plan === "free" ? 1 : Math.max(2, env.VIDEO_CALL_MAX_CONCURRENT_PER_USER),
      env.VIDEO_CALL_MAX_CONCURRENT_PER_USER,
      1,
      10,
    ),
    monthlyMaxSeconds: clampInt(
      limits.videoCallMinutesPerMonth * 60,
      0,
      0,
      100_000_000,
    ),
  };

  return {
    maxDurationSeconds: clampInt(
      userPolicyRaw["maxDurationSeconds"],
      basePolicy.maxDurationSeconds,
      60,
      7200,
    ),
    dailyMaxCalls: clampInt(
      userPolicyRaw["dailyMaxCalls"],
      basePolicy.dailyMaxCalls,
      1,
      200,
    ),
    dailyMaxSeconds: clampInt(
      userPolicyRaw["dailyMaxSeconds"],
      basePolicy.dailyMaxSeconds,
      60,
      86400,
    ),
    maxConcurrentSessions: clampInt(
      userPolicyRaw["maxConcurrentSessions"],
      basePolicy.maxConcurrentSessions,
      1,
      10,
    ),
    // monthlyMaxSeconds murni turunan plan RevenueCat — tidak bisa dioverride per-user.
    monthlyMaxSeconds: basePolicy.monthlyMaxSeconds,
  };
}

export const videoCallService = {
  async getQuota(userId: string): Promise<VideoCallQuotaResult> {
    const db = getDb();
    const policy = await resolvePolicy(userId);
    const dayKey = getDayKey();
    const monthKey = getMonthKey();

    const dayRef = db
      .collection(COL_USERS)
      .doc(userId)
      .collection(SUB_VIDEO_DAYS)
      .doc(dayKey);

    const monthRef = db
      .collection(COL_USERS)
      .doc(userId)
      .collection(SUB_VIDEO_MONTHS)
      .doc(monthKey);

    const sessionsRef = db
      .collection(COL_USERS)
      .doc(userId)
      .collection(SUB_VIDEO_SESSIONS);

    const [daySnap, monthSnap, activeSessionsSnap] = await Promise.all([
      dayRef.get(),
      monthRef.get(),
      sessionsRef
        .where("status", "==", "active")
        .orderBy("startedAt", "desc")
        .limit(10)
        .get(),
    ]);

    const day = parseDayDoc(
      daySnap.data() as Record<string, unknown> | undefined,
      dayKey,
    );
    const month = parseMonthDoc(
      monthSnap.data() as Record<string, unknown> | undefined,
      monthKey,
    );
    const now = Date.now();

    let activeElapsedTotal = 0;
    let activeSession: {
      sessionId: string;
      remainingSessionSeconds: number;
    } | null = null;

    activeSessionsSnap.docs.forEach((doc, idx) => {
      const session = parseSessionDoc(
        doc.data() as Record<string, unknown>,
        doc.id,
      );
      const elapsed = Math.max(
        0,
        Math.floor((now - new Date(session.startedAt).getTime()) / 1000),
      );
      const boundedElapsed = Math.min(elapsed, session.maxDurationSeconds);
      activeElapsedTotal += boundedElapsed;

      if (idx === 0) {
        activeSession = {
          sessionId: session.id,
          remainingSessionSeconds: Math.max(
            0,
            session.maxDurationSeconds - elapsed,
          ),
        };
      }
    });

    const remainingCallsToday = Math.max(
      0,
      policy.dailyMaxCalls - day.startedCount,
    );
    const remainingSecondsThisMonth = Math.max(
      0,
      policy.monthlyMaxSeconds - month.consumedSeconds - activeElapsedTotal,
    );
    const remainingSecondsToday = Math.min(
      Math.max(0, policy.dailyMaxSeconds - day.consumedSeconds - activeElapsedTotal),
      remainingSecondsThisMonth,
    );

    return {
      dayKey,
      monthKey,
      policy,
      startedCountToday: day.startedCount,
      completedCountToday: day.completedCount,
      activeSessionsToday: day.activeSessions,
      consumedSecondsToday: day.consumedSeconds,
      consumedSecondsThisMonth: month.consumedSeconds,
      remainingCallsToday,
      remainingSecondsToday,
      remainingSecondsThisMonth,
      activeSession,
    };
  },

  async startSession(userId: string): Promise<VideoCallStartResult> {
    const db = getDb();
    const policy = await resolvePolicy(userId);

    if (policy.monthlyMaxSeconds <= 0) {
      throw httpError(
        "Video call tidak tersedia di paket Anda saat ini. Upgrade ke Pro untuk membuka fitur ini.",
        403,
        "VIDEO_PLAN_UPGRADE_REQUIRED",
      );
    }

    const now = new Date();
    const nowIso = now.toISOString();
    const dayKey = getDayKey(now);
    const monthKey = getMonthKey(now);

    const dayRef = db
      .collection(COL_USERS)
      .doc(userId)
      .collection(SUB_VIDEO_DAYS)
      .doc(dayKey);
    const monthRef = db
      .collection(COL_USERS)
      .doc(userId)
      .collection(SUB_VIDEO_MONTHS)
      .doc(monthKey);
    const runtimeRef = db.collection(COL_SYSTEM).doc(DOC_VIDEO_RUNTIME);

    const sessionRef = db
      .collection(COL_USERS)
      .doc(userId)
      .collection(SUB_VIDEO_SESSIONS)
      .doc();

    let result: VideoCallStartResult | null = null;

    await db.runTransaction(async (tx) => {
      const [daySnap, monthSnap, runtimeSnap] = await Promise.all([
        tx.get(dayRef),
        tx.get(monthRef),
        tx.get(runtimeRef),
      ]);
      const day = parseDayDoc(
        daySnap.data() as Record<string, unknown> | undefined,
        dayKey,
      );
      const month = parseMonthDoc(
        monthSnap.data() as Record<string, unknown> | undefined,
        monthKey,
      );
      const runtime = parseRuntimeDoc(
        runtimeSnap.data() as Record<string, unknown> | undefined,
      );

      if (runtime.activeSessions >= env.VIDEO_CALL_GLOBAL_MAX_CONCURRENT) {
        throw httpError(
          "Kapasitas video call sedang penuh. Coba lagi beberapa saat.",
          429,
          "VIDEO_GLOBAL_CAPACITY_REACHED",
        );
      }

      if (day.activeSessions >= policy.maxConcurrentSessions) {
        throw httpError(
          "Masih ada sesi video aktif. Selesaikan dulu sesi sebelumnya.",
          409,
          "VIDEO_ACTIVE_SESSION_EXISTS",
        );
      }

      if (day.startedCount >= policy.dailyMaxCalls) {
        throw httpError(
          "Kuota jumlah video call harian sudah habis.",
          429,
          "VIDEO_DAILY_CALL_COUNT_EXCEEDED",
        );
      }

      const remainingMonthlySeconds = Math.max(
        0,
        policy.monthlyMaxSeconds - month.consumedSeconds,
      );
      if (remainingMonthlySeconds <= 0) {
        throw httpError(
          "Kuota durasi video call bulanan sudah habis.",
          429,
          "VIDEO_MONTHLY_DURATION_EXCEEDED",
        );
      }

      const remainingDailySeconds = Math.max(
        0,
        policy.dailyMaxSeconds - day.consumedSeconds,
      );
      if (remainingDailySeconds <= 0) {
        throw httpError(
          "Kuota durasi video call harian sudah habis.",
          429,
          "VIDEO_DAILY_DURATION_EXCEEDED",
        );
      }

      const maxDurationSeconds = Math.min(
        policy.maxDurationSeconds,
        remainingDailySeconds,
        remainingMonthlySeconds,
      );

      const sessionDoc: VideoCallSessionDoc = {
        id: sessionRef.id,
        dayKey,
        monthKey,
        status: "active",
        startedAt: nowIso,
        lastHeartbeatAt: nowIso,
        maxDurationSeconds,
        dailyMaxSeconds: policy.dailyMaxSeconds,
        monthlyMaxSeconds: policy.monthlyMaxSeconds,
        consumedSeconds: 0,
        updatedAt: nowIso,
      };

      tx.set(sessionRef, sessionDoc);
      tx.set(
        dayRef,
        {
          dayKey,
          startedCount: day.startedCount + 1,
          completedCount: day.completedCount,
          consumedSeconds: day.consumedSeconds,
          activeSessions: day.activeSessions + 1,
          updatedAt: nowIso,
        },
        { merge: true },
      );

      tx.set(
        runtimeRef,
        {
          activeSessions: runtime.activeSessions + 1,
          updatedAt: nowIso,
        },
        { merge: true },
      );

      result = {
        sessionId: sessionRef.id,
        dayKey,
        monthKey,
        policy,
        maxDurationSeconds,
        remainingCallsToday: Math.max(
          0,
          policy.dailyMaxCalls - (day.startedCount + 1),
        ),
        remainingSecondsToday: Math.min(
          remainingDailySeconds,
          remainingMonthlySeconds,
        ),
        remainingSecondsThisMonth: remainingMonthlySeconds,
        expiresAt: new Date(
          now.getTime() + maxDurationSeconds * 1000,
        ).toISOString(),
      };
    });

    if (!result) {
      throw httpError(
        "Gagal memulai sesi video call.",
        500,
        "VIDEO_START_FAILED",
      );
    }

    return result;
  },

  async getSessionSnapshot(
    userId: string,
    sessionId: string,
  ): Promise<VideoCallSessionSnapshot> {
    const db = getDb();
    const sessionRef = db
      .collection(COL_USERS)
      .doc(userId)
      .collection(SUB_VIDEO_SESSIONS)
      .doc(sessionId);

    const sessionSnap = await sessionRef.get();
    if (!sessionSnap.exists) {
      throw httpError(
        "Sesi video call tidak ditemukan.",
        404,
        "VIDEO_SESSION_NOT_FOUND",
      );
    }

    const session = parseSessionDoc(
      sessionSnap.data() as Record<string, unknown>,
      sessionSnap.id,
    );

    return {
      id: session.id,
      dayKey: session.dayKey,
      status: session.status,
      startedAt: session.startedAt,
      lastHeartbeatAt: session.lastHeartbeatAt,
      maxDurationSeconds: session.maxDurationSeconds,
      dailyMaxSeconds: session.dailyMaxSeconds,
      consumedSeconds: session.consumedSeconds,
    };
  },

  async endSession(
    userId: string,
    sessionId: string,
    reason: string,
  ): Promise<VideoCallEndResult> {
    const db = getDb();
    const now = new Date();
    const nowIso = now.toISOString();

    const sessionRef = db
      .collection(COL_USERS)
      .doc(userId)
      .collection(SUB_VIDEO_SESSIONS)
      .doc(sessionId);
    const runtimeRef = db.collection(COL_SYSTEM).doc(DOC_VIDEO_RUNTIME);

    let result: VideoCallEndResult | null = null;

    await db.runTransaction(async (tx) => {
      const sessionSnap = await tx.get(sessionRef);
      if (!sessionSnap.exists) {
        throw httpError(
          "Sesi video call tidak ditemukan.",
          404,
          "VIDEO_SESSION_NOT_FOUND",
        );
      }

      const session = parseSessionDoc(
        sessionSnap.data() as Record<string, unknown>,
        sessionSnap.id,
      );
      const dayRef = db
        .collection(COL_USERS)
        .doc(userId)
        .collection(SUB_VIDEO_DAYS)
        .doc(session.dayKey);
      const monthRef = db
        .collection(COL_USERS)
        .doc(userId)
        .collection(SUB_VIDEO_MONTHS)
        .doc(session.monthKey);

      const [daySnap, monthSnap, runtimeSnap] = await Promise.all([
        tx.get(dayRef),
        tx.get(monthRef),
        tx.get(runtimeRef),
      ]);
      const day = parseDayDoc(
        daySnap.data() as Record<string, unknown> | undefined,
        session.dayKey,
      );
      const month = parseMonthDoc(
        monthSnap.data() as Record<string, unknown> | undefined,
        session.monthKey,
      );
      const runtime = parseRuntimeDoc(
        runtimeSnap.data() as Record<string, unknown> | undefined,
      );

      if (session.status === "ended") {
        result = {
          status: "ended",
          sessionId: session.id,
          dayKey: session.dayKey,
          consumedSeconds: session.consumedSeconds,
          reason: session.endReason ?? reason,
        };
        return;
      }

      const elapsedSeconds = Math.max(
        1,
        Math.floor(
          (now.getTime() - new Date(session.startedAt).getTime()) / 1000,
        ),
      );
      const boundedBySession = Math.min(
        elapsedSeconds,
        session.maxDurationSeconds,
      );
      const availableByDaily = Math.max(
        0,
        session.dailyMaxSeconds - day.consumedSeconds,
      );
      const availableByMonthly = Math.max(
        0,
        session.monthlyMaxSeconds - month.consumedSeconds,
      );
      const finalConsumedSeconds = Math.min(
        boundedBySession,
        availableByDaily,
        availableByMonthly,
      );

      tx.update(sessionRef, {
        status: "ended",
        endedAt: nowIso,
        consumedSeconds: finalConsumedSeconds,
        endReason: reason,
        updatedAt: nowIso,
      });

      tx.set(
        dayRef,
        {
          dayKey: session.dayKey,
          startedCount: day.startedCount,
          completedCount: day.completedCount + 1,
          consumedSeconds: day.consumedSeconds + finalConsumedSeconds,
          activeSessions: Math.max(0, day.activeSessions - 1),
          updatedAt: nowIso,
        },
        { merge: true },
      );

      tx.set(
        monthRef,
        {
          monthKey: session.monthKey,
          consumedSeconds: month.consumedSeconds + finalConsumedSeconds,
          updatedAt: nowIso,
        },
        { merge: true },
      );

      tx.set(
        runtimeRef,
        {
          activeSessions: Math.max(0, runtime.activeSessions - 1),
          updatedAt: nowIso,
        },
        { merge: true },
      );

      result = {
        status: "ended",
        sessionId: session.id,
        dayKey: session.dayKey,
        consumedSeconds: finalConsumedSeconds,
        reason,
      };
    });

    if (!result) {
      throw httpError(
        "Gagal mengakhiri sesi video call.",
        500,
        "VIDEO_END_FAILED",
      );
    }

    return result;
  },

  async heartbeat(
    userId: string,
    sessionId: string,
  ): Promise<VideoCallHeartbeatResult> {
    const db = getDb();
    const sessionRef = db
      .collection(COL_USERS)
      .doc(userId)
      .collection(SUB_VIDEO_SESSIONS)
      .doc(sessionId);

    const sessionSnap = await sessionRef.get();
    if (!sessionSnap.exists) {
      throw httpError(
        "Sesi video call tidak ditemukan.",
        404,
        "VIDEO_SESSION_NOT_FOUND",
      );
    }

    const session = parseSessionDoc(
      sessionSnap.data() as Record<string, unknown>,
      sessionSnap.id,
    );
    if (session.status === "ended") {
      return {
        status: "ended",
        shouldEnd: true,
        reason: session.endReason ?? "session_ended",
        remainingSessionSeconds: 0,
        remainingSecondsToday: 0,
        remainingSecondsThisMonth: 0,
      };
    }

    const dayRef = db
      .collection(COL_USERS)
      .doc(userId)
      .collection(SUB_VIDEO_DAYS)
      .doc(session.dayKey);
    const monthRef = db
      .collection(COL_USERS)
      .doc(userId)
      .collection(SUB_VIDEO_MONTHS)
      .doc(session.monthKey);

    const [daySnap, monthSnap] = await Promise.all([
      dayRef.get(),
      monthRef.get(),
    ]);
    const day = parseDayDoc(
      daySnap.data() as Record<string, unknown> | undefined,
      session.dayKey,
    );
    const month = parseMonthDoc(
      monthSnap.data() as Record<string, unknown> | undefined,
      session.monthKey,
    );

    const nowDate = new Date();
    const now = nowDate.getTime();
    const nowIso = nowDate.toISOString();
    const elapsedSeconds = Math.max(
      0,
      Math.floor((now - new Date(session.startedAt).getTime()) / 1000),
    );
    const remainingSessionSeconds = Math.max(
      0,
      session.maxDurationSeconds - elapsedSeconds,
    );
    const remainingSecondsToday = Math.max(
      0,
      session.dailyMaxSeconds - day.consumedSeconds - elapsedSeconds,
    );
    const remainingSecondsThisMonth = Math.max(
      0,
      session.monthlyMaxSeconds - month.consumedSeconds - elapsedSeconds,
    );

    if (remainingSessionSeconds <= 0) {
      await this.endSession(userId, sessionId, "duration_limit_reached");
      return {
        status: "ended",
        shouldEnd: true,
        reason: "duration_limit_reached",
        remainingSessionSeconds: 0,
        remainingSecondsToday,
        remainingSecondsThisMonth,
      };
    }

    if (remainingSecondsThisMonth <= 0) {
      await this.endSession(userId, sessionId, "monthly_duration_exhausted");
      return {
        status: "ended",
        shouldEnd: true,
        reason: "monthly_duration_exhausted",
        remainingSessionSeconds,
        remainingSecondsToday,
        remainingSecondsThisMonth: 0,
      };
    }

    if (remainingSecondsToday <= 0) {
      await this.endSession(userId, sessionId, "daily_duration_exhausted");
      return {
        status: "ended",
        shouldEnd: true,
        reason: "daily_duration_exhausted",
        remainingSessionSeconds,
        remainingSecondsToday: 0,
        remainingSecondsThisMonth,
      };
    }

    await sessionRef.set(
      {
        lastHeartbeatAt: nowIso,
        updatedAt: nowIso,
      },
      { merge: true },
    );

    return {
      status: "active",
      shouldEnd: false,
      remainingSessionSeconds,
      remainingSecondsToday,
      remainingSecondsThisMonth,
    };
  },
};
