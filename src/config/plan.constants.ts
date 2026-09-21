export type PlanId = "free" | "pro" | "pro_max" | "whitelist";

export interface PlanLimits {
  /** Batas scan AI per hari. */
  scanCount: number;
  /** scanMode yang boleh dipakai plan ini (food, drink, receipt, versus, label, qr, skin). */
  allowedScanTypes: string[];
  /** Batas pesan AI chat per hari. */
  chatCount: number;
  /** Total durasi video call (menit) per bulan. 0 = fitur tidak tersedia. */
  videoCallMinutesPerMonth: number;
  /** Retensi history (hari). null = unlimited. */
  historyRetentionDays: number | null;
  /** Batas feed generation. null = unlimited, 0 = tidak tersedia. */
  feedGenerationLimit: number | null;
  /** Durasi maksimal diet plan (minggu). 0 = tidak tersedia. */
  dietPlanWeeks: number;
  /** Durasi maksimal training plan (minggu). 0 = tidak tersedia. */
  trainingPlanWeeks: number;
  sugarSpikeForecasting: boolean;
  analyticsLevel: "basic" | "detailed" | "advanced";
  adFree: boolean;
  customGoals: boolean;
  betaAccess: boolean;
  prioritySupport: boolean;
  dataExport: boolean;
}

const ALL_SCAN_TYPES = [
  "food",
  "drink",
  "receipt",
  "versus",
  "label",
  "qr",
  "skin",
];

export const PLAN_LIMITS: Record<PlanId, PlanLimits> = {
  free: {
    scanCount: 5,
    allowedScanTypes: ["food"],
    chatCount: 0,
    videoCallMinutesPerMonth: 0,
    historyRetentionDays: 7,
    feedGenerationLimit: 0,
    dietPlanWeeks: 0,
    trainingPlanWeeks: 0,
    sugarSpikeForecasting: false,
    analyticsLevel: "basic",
    adFree: false,
    customGoals: false,
    betaAccess: false,
    prioritySupport: false,
    dataExport: false,
  },
  pro: {
    scanCount: 50,
    allowedScanTypes: ALL_SCAN_TYPES,
    chatCount: 100,
    videoCallMinutesPerMonth: 60,
    historyRetentionDays: 365,
    feedGenerationLimit: 0,
    dietPlanWeeks: 4,
    trainingPlanWeeks: 4,
    sugarSpikeForecasting: true,
    analyticsLevel: "detailed",
    adFree: true,
    customGoals: false,
    betaAccess: false,
    prioritySupport: false,
    dataExport: false,
  },
  pro_max: {
    scanCount: 100,
    allowedScanTypes: ALL_SCAN_TYPES,
    chatCount: 500,
    videoCallMinutesPerMonth: 300,
    historyRetentionDays: null,
    feedGenerationLimit: null,
    dietPlanWeeks: 12,
    trainingPlanWeeks: 12,
    sugarSpikeForecasting: true,
    analyticsLevel: "advanced",
    adFree: true,
    customGoals: true,
    betaAccess: true,
    prioritySupport: true,
    dataExport: true,
  },
  // Role internal (admin / whitelisted tester) — dibuka penuh, tidak terkait RevenueCat.
  whitelist: {
    scanCount: 99999,
    allowedScanTypes: ALL_SCAN_TYPES,
    chatCount: 99999,
    videoCallMinutesPerMonth: 99999,
    historyRetentionDays: null,
    feedGenerationLimit: null,
    dietPlanWeeks: 12,
    trainingPlanWeeks: 12,
    sugarSpikeForecasting: true,
    analyticsLevel: "advanced",
    adFree: true,
    customGoals: true,
    betaAccess: true,
    prioritySupport: true,
    dataExport: true,
  },
};

export function isPlanId(value: string): value is PlanId {
  return Object.prototype.hasOwnProperty.call(PLAN_LIMITS, value);
}
