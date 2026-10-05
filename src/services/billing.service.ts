import { getDb } from "../lib/firebase.js";
import { getPlanLimits, getUserPlan } from "./plan.service.js";

const COL_USERS = "users";

function getDayKey(date = new Date()): string {
  return date.toISOString().split("T")[0];
}

export interface BillingStatus {
  plan: string;
  subscriptionExpiresAt: string | null;
  limits: ReturnType<typeof getPlanLimits>;
  usageToday: {
    scanCount: number;
    chatCount: number;
  };
}

export const billingService = {
  async getStatus(userId: string): Promise<BillingStatus> {
    const db = getDb();
    const userRef = db.collection(COL_USERS).doc(userId);

    const [userSnap, usageSnap] = await Promise.all([
      userRef.get(),
      userRef.collection("daily_usage").doc(getDayKey()).get(),
    ]);

    const userData = userSnap.data() ?? {};
    const plan = await getUserPlan(userId);
    const limits = getPlanLimits(plan);
    const usageData = usageSnap.data() ?? {};

    return {
      plan,
      subscriptionExpiresAt:
        typeof userData["subscriptionExpiresAt"] === "string"
          ? userData["subscriptionExpiresAt"]
          : null,
      limits,
      usageToday: {
        scanCount: Number(usageData["scanCount"] ?? 0),
        chatCount: Number(usageData["chatCount"] ?? 0),
      },
    };
  },
};
