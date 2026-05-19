import { Timestamp } from 'firebase-admin/firestore';
import { getDb } from '../lib/firebase.js';

// ─── Firestore Collection ────────────────────────────────────────────────────
const COL_USERS = 'users';

// ─── Activity Archetype Factors ───────────────────────────────────────────────
const ARCHETYPE_FACTORS: Record<string, number> = {
  desk: 1.2,
  field: 1.5,
  heavy: 1.9,
  custom: 1.0,
};

// ─── Goal Sugar Ratios ────────────────────────────────────────────────────────
const GOAL_RATIOS: Record<string, number> = {
  cut: 0.05,
  maintain: 0.10,
  bulk: 0.15,
  custom: 0.09,
};

// ─── DTOs ─────────────────────────────────────────────────────────────────────
export interface CalibrationDTO {
  // Step 1: Identity
  name: string;
  gender: 'male' | 'female';
  age: number;
  height: number; // cm
  weight: number; // kg

  // Step 2: Calibration / activity level
  archetypeId: 'desk' | 'field' | 'heavy' | 'custom';
  dailySteps?: number;
  workoutFreq?: number;
  workoutIntensity?: 'low' | 'mod' | 'high';

  // Step 3: Medical Intel
  medicalConditions: string[];

  // Step 4: Mission Profile
  goalMode: 'cut' | 'maintain' | 'bulk' | 'custom';
  customSugarLimit?: number;

  // Manual sugar override
  isManualSugarOverride?: boolean;
}

// ─── Settings Update DTO ──────────────────────────────────────────────────────
// Semua field optional — hanya field yang dikirim yang diupdate.
export interface UpdateSettingsDTO {
  // Identity
  name?: string;
  gender?: 'male' | 'female';
  age?: number;
  height?: number;
  weight?: number;

  // Engine
  archetypeId?: 'desk' | 'field' | 'heavy' | 'custom';
  goalMode?: 'cut' | 'maintain' | 'bulk' | 'custom';
  customSugarLimit?: number;
  isManualSugarOverride?: boolean;

  // Mission
  eventName?: string;
  targetWeight?: number;
  targetDate?: string;

  // Account
  isWearableConnected?: boolean;
}

export interface UserProfileResponse {
  userId: string;
  email: string;
  displayName: string;
  role: string;
  isCalibrationComplete: boolean;
  createdAt?: string;

  streak: number;
  lastCheckInDate: string | null;
  currentXp: number;
  level: number;
  nextLevelXp: number;
  rankTitle: string;

  isWearableConnected: boolean;

  profile?: {
    name: string;
    gender: 'male' | 'female';
    age: number;
    height: number;
    weight: number;

    archetypeId: string;
    dailySteps?: number | null;
    workoutFreq?: number | null;
    workoutIntensity?: string | null;

    medicalConditions: string[];

    goalMode: string;
    customSugarLimit?: number | null;
    isManualSugarOverride?: boolean;
    sugarLimit: number;
    calibratedAt?: string;

    mission?: {
      eventName?: string;
      targetWeight?: number;
      targetDate?: string;
    };
  };
}

export interface CheckInXpState {
  currentXp: number;
  level: number;
  nextLevelXp: number;
  rankTitle: string;
}

export interface CheckInResult {
  alreadyCheckedIn: boolean;
  streak: number;
  lastCheckInDate: string;
  currentXp: number;
  level: number;
  nextLevelXp: number;
  rankTitle: string;
}

// ─── Error Helper ─────────────────────────────────────────────────────────────
function httpError(message: string, statusCode: number): Error {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = statusCode;
  return err;
}

// ─── Date Helper ──────────────────────────────────────────────────────────────
function toIsoString(value: any): string | undefined {
  if (!value) return undefined;

  if (typeof value === 'string') return value;

  if (typeof value.toDate === 'function') {
    return value.toDate().toISOString();
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  return undefined;
}

// ─── Sugar Limit Calculator ──────────────────────────────────────────────────
// Replikasi logika kalkulasi dari FE / SetupScreen.tsx
function computeSugarLimit(dto: CalibrationDTO): number {
  const shouldUseManualLimit =
    dto.isManualSugarOverride === true ||
    (dto.isManualSugarOverride === undefined && dto.goalMode === 'custom');

  if (
    shouldUseManualLimit &&
    dto.customSugarLimit &&
    dto.customSugarLimit > 0
  ) {
    return dto.customSugarLimit;
  }

  const a = dto.age || 30;
  const h = dto.height || 170;
  const w = dto.weight || 70;

  // Mifflin-St Jeor BMR
  const genderOffset = dto.gender === 'male' ? 5 : -161;
  const bmr = 10 * w + 6.25 * h - 5 * a + genderOffset;

  // Activity factor
  let activityFactor: number;

  if (dto.archetypeId === 'custom') {
    let base = 1.15;

    const steps = dto.dailySteps || 0;
    base += (steps / 1000) * 0.03;

    const freq = dto.workoutFreq || 0;

    let intensityMult = 0.03;
    if (dto.workoutIntensity === 'mod') intensityMult = 0.06;
    if (dto.workoutIntensity === 'high') intensityMult = 0.1;

    base += freq * intensityMult;

    activityFactor = Math.min(2.4, Math.max(1.1, base));
  } else {
    activityFactor = ARCHETYPE_FACTORS[dto.archetypeId] ?? 1.2;
  }

  const tdee = bmr * activityFactor;

  // Sugar ratio berdasarkan goal
  let sugarRatio = GOAL_RATIOS[dto.goalMode] ?? 0.1;

  const medicalConditions = dto.medicalConditions ?? [];

  // Medical penalty — reduce sugar ratio based on health conditions
  if (medicalConditions.includes('diabetes')) {
    sugarRatio = 0.03;
  } else if (medicalConditions.includes('prediabetes')) {
    sugarRatio = 0.04;
  } else if (medicalConditions.includes('pcos')) {
    sugarRatio = 0.05;
  } else if (
    medicalConditions.includes('hypertension') ||
    medicalConditions.includes('cholesterol')
  ) {
    sugarRatio = 0.06;
  } else if (medicalConditions.length > 0) {
    sugarRatio = Math.max(0.05, sugarRatio - 0.02);
  }

  // 4 kcal per gram of sugar
  const grams = Math.round((tdee * sugarRatio) / 4);

  return Math.max(5, Math.min(100, grams));
}

// ─── User Service ─────────────────────────────────────────────────────────────
export const userService = {
  async saveCalibration(
    userId: string,
    dto: CalibrationDTO
  ): Promise<{ sugarLimit: number }> {
    const db = getDb();
    const userRef = db.collection(COL_USERS).doc(userId);

    const userDoc = await userRef.get();
    if (!userDoc.exists) throw httpError('User not found.', 404);

    const sugarLimit = computeSugarLimit(dto);
    const now = Timestamp.now();

    const isManualSugarOverride =
      dto.isManualSugarOverride ??
      Boolean(dto.goalMode === 'custom' && dto.customSugarLimit && dto.customSugarLimit > 0);

    await userRef.update({
      displayName: dto.name,
      isCalibrationComplete: true,
      updatedAt: now,
      profile: {
        name: dto.name,
        gender: dto.gender,
        age: dto.age,
        height: dto.height,
        weight: dto.weight,

        archetypeId: dto.archetypeId,
        dailySteps: dto.dailySteps ?? null,
        workoutFreq: dto.workoutFreq ?? null,
        workoutIntensity: dto.workoutIntensity ?? null,

        medicalConditions: dto.medicalConditions ?? [],

        goalMode: dto.goalMode,
        customSugarLimit: dto.customSugarLimit ?? null,
        isManualSugarOverride,
        sugarLimit,
        calibratedAt: now,
      },
    });

    return { sugarLimit };
  },

  async getFullProfile(userId: string): Promise<UserProfileResponse> {
    const doc = await getDb().collection(COL_USERS).doc(userId).get();

    if (!doc.exists) throw httpError('User not found.', 404);

    const data = doc.data() as Record<string, any>;

    const result: UserProfileResponse = {
      userId: doc.id,
      email: data['email'],
      displayName: data['displayName'],
      role: data['role'],
      isCalibrationComplete: data['isCalibrationComplete'] ?? false,
      createdAt: toIsoString(data['createdAt']),

      streak: data['streak'] ?? 0,
      lastCheckInDate: data['lastCheckInDate'] ?? null,
      currentXp: data['currentXp'] ?? 0,
      level: data['level'] ?? 1,
      nextLevelXp: data['nextLevelXp'] ?? 100,
      rankTitle: data['rankTitle'] ?? 'Rookie Agent',

      isWearableConnected: data['isWearableConnected'] ?? false,
    };

    if (data['profile']) {
      const p = data['profile'];

      result.profile = {
        name: p.name,
        gender: p.gender,
        age: p.age,
        height: p.height,
        weight: p.weight,

        archetypeId: p.archetypeId,
        dailySteps: p.dailySteps ?? null,
        workoutFreq: p.workoutFreq ?? null,
        workoutIntensity: p.workoutIntensity ?? null,

        medicalConditions: p.medicalConditions ?? [],

        goalMode: p.goalMode,
        customSugarLimit: p.customSugarLimit ?? null,
        isManualSugarOverride: p.isManualSugarOverride ?? false,
        sugarLimit: p.sugarLimit,
        calibratedAt: toIsoString(p.calibratedAt),

        mission: {
          eventName: p.mission?.eventName,
          targetWeight: p.mission?.targetWeight,
          targetDate: p.mission?.targetDate,
        },
      };
    }

    return result;
  },

  async checkIn(
    userId: string,
    xpState?: CheckInXpState
  ): Promise<CheckInResult> {
    const db = getDb();
    const userRef = db.collection(COL_USERS).doc(userId);

    const userDoc = await userRef.get();
    if (!userDoc.exists) throw httpError('User not found.', 404);

    const data = userDoc.data() as Record<string, any>;

    const today = new Date().toISOString().split('T')[0];
    const lastCheckIn = (data['lastCheckInDate'] as string | undefined) ?? null;
    const currentStreak = (data['streak'] as number | undefined) ?? 0;

    // XP values to save, from FE request body or fallback to Firestore values
    const xpToSave = {
      currentXp: xpState?.currentXp ?? data['currentXp'] ?? 0,
      level: xpState?.level ?? data['level'] ?? 1,
      nextLevelXp: xpState?.nextLevelXp ?? data['nextLevelXp'] ?? 100,
      rankTitle: xpState?.rankTitle ?? data['rankTitle'] ?? 'Rookie Agent',
    };

    // Already checked in today — still sync latest XP if provided
    if (lastCheckIn === today) {
      if (xpState) {
        await userRef.update({
          ...xpToSave,
          updatedAt: Timestamp.now(),
        });
      }

      return {
        alreadyCheckedIn: true,
        streak: currentStreak,
        lastCheckInDate: today,
        ...xpToSave,
      };
    }

    // Hitung streak baru
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split('T')[0];

    const newStreak = lastCheckIn === yesterdayStr ? currentStreak + 1 : 1;

    await userRef.update({
      streak: newStreak,
      lastCheckInDate: today,
      updatedAt: Timestamp.now(),
      ...xpToSave,
    });

    return {
      alreadyCheckedIn: false,
      streak: newStreak,
      lastCheckInDate: today,
      ...xpToSave,
    };
  },

  async updateSettings(
    userId: string,
    dto: UpdateSettingsDTO
  ): Promise<{ sugarLimit?: number }> {
    const db = getDb();
    const userRef = db.collection(COL_USERS).doc(userId);

    const userDoc = await userRef.get();
    if (!userDoc.exists) throw httpError('User not found.', 404);

    const data = userDoc.data() as Record<string, any>;
    const existingProfile = data['profile'] ?? {};

    const now = Timestamp.now();

    const updates: Record<string, any> = {
      updatedAt: now,
    };

    const profilePatch: Record<string, any> = {};

    // ── Identity fields ────────────────────────────────────────────────────
    if (dto.name !== undefined) {
      profilePatch['name'] = dto.name;
      updates['displayName'] = dto.name;
    }

    if (dto.gender !== undefined) profilePatch['gender'] = dto.gender;
    if (dto.age !== undefined) profilePatch['age'] = dto.age;
    if (dto.height !== undefined) profilePatch['height'] = dto.height;
    if (dto.weight !== undefined) profilePatch['weight'] = dto.weight;

    // ── Engine fields ──────────────────────────────────────────────────────
    if (dto.archetypeId !== undefined) {
      profilePatch['archetypeId'] = dto.archetypeId;
    }

    if (dto.goalMode !== undefined) {
      profilePatch['goalMode'] = dto.goalMode;
    }

    if (dto.customSugarLimit !== undefined) {
      profilePatch['customSugarLimit'] = dto.customSugarLimit;
    }

    if (dto.isManualSugarOverride !== undefined) {
      profilePatch['isManualSugarOverride'] = dto.isManualSugarOverride;
    }

    // ── Mission fields ─────────────────────────────────────────────────────
    if (dto.eventName !== undefined) {
      profilePatch['mission.eventName'] = dto.eventName;
    }

    if (dto.targetWeight !== undefined) {
      profilePatch['mission.targetWeight'] = dto.targetWeight;
    }

    if (dto.targetDate !== undefined) {
      profilePatch['mission.targetDate'] = dto.targetDate;
    }

    // ── Account fields ─────────────────────────────────────────────────────
    if (dto.isWearableConnected !== undefined) {
      updates['isWearableConnected'] = dto.isWearableConnected;
    }

    // ── Recalculate sugar limit if biometric / engine data changed ─────────
    let sugarLimit: number | undefined;

    const biometricChanged =
      dto.name !== undefined ||
      dto.gender !== undefined ||
      dto.age !== undefined ||
      dto.height !== undefined ||
      dto.weight !== undefined ||
      dto.archetypeId !== undefined ||
      dto.goalMode !== undefined ||
      dto.customSugarLimit !== undefined ||
      dto.isManualSugarOverride !== undefined;

    if (biometricChanged) {
      const merged: CalibrationDTO = {
        name: dto.name ?? existingProfile.name ?? '',
        gender: dto.gender ?? existingProfile.gender ?? 'male',
        age: dto.age ?? existingProfile.age ?? 30,
        height: dto.height ?? existingProfile.height ?? 170,
        weight: dto.weight ?? existingProfile.weight ?? 70,

        archetypeId:
          dto.archetypeId ?? existingProfile.archetypeId ?? 'desk',

        dailySteps: existingProfile.dailySteps ?? undefined,
        workoutFreq: existingProfile.workoutFreq ?? undefined,
        workoutIntensity: existingProfile.workoutIntensity ?? undefined,

        medicalConditions: existingProfile.medicalConditions ?? [],

        goalMode: dto.goalMode ?? existingProfile.goalMode ?? 'maintain',

        customSugarLimit:
          dto.customSugarLimit ??
          existingProfile.customSugarLimit ??
          undefined,

        isManualSugarOverride:
          dto.isManualSugarOverride ??
          existingProfile.isManualSugarOverride ??
          false,
      };

      sugarLimit = computeSugarLimit(merged);
      profilePatch['sugarLimit'] = sugarLimit;
    }

    // ── Apply profile patch using Firestore dot notation ───────────────────
    if (Object.keys(profilePatch).length > 0) {
      for (const [key, value] of Object.entries(profilePatch)) {
        updates[`profile.${key}`] = value;
      }
    }

    await userRef.update(updates);

    return sugarLimit !== undefined ? { sugarLimit } : {};
  },
};