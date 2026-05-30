export interface PlanLimits {
  scanCount: number;
  chatCount: number;
  videoCallMinutes: number;
  videoCallDailyMax: number;
}

export const PLAN_LIMITS: Record<string, PlanLimits> = {
  free: {
    scanCount: 20,
    chatCount: 100,
    videoCallMinutes: 15,
    videoCallDailyMax: 3,
  },
  pro: {
    scanCount: 200, // example
    chatCount: 1000, // example
    videoCallMinutes: 30, // 30 mins
    videoCallDailyMax: 10,
  },
  whitelist: {
    // User mentions whitelist
    scanCount: 99999,
    chatCount: 99999,
    videoCallMinutes: 120, // 2 hours
    videoCallDailyMax: 50,
  },
};
