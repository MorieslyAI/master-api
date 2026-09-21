import { getDb } from "../lib/firebase.js";
import {
  PLAN_LIMITS,
  isPlanId,
  type PlanId,
  type PlanLimits,
} from "../config/plan.constants.js";

const COL_USERS = "users";

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

/**
 * Resolves the effective plan for a user: role (admin/whitelist) always wins,
 * then subscriptionPlan written by the RevenueCat webhook, falling back to
 * "free" if unset or expired (defensive — normally EXPIRATION events keep this in sync).
 */
export async function getUserPlan(userId: string): Promise<PlanId> {
  const db = getDb();
  const snap = await db.collection(COL_USERS).doc(userId).get();
  const data = snap.data() ?? {};

  const role = String(data["role"] ?? "user");
  if (role === "admin" || role === "whitelist") return "whitelist";

  const rawPlan = String(data["subscriptionPlan"] ?? data["plan"] ?? "free");
  if (rawPlan !== "free" && isExpired(data["subscriptionExpiresAt"])) {
    return "free";
  }

  return isPlanId(rawPlan) ? rawPlan : "free";
}

export function getPlanLimits(plan: PlanId): PlanLimits {
  return PLAN_LIMITS[plan] ?? PLAN_LIMITS.free;
}

export function isScanTypeAllowed(plan: PlanId, scanType: string): boolean {
  return getPlanLimits(plan).allowedScanTypes.includes(scanType);
}
