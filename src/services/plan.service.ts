import { getDb } from "../lib/firebase.js";
import {
  PLAN_LIMITS,
  type PlanId,
  type PlanLimits,
} from "../config/plan.constants.js";

const COL_USERS = "users";
const COL_PLANS = "plans";

function isExpired(expiresAt: unknown): boolean {
  if (!expiresAt) return false;
  const date =
    typeof expiresAt === "string"
      ? new Date(expiresAt)
      : typeof (expiresAt as { toDate?: () => Date }).toDate === "function"
        ? (expiresAt as { toDate: () => Date }).toDate()
        : null;
  if (!date || Number.isNaN(date.getTime())) return false;
  return date.getTime() < Date.now();
}

function mergePlanLimits(
  plan: PlanId,
  rawLimits: Record<string, unknown> | undefined,
): PlanLimits {
  const base = PLAN_LIMITS[plan] ?? PLAN_LIMITS.free;
  return {
    ...base,
    ...(rawLimits ?? {}),
  } as PlanLimits;
}

/**
 * Resolves the effective subscription plan for a user. Role is intentionally
 * kept separate: an admin can manage the system without becoming "Pro Max".
 */
export async function getUserPlan(userId: string): Promise<PlanId> {
  const db = getDb();
  const snap = await db.collection(COL_USERS).doc(userId).get();
  const data = snap.data() ?? {};

  const entitlementOverride = String(data["entitlementOverride"] ?? "");
  if (entitlementOverride === "whitelist") return "whitelist";

  const subscriptionStatus = String(data["subscriptionStatus"] ?? "").toLowerCase();
  if (subscriptionStatus === "expired" || subscriptionStatus === "cancelled") {
    return "free";
  }

  const rawPlan = String(data["subscriptionPlan"] ?? data["plan"] ?? "free");
  if (rawPlan !== "free" && isExpired(data["subscriptionExpiresAt"])) {
    return "free";
  }

  return rawPlan || "free";
}

export async function getPlanLimits(plan: PlanId): Promise<PlanLimits> {
  const snap = await getDb().collection(COL_PLANS).doc(plan).get();
  if (!snap.exists) return PLAN_LIMITS[plan] ?? PLAN_LIMITS.free;

  const data = snap.data() ?? {};
  if (String(data["status"] ?? "active") !== "active") {
    return PLAN_LIMITS.free;
  }

  return mergePlanLimits(plan, data["limits"] as Record<string, unknown> | undefined);
}

export async function isScanTypeAllowed(
  plan: PlanId,
  scanType: string,
): Promise<boolean> {
  const limits = await getPlanLimits(plan);
  return limits.allowedScanTypes.includes(scanType);
}
