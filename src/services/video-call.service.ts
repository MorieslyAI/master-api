import { getDb } from "../lib/firebase.js";
import { env } from "../config/env.js";
import { PLAN_LIMITS } from "../config/plan.constants.js";

const COL_USERS = "users";
const COL_SYSTEM = "system";
const SUB_VIDEO_DAYS = "video_call_days";
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

interface VideoCallSessionDoc {
  id: string;
  dayKey: string;
  status: SessionStatus;
  startedAt: string;
  lastHeartbeatAt: string;
  endedAt?: string;
  maxDurationSeconds: number;
  dailyMaxSeconds: number;
  consumedSeconds: number;
  endReason?: string;
  updatedAt: string;
}

interface VideoCallRuntimeDoc {
  activeSessions: number;
  updatedAt: string;
}

export interface VideoCallPolicy {
  maxDurationSeconds: number;
  dailyMaxCalls: number;
  dailyMaxSeconds: number;
  maxConcurrentSessions: number;
}

export interface VideoCallQuotaResult {
  dayKey: string;
  policy: VideoCallPolicy;
  startedCountToday: number;
  completedCountToday: number;
  activeSessionsToday: number;
  consumedSecondsToday: number;
  remainingCallsToday: number;
  remainingSecondsToday: number;
  activeSession: {
    sessionId: string;
    remainingSessionSeconds: number;
  } | null;
}

export interface VideoCallStartResult {
  sessionId: string;
  dayKey: string;
  policy: VideoCallPolicy;
  maxDurationSeconds: number;
  remainingCallsToday: number;
  remainingSecondsToday: number;
  expiresAt: string;
}

export interface VideoCallHeartbeatResult {
  status: SessionStatus;
  shouldEnd: boolean;
  reason?: string;
  remainingSessionSeconds: number;
  remainingSecondsToday: number;
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

function parseSessionDoc(
  raw: Record<string, unknown>,
  id: string,
): VideoCallSessionDoc {
  const nowIso = new Date().toISOString();
  return {
    id,
    dayKey: String(raw["dayKey"] ?? getDayKey()),
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
  const role = String(userData["role"] ?? "user");
  const subscriptionPlan = String(
    userData["subscriptionPlan"] ?? userData["plan"] ?? "free",
  );
  
  let currentPlan = subscriptionPlan;
  if (role === "admin" || role === "whitelist") {
    currentPlan = "whitelist";
  }
  
  const limits = PLAN_LIMITS[currentPlan] || PLAN_LIMITS.free;

  const userPolicyRaw = (userData["videoPolicy"] ?? {}) as Record<
    string,
    unknown
  >;

  const basePolicy: VideoCallPolicy = {
    maxDurationSeconds: clampInt(
      limits.videoCallMinutes * 60,
      60,
      60,
      7200,
    ),
    dailyMaxCalls: clampInt(
      limits.videoCallDailyMax,
      1,
      1,
      200,
    ),
    dailyMaxSeconds: clampInt(
      limits.videoCallMinutes * 60 * limits.videoCallDailyMax,
      60,
      60,
      86400,
    ),
    maxConcurrentSessions: clampInt(
      currentPlan === "free" ? 1 : Math.max(2, env.VIDEO_CALL_MAX_CONCURRENT_PER_USER),
      env.VIDEO_CALL_MAX_CONCURRENT_PER_USER,
      1,
      10,
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
  };
}

export const videoCallService = {
  async getQuota(userId: string): Promise<VideoCallQuotaResult> {
    const db = getDb();
    const policy = await resolvePolicy(userId);
    const dayKey = getDayKey();

    const dayRef = db
      .collection(COL_USERS)
      .doc(userId)
      .collection(SUB_VIDEO_DAYS)
      .doc(dayKey);

    const sessionsRef = db
      .collection(COL_USERS)
      .doc(userId)
      .collection(SUB_VIDEO_SESSIONS);

    const [daySnap, activeSessionsSnap] = await Promise.all([
      dayRef.get(),
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
    const remainingSecondsToday = Math.max(
      0,
      policy.dailyMaxSeconds - day.consumedSeconds - activeElapsedTotal,
    );

    return {
      dayKey,
      policy,
      startedCountToday: day.startedCount,
      completedCountToday: day.completedCount,
      activeSessionsToday: day.activeSessions,
      consumedSecondsToday: day.consumedSeconds,
      remainingCallsToday,
      remainingSecondsToday,
      activeSession,
    };
  },

  async startSession(userId: string): Promise<VideoCallStartResult> {
    const db = getDb();
    const policy = await resolvePolicy(userId);
    const now = new Date();
    const nowIso = now.toISOString();
    const dayKey = getDayKey(now);

    const dayRef = db
      .collection(COL_USERS)
      .doc(userId)
      .collection(SUB_VIDEO_DAYS)
      .doc(dayKey);
    const runtimeRef = db.collection(COL_SYSTEM).doc(DOC_VIDEO_RUNTIME);

    const sessionRef = db
      .collection(COL_USERS)
      .doc(userId)
      .collection(SUB_VIDEO_SESSIONS)
      .doc();

    let result: VideoCallStartResult | null = null;

    await db.runTransaction(async (tx) => {
      const [daySnap, runtimeSnap] = await Promise.all([
        tx.get(dayRef),
        tx.get(runtimeRef),
      ]);
      const day = parseDayDoc(
        daySnap.data() as Record<string, unknown> | undefined,
        dayKey,
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
      );

      const sessionDoc: VideoCallSessionDoc = {
        id: sessionRef.id,
        dayKey,
        status: "active",
        startedAt: nowIso,
        lastHeartbeatAt: nowIso,
        maxDurationSeconds,
        dailyMaxSeconds: policy.dailyMaxSeconds,
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
        policy,
        maxDurationSeconds,
        remainingCallsToday: Math.max(
          0,
          policy.dailyMaxCalls - (day.startedCount + 1),
        ),
        remainingSecondsToday: remainingDailySeconds,
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

      const [daySnap, runtimeSnap] = await Promise.all([
        tx.get(dayRef),
        tx.get(runtimeRef),
      ]);
      const day = parseDayDoc(
        daySnap.data() as Record<string, unknown> | undefined,
        session.dayKey,
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
      const finalConsumedSeconds = Math.min(boundedBySession, availableByDaily);

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
      };
    }

    const dayRef = db
      .collection(COL_USERS)
      .doc(userId)
      .collection(SUB_VIDEO_DAYS)
      .doc(session.dayKey);

    const daySnap = await dayRef.get();
    const day = parseDayDoc(
      daySnap.data() as Record<string, unknown> | undefined,
      session.dayKey,
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

    if (remainingSessionSeconds <= 0) {
      await this.endSession(userId, sessionId, "duration_limit_reached");
      return {
        status: "ended",
        shouldEnd: true,
        reason: "duration_limit_reached",
        remainingSessionSeconds: 0,
        remainingSecondsToday,
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
    };
  },
};
