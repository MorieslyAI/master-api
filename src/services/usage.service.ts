import { FieldValue } from "firebase-admin/firestore";
import { getDb } from "../lib/firebase.js";
import { getPlanLimits, getUserPlan } from "./plan.service.js";

function getDayKey(date = new Date()): string {
  return date.toISOString().split("T")[0]; // '2026-05-27'
}

export async function checkAndIncrementUsage(
  userId: string,
  type: "scan" | "chat",
): Promise<{ allowed: boolean; remaining: number; limit: number }> {
  const db = getDb();
  const dayKey = getDayKey();

  const plan = await getUserPlan(userId);
  const limits = getPlanLimits(plan);
  const targetLimit = type === "scan" ? limits.scanCount : limits.chatCount;

  const usageRef = db
    .collection("users")
    .doc(userId)
    .collection("daily_usage")
    .doc(dayKey);

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
