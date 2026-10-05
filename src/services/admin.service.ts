import { FieldValue } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import { getDb } from "../lib/firebase.js";
import { PLAN_LIMITS, type PlanLimits } from "../config/plan.constants.js";
import { getPlanLimits } from "./plan.service.js";

const COL_USERS = "users";
const COL_PLANS = "plans";
const COL_ACTIVITY_LOGS = "activity_logs";

type Role = "admin" | "user";
type UserStatus = "active" | "suspended" | "deleted";
type SubscriptionStatus = "trial" | "active" | "expired" | "cancelled";
type PlanStatus = "active" | "inactive";

interface ListUsersQuery {
  search?: string;
  role?: Role;
  plan?: string;
  status?: UserStatus;
  sortBy?: "email" | "displayName" | "createdAt" | "updatedAt" | "expiredAt";
  sortDir?: "asc" | "desc";
  page?: number;
  limit?: number;
}

interface UpsertPlanInput {
  name?: string;
  description?: string;
  status?: PlanStatus;
  features?: Record<string, unknown>;
  limits?: Partial<PlanLimits>;
  sortOrder?: number;
}

interface UpdateSubscriptionInput {
  plan?: string;
  status?: SubscriptionStatus;
  startedAt?: string | null;
  expiresAt?: string | null;
  source?: string;
  note?: string;
}

function httpError(message: string, statusCode: number): Error {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = statusCode;
  return err;
}

function toIso(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (typeof (value as { toDate?: () => Date }).toDate === "function") {
    return (value as { toDate: () => Date }).toDate().toISOString();
  }
  if (value instanceof Date) return value.toISOString();
  return null;
}

function toFirestoreDate(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw httpError("Format tanggal tidak valid.", 400);
  }
  return date.toISOString();
}

function getDayKey(date = new Date()): string {
  return date.toISOString().split("T")[0];
}

function getSubscriptionStatus(data: Record<string, unknown>): SubscriptionStatus {
  const raw = String(data["subscriptionStatus"] ?? "").toLowerCase();
  if (["trial", "active", "expired", "cancelled"].includes(raw)) {
    return raw as SubscriptionStatus;
  }

  const expiresAt = toIso(data["subscriptionExpiresAt"]);
  if (expiresAt && new Date(expiresAt).getTime() < Date.now()) return "expired";

  const plan = String(data["subscriptionPlan"] ?? data["plan"] ?? "free");
  return plan === "free" ? "expired" : "active";
}

function getUserStatus(data: Record<string, unknown>): UserStatus {
  const raw = String(data["status"] ?? "active").toLowerCase();
  if (raw === "suspended" || raw === "deleted") return raw;
  return "active";
}

function getPlanId(data: Record<string, unknown>): string {
  const status = getSubscriptionStatus(data);
  if (status === "expired" || status === "cancelled") return "free";
  return String(data["subscriptionPlan"] ?? data["plan"] ?? "free");
}

function compactUser(doc: FirebaseFirestore.DocumentSnapshot) {
  const data = doc.data() as Record<string, unknown>;
  const profile = (data["profile"] ?? {}) as Record<string, unknown>;
  const displayName = String(
    data["displayName"] ?? profile["name"] ?? data["email"] ?? "",
  );

  return {
    userId: doc.id,
    email: String(data["email"] ?? ""),
    displayName,
    role: String(data["role"] ?? "user") as Role,
    status: getUserStatus(data),
    plan: getPlanId(data),
    subscriptionStatus: getSubscriptionStatus(data),
    expiredAt: toIso(data["subscriptionExpiresAt"]),
    createdAt: toIso(data["createdAt"]),
    updatedAt: toIso(data["updatedAt"]),
  };
}

async function attachUsageSummary<T extends { userId: string; plan: string }>(
  user: T,
): Promise<
  T & {
    usageToday: { scanCount: number; chatCount: number };
    quota: { scanCount: number; chatCount: number };
    usagePercent: number;
  }
> {
  const [usageSnap, limits] = await Promise.all([
    getDb()
      .collection(COL_USERS)
      .doc(user.userId)
      .collection("daily_usage")
      .doc(getDayKey())
      .get(),
    getPlanLimits(user.plan),
  ]);

  const usage = usageSnap.data() ?? {};
  const scanCount = Number(usage["scanCount"] ?? 0);
  const chatCount = Number(usage["chatCount"] ?? 0);
  const scanLimit = Math.max(0, Number(limits.scanCount ?? 0));
  const chatLimit = Math.max(0, Number(limits.chatCount ?? 0));
  const scanPercent = scanLimit > 0 ? (scanCount / scanLimit) * 100 : 0;
  const chatPercent = chatLimit > 0 ? (chatCount / chatLimit) * 100 : 0;

  return {
    ...user,
    usageToday: { scanCount, chatCount },
    quota: {
      scanCount: scanLimit,
      chatCount: chatLimit,
    },
    usagePercent: Math.round(Math.min(100, Math.max(scanPercent, chatPercent))),
  };
}

function compareValues(a: unknown, b: unknown): number {
  const av = a == null ? "" : String(a).toLowerCase();
  const bv = b == null ? "" : String(b).toLowerCase();
  return av.localeCompare(bv);
}

async function writeAuditLog(input: {
  actorId: string;
  action: string;
  targetType: string;
  targetId: string;
  before?: unknown;
  after?: unknown;
}): Promise<void> {
  await getDb().collection(COL_ACTIVITY_LOGS).add({
    ...input,
    createdAt: FieldValue.serverTimestamp(),
  });
}

function defaultPlanRecord(id: string) {
  return {
    id,
    name:
      id === "pro_max"
        ? "Pro Max"
        : id.charAt(0).toUpperCase() + id.slice(1),
    description: "",
    status: "active" as PlanStatus,
    features: {},
    limits: PLAN_LIMITS[id],
    source: "default",
  };
}

function publicDefaultPlanIds(): string[] {
  return Object.keys(PLAN_LIMITS).filter((id) => id !== "whitelist");
}

export const adminService = {
  async getOverview() {
    const [usersSnap, plansSnap] = await Promise.all([
      getDb().collection(COL_USERS).get(),
      this.listPlans(),
    ]);

    const byPlan: Record<string, number> = {};
    const byRole: Record<string, number> = {};
    const byUserStatus: Record<string, number> = {};
    const bySubscriptionStatus: Record<string, number> = {};

    for (const doc of usersSnap.docs) {
      const user = compactUser(doc);
      byPlan[user.plan] = (byPlan[user.plan] ?? 0) + 1;
      byRole[user.role] = (byRole[user.role] ?? 0) + 1;
      byUserStatus[user.status] = (byUserStatus[user.status] ?? 0) + 1;
      bySubscriptionStatus[user.subscriptionStatus] =
        (bySubscriptionStatus[user.subscriptionStatus] ?? 0) + 1;
    }

    return {
      totalUsers: usersSnap.size,
      usersByPlan: byPlan,
      usersByRole: byRole,
      usersByStatus: byUserStatus,
      subscriptionsByStatus: bySubscriptionStatus,
      plans: plansSnap.length,
    };
  },

  async listUsers(query: ListUsersQuery) {
    const snap = await getDb().collection(COL_USERS).get();
    let users = snap.docs.map(compactUser);

    if (query.search) {
      const term = query.search.toLowerCase();
      users = users.filter(
        (user) =>
          user.email.toLowerCase().includes(term) ||
          user.displayName.toLowerCase().includes(term) ||
          user.userId.toLowerCase().includes(term),
      );
    }

    if (query.role) users = users.filter((user) => user.role === query.role);
    if (query.plan) users = users.filter((user) => user.plan === query.plan);
    if (query.status) {
      users = users.filter((user) => user.status === query.status);
    }

    const sortBy = query.sortBy ?? "createdAt";
    const sortDir = query.sortDir ?? "desc";
    users.sort((a, b) => {
      const result = compareValues(a[sortBy], b[sortBy]);
      return sortDir === "asc" ? result : -result;
    });

    const total = users.length;
    const limit = Math.min(Math.max(query.limit ?? 25, 1), 100);
    const page = Math.max(query.page ?? 1, 1);
    const offset = (page - 1) * limit;

    const pageItems = users.slice(offset, offset + limit);

    return {
      items: await Promise.all(pageItems.map(attachUsageSummary)),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  },

  async getUserDetail(userId: string) {
    const db = getDb();
    const userRef = db.collection(COL_USERS).doc(userId);
    const [userSnap, usageSnap, historySnap] = await Promise.all([
      userRef.get(),
      userRef.collection("daily_usage").doc(getDayKey()).get(),
      userRef.collection("plan_history").orderBy("createdAt", "desc").limit(20).get(),
    ]);

    if (!userSnap.exists) throw httpError("User tidak ditemukan.", 404);

    const data = userSnap.data() as Record<string, unknown>;
    const plan = getPlanId(data);
    const limits = await getPlanLimits(plan);
    const usage = usageSnap.data() ?? {};

    return {
      ...compactUser(userSnap),
      currentPlan: plan,
      subscription: {
        plan,
        status: getSubscriptionStatus(data),
        startedAt: toIso(data["subscriptionStartedAt"]),
        expiredAt: toIso(data["subscriptionExpiresAt"]),
        source: data["subscriptionSource"] ?? null,
      },
      usageToday: {
        scanCount: Number(usage["scanCount"] ?? 0),
        chatCount: Number(usage["chatCount"] ?? 0),
      },
      quota: {
        scanCount: limits.scanCount,
        chatCount: limits.chatCount,
        videoCallMinutesPerMonth: limits.videoCallMinutesPerMonth,
      },
      activeFeatures: limits,
      planHistory: historySnap.docs.map((doc) => ({
        id: doc.id,
        ...doc.data(),
        createdAt: toIso(doc.data()["createdAt"]),
      })),
    };
  },

  async updateUserRole(userId: string, role: Role, actorId: string) {
    if (role !== "admin" && role !== "user") {
      throw httpError("Role tidak valid.", 400);
    }

    const db = getDb();
    const userRef = db.collection(COL_USERS).doc(userId);
    const beforeSnap = await userRef.get();
    if (!beforeSnap.exists) throw httpError("User tidak ditemukan.", 404);

    const before = beforeSnap.data() ?? {};
    await userRef.set(
      { role, updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );

    const authUser = await getAuth().getUser(userId);
    await getAuth().setCustomUserClaims(userId, {
      ...(authUser.customClaims ?? {}),
      role,
    });

    await writeAuditLog({
      actorId,
      action: "user.role.update",
      targetType: "user",
      targetId: userId,
      before: { role: before["role"] ?? "user" },
      after: { role },
    });

    return { userId, role };
  },

  async updateUserStatus(userId: string, status: UserStatus, actorId: string) {
    if (!["active", "suspended", "deleted"].includes(status)) {
      throw httpError("Status user tidak valid.", 400);
    }

    const userRef = getDb().collection(COL_USERS).doc(userId);
    const beforeSnap = await userRef.get();
    if (!beforeSnap.exists) throw httpError("User tidak ditemukan.", 404);

    await userRef.set(
      { status, updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );

    await writeAuditLog({
      actorId,
      action: "user.status.update",
      targetType: "user",
      targetId: userId,
      before: { status: getUserStatus(beforeSnap.data() ?? {}) },
      after: { status },
    });

    return { userId, status };
  },

  async listPlans() {
    const snap = await getDb().collection(COL_PLANS).get();
    const records = new Map<string, Record<string, unknown>>();

    for (const id of publicDefaultPlanIds()) {
      records.set(id, defaultPlanRecord(id));
    }

    for (const doc of snap.docs) {
      const data = doc.data();
      records.set(doc.id, {
        id: doc.id,
        name: data["name"] ?? doc.id,
        description: data["description"] ?? "",
        status: data["status"] ?? "active",
        features: data["features"] ?? {},
        limits: await getPlanLimits(doc.id),
        sortOrder: data["sortOrder"] ?? 999,
        source: "firestore",
        createdAt: toIso(data["createdAt"]),
        updatedAt: toIso(data["updatedAt"]),
      });
    }

    return Array.from(records.values()).sort((a, b) => {
      const ao = Number(a["sortOrder"] ?? 999);
      const bo = Number(b["sortOrder"] ?? 999);
      return ao - bo || String(a["id"]).localeCompare(String(b["id"]));
    });
  },

  async upsertPlan(planId: string, input: UpsertPlanInput, actorId: string) {
    const id = planId.trim().toLowerCase();
    if (!id) throw httpError("Plan ID wajib diisi.", 400);
    if (input.status && !["active", "inactive"].includes(input.status)) {
      throw httpError("Status plan tidak valid.", 400);
    }

    const planRef = getDb().collection(COL_PLANS).doc(id);
    const beforeSnap = await planRef.get();
    const now = FieldValue.serverTimestamp();
    const payload = {
      ...(input.name !== undefined && { name: input.name }),
      ...(input.description !== undefined && { description: input.description }),
      ...(input.status !== undefined && { status: input.status }),
      ...(input.features !== undefined && { features: input.features }),
      ...(input.limits !== undefined && { limits: input.limits }),
      ...(input.sortOrder !== undefined && { sortOrder: input.sortOrder }),
      updatedAt: now,
      ...(!beforeSnap.exists && { createdAt: now }),
    };

    await planRef.set(payload, { merge: true });

    await writeAuditLog({
      actorId,
      action: beforeSnap.exists ? "plan.update" : "plan.create",
      targetType: "plan",
      targetId: id,
      before: beforeSnap.data() ?? null,
      after: payload,
    });

    const afterSnap = await planRef.get();
    return { id: afterSnap.id, ...afterSnap.data() };
  },

  async seedDefaultPlans(actorId: string) {
    const db = getDb();
    const batch = db.batch();
    const seeded: string[] = [];

    for (const id of publicDefaultPlanIds()) {
      const planRef = db.collection(COL_PLANS).doc(id);
      batch.set(
        planRef,
        {
          name: defaultPlanRecord(id).name,
          description: "",
          status: "active",
          features: {},
          limits: PLAN_LIMITS[id],
          updatedAt: FieldValue.serverTimestamp(),
          createdAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      seeded.push(id);
    }

    await batch.commit();
    await writeAuditLog({
      actorId,
      action: "plan.seed_defaults",
      targetType: "plan",
      targetId: "defaults",
      after: { seeded },
    });

    return { seeded };
  },

  async listFeatures() {
    const plans = await this.listPlans();
    const featureKeys = new Set<string>();
    const limitKeys = new Set<string>();

    for (const plan of plans) {
      Object.keys((plan["features"] ?? {}) as Record<string, unknown>).forEach(
        (key) => featureKeys.add(key),
      );
      Object.keys((plan["limits"] ?? {}) as Record<string, unknown>).forEach(
        (key) => limitKeys.add(key),
      );
    }

    return {
      features: Array.from(featureKeys).sort(),
      limits: Array.from(limitKeys).sort(),
    };
  },

  async updateSubscription(
    userId: string,
    input: UpdateSubscriptionInput,
    actorId: string,
  ) {
    const userRef = getDb().collection(COL_USERS).doc(userId);
    const beforeSnap = await userRef.get();
    if (!beforeSnap.exists) throw httpError("User tidak ditemukan.", 404);

    if (
      input.status &&
      !["trial", "active", "expired", "cancelled"].includes(input.status)
    ) {
      throw httpError("Status subscription tidak valid.", 400);
    }

    const before = beforeSnap.data() as Record<string, unknown>;
    const startedAt = toFirestoreDate(input.startedAt);
    const expiresAt = toFirestoreDate(input.expiresAt);
    const payload = {
      ...(input.plan !== undefined && { subscriptionPlan: input.plan }),
      ...(input.status !== undefined && { subscriptionStatus: input.status }),
      ...(startedAt !== undefined && { subscriptionStartedAt: startedAt }),
      ...(expiresAt !== undefined && { subscriptionExpiresAt: expiresAt }),
      ...(input.source !== undefined && { subscriptionSource: input.source }),
      subscriptionUpdatedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };

    await userRef.set(payload, { merge: true });
    await userRef.collection("plan_history").add({
      before: {
        plan: before["subscriptionPlan"] ?? before["plan"] ?? "free",
        status: getSubscriptionStatus(before),
        startedAt: toIso(before["subscriptionStartedAt"]),
        expiresAt: toIso(before["subscriptionExpiresAt"]),
      },
      after: {
        plan: input.plan ?? before["subscriptionPlan"] ?? before["plan"] ?? "free",
        status: input.status ?? getSubscriptionStatus(before),
        startedAt:
          startedAt !== undefined ? startedAt : toIso(before["subscriptionStartedAt"]),
        expiresAt:
          expiresAt !== undefined ? expiresAt : toIso(before["subscriptionExpiresAt"]),
      },
      note: input.note ?? null,
      actorId,
      createdAt: FieldValue.serverTimestamp(),
    });

    await writeAuditLog({
      actorId,
      action: "subscription.update",
      targetType: "user",
      targetId: userId,
      before: {
        plan: before["subscriptionPlan"] ?? before["plan"] ?? "free",
        status: getSubscriptionStatus(before),
      },
      after: payload,
    });

    return this.getUserDetail(userId);
  },

  async listActivityLogs(limit = 50) {
    const snap = await getDb()
      .collection(COL_ACTIVITY_LOGS)
      .orderBy("createdAt", "desc")
      .limit(Math.min(Math.max(limit, 1), 100))
      .get();

    return snap.docs.map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        ...data,
        createdAt: toIso(data["createdAt"]),
      };
    });
  },
};
