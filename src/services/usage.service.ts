import { FieldValue } from "firebase-admin/firestore";
import { getDb } from "../lib/firebase.js";
import { PLAN_LIMITS } from "../config/plan.constants.js";

function getDayKey(date = new Date()): string {
  return date.toISOString().split("T")[0]; // '2026-05-27'
}

export async function checkAndIncrementUsage(
  userId: string,
  type: "scan" | "chat",
): Promise<{ allowed: boolean; remaining: number; limit: number }> {
  const db = getDb();
  const dayKey = getDayKey();

  // 1. Dapatkan role/plan user terlebih dahulu
  const userRef = db.collection("users").doc(userId);
  const userSnap = await userRef.get();
  const userData = userSnap.data() || {};
  const subscriptionPlan = String(
    userData["subscriptionPlan"] || userData["plan"] || "free",
  );
  const role = String(userData["role"] || "user");

  let currentPlan = subscriptionPlan;
  if (role === "admin" || role === "whitelist") {
    currentPlan = "whitelist";
  }

  const limits = PLAN_LIMITS[currentPlan] || PLAN_LIMITS.free;
  const targetLimit = type === "scan" ? limits.scanCount : limits.chatCount;

  // 2. Dapatkan atau update usage di transaksi
  const usageRef = userRef.collection("daily_usage").doc(dayKey);

  return db.runTransaction(async (transaction) => {
    const doc = await transaction.get(usageRef);
    let currentUsage = 0;

    if (doc.exists) {
      const data = doc.data();
      currentUsage = data?.[`${type}Count`] || 0;
    }

    if (currentUsage >= targetLimit) {
      return { allowed: false, remaining: 0, limit: targetLimit };
    }

    // Eksekusi penambahan counter
    transaction.set(
      usageRef,
      {
        [`${type}Count`]: FieldValue.increment(1),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    return {
      allowed: true,
      remaining: targetLimit - currentUsage - 1,
      limit: targetLimit,
    };
  });
}
