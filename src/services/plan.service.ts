import { getDb } from "../lib/firebase.js";
import {
  PLAN_LIMITS,
  isPlanId,
  type PlanId,
  type PlanLimits,
} from "../config/plan.constants.js";

const COL_USERS = "users";

type UserSubscriptionData = Record<string, unknown>;

function asRecord(value: unknown): UserSubscriptionData {
  return value !== null && typeof value === "object"
    ? (value as UserSubscriptionData)
    : {};
}

function normalizePlanId(value: unknown): PlanId | null {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

  return isPlanId(normalized) ? normalized : null;
}

function getSubscriptionExpiryValue(data: UserSubscriptionData): unknown {
  const subscription = asRecord(data["subscription"]);

  return (
    subscription["currentPeriodEnd"] ??
    subscription["endsAt"] ??
    data["subscriptionExpiry"] ??
    data["subscriptionExpiresAt"] ??
    null
  );
}

function getSubscriptionStatus(data: UserSubscriptionData): string | null {
  const subscription = asRecord(data["subscription"]);
  const value = subscription["status"] ?? data["subscriptionStatus"];
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized || null;
}

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

  return resolveUserPlan(data);
}

/**
 * Resolves the canonical admin subscription object first, with RevenueCat
 * root fields and older root plan fields kept as migration fallbacks.
 */
export function resolveUserPlan(data: UserSubscriptionData): PlanId {
  const subscription = asRecord(data["subscription"]);

  const role = String(data["role"] ?? "user");
  if (role === "admin" || role === "whitelist") return "whitelist";

  const plan =
    normalizePlanId(subscription["plan"]) ??
    normalizePlanId(data["subscriptionPlan"]) ??
    normalizePlanId(data["plan"]) ??
    "free";

  const status = getSubscriptionStatus(data);
  if (
    plan !== "free" &&
    status !== null &&
    !["active", "trial", "trialing"].includes(status)
  ) {
    return "free";
  }

  if (plan !== "free" && isExpired(getSubscriptionExpiryValue(data))) {
    return "free";
  }

  return plan;
}

/** Returns the subscription expiry in an API-friendly ISO/string form. */
export function getSubscriptionExpiresAt(
  data: UserSubscriptionData,
): string | null {
  const value = getSubscriptionExpiryValue(data);
  if (typeof value === "string") return value;

  const timestamp = value as { toDate?: () => Date } | null;
  if (typeof timestamp?.toDate === "function") {
    return timestamp.toDate().toISOString();
  }

  return null;
}

export function getPlanLimits(plan: PlanId): PlanLimits {
  return PLAN_LIMITS[plan] ?? PLAN_LIMITS.free;
}

export function isScanTypeAllowed(plan: PlanId, scanType: string): boolean {
  return getPlanLimits(plan).allowedScanTypes.includes(scanType);
}
