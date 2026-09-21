import { Timestamp } from "firebase-admin/firestore";
import { getDb } from "../lib/firebase.js";
import { env } from "../config/env.js";
import {
  fetchRevenueCatSubscriber,
  type RevenueCatSubscriber,
} from "../lib/revenuecat.js";
import type { PlanId } from "../config/plan.constants.js";
import { logger } from "../lib/logger.js";

const COL_USERS = "users";

// Events yang menandakan hak akses subscriber mungkin berubah dan perlu di-sync ulang.
// (dikirim RevenueCat sebagai event.type, lihat https://www.revenuecat.com/docs/webhooks/event-types)
const SYNCABLE_EVENT_TYPES = new Set([
  "INITIAL_PURCHASE",
  "RENEWAL",
  "PRODUCT_CHANGE",
  "CANCELLATION",
  "UNCANCELLATION",
  "EXPIRATION",
  "BILLING_ISSUE",
  "SUBSCRIPTION_PAUSED",
  "NON_RENEWING_PURCHASE",
  "TRANSFER",
]);

export interface RevenueCatWebhookEvent {
  type: string;
  app_user_id: string;
  original_app_user_id?: string;
  aliases?: string[];
  transferred_from?: string[];
  transferred_to?: string[];
  entitlement_ids?: string[];
}

function httpError(message: string, statusCode: number): Error {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = statusCode;
  return err;
}

/**
 * Memetakan set entitlement aktif RevenueCat ke satu PlanId aplikasi ini.
 * pro_max > pro > free. Expiry di ambil dari entitlement dengan masa aktif terlama
 * agar user tidak downgrade prematur saat entitlement lain sudah habis lebih dulu.
 */
function mapEntitlementsToPlan(subscriber: RevenueCatSubscriber): {
  plan: PlanId;
  expiresAt: string | null;
} {
  const now = Date.now();
  const isActive = (expiresDate: string | null): boolean =>
    expiresDate === null || new Date(expiresDate).getTime() > now;

  const proMax = subscriber.entitlements[env.REVENUECAT_ENTITLEMENT_PRO_MAX];
  if (proMax && isActive(proMax.expires_date)) {
    return { plan: "pro_max", expiresAt: proMax.expires_date };
  }

  const pro = subscriber.entitlements[env.REVENUECAT_ENTITLEMENT_PRO];
  if (pro && isActive(pro.expires_date)) {
    return { plan: "pro", expiresAt: pro.expires_date };
  }

  return { plan: "free", expiresAt: null };
}

/**
 * Menarik status subscriber terbaru dari RevenueCat lalu menuliskan plan efektifnya
 * ke Firestore users/{appUserId}. appUserId HARUS sama dengan Firebase UID (di-set
 * di client lewat Purchases.configure({ appUserID: firebaseUid })).
 */
export async function syncUserPlanFromRevenueCat(
  appUserId: string,
): Promise<void> {
  const db = getDb();
  const userRef = db.collection(COL_USERS).doc(appUserId);

  const userSnap = await userRef.get();
  if (!userSnap.exists) {
    // Bisa terjadi kalau user beli sebelum akun Firebase-nya sempat dibuat,
    // atau app_user_id di RevenueCat tidak sinkron dengan Firebase UID.
    logger.warn(
      { appUserId },
      "[revenuecat] Menerima event untuk user yang tidak ditemukan di Firestore.",
    );
    return;
  }

  const subscriber = await fetchRevenueCatSubscriber(appUserId);
  const { plan, expiresAt } = mapEntitlementsToPlan(subscriber);

  await userRef.set(
    {
      subscriptionPlan: plan,
      subscriptionExpiresAt: expiresAt,
      subscriptionSource: "revenuecat",
      revenueCatAppUserId: appUserId,
      subscriptionUpdatedAt: Timestamp.now(),
    },
    { merge: true },
  );

  logger.info({ appUserId, plan, expiresAt }, "[revenuecat] Plan disinkronkan.");
}

export async function handleRevenueCatWebhookEvent(
  event: RevenueCatWebhookEvent,
): Promise<void> {
  if (!SYNCABLE_EVENT_TYPES.has(event.type)) {
    logger.info({ type: event.type }, "[revenuecat] Event diabaikan (tidak relevan untuk plan).");
    return;
  }

  if (!event.app_user_id) {
    throw httpError('[revenuecat] Payload event tidak memiliki "app_user_id".', 400);
  }

  // Kumpulkan semua app_user_id yang mungkin terdampak (TRANSFER melibatkan 2 akun,
  // dan RevenueCat kadang mengirim beberapa alias untuk satu subscriber).
  const affectedUserIds = new Set<string>([event.app_user_id]);
  if (event.original_app_user_id) affectedUserIds.add(event.original_app_user_id);
  event.transferred_from?.forEach((id) => affectedUserIds.add(id));
  event.transferred_to?.forEach((id) => affectedUserIds.add(id));

  for (const userId of affectedUserIds) {
    await syncUserPlanFromRevenueCat(userId);
  }
}
