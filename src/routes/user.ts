import type { FastifyInstance, FastifyReply } from 'fastify';
import { userService, type CalibrationDTO, type CheckInXpState, type UpdateSettingsDTO } from '../services/user.service.js';
import { authenticate } from '../middleware/authenticate.js';

// ─── Route Error Handler ──────────────────────────────────────────────────────

function handleError(err: unknown, reply: FastifyReply): void {
  const e = err as Error & { statusCode?: number };
  reply.code(e.statusCode ?? 500).send({ error: e.message ?? 'An internal server error occurred.' });
}

// ─── User Routes ──────────────────────────────────────────────────────────────

export async function userRoutes(app: FastifyInstance): Promise<void> {

  // ── POST /user/calibration ─────────────────────────────────────────────────
  // Saves user calibration data (Steps 1-4 from SetupScreen).
  // Must be called after register/login if isCalibrationComplete === false.
  app.post<{ Body: CalibrationDTO }>(
    '/user/calibration',
    {
      preHandler: authenticate,
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        body: {
          type:     'object',
          required: ['name', 'gender', 'age', 'height', 'weight', 'archetypeId', 'medicalConditions', 'goalMode'],
          properties: {
            // Step 1: Identity
            name:   { type: 'string', minLength: 1, maxLength: 80 },
            gender: { type: 'string', enum: ['male', 'female'] },
            age:    { type: 'number', minimum: 1,  maximum: 120 },
            height: { type: 'number', minimum: 50, maximum: 300 },
            weight: { type: 'number', minimum: 1,  maximum: 500 },

            // Step 2: Calibration
            archetypeId:      { type: 'string', enum: ['desk', 'field', 'heavy', 'custom'] },
            dailySteps:       { type: 'number', minimum: 0 },
            workoutFreq:      { type: 'number', minimum: 0, maximum: 7 },
            workoutIntensity: { type: 'string', enum: ['low', 'mod', 'high'] },

            // Step 3: Medical
            medicalConditions: {
              type:  'array',
              items: { type: 'string' },
              maxItems: 20,
            },

            // Step 4: Mission
            goalMode:         { type: 'string', enum: ['cut', 'maintain', 'bulk', 'custom'] },
            customSugarLimit: { type: 'number', minimum: 1, maximum: 500 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      try {
        const { sugarLimit } = await userService.saveCalibration(request.user.uid, request.body);
        return reply.code(200).send({
          message:    'Calibration saved successfully.',
          sugarLimit,
        });
      } catch (err) {
        return handleError(err, reply);
      }
    }
  );

  // ── GET /user/profile ──────────────────────────────────────────────────────
  // Returns the full user profile including calibration data, streak, and lastCheckInDate.
  app.get(
    '/user/profile',
    {
      preHandler: authenticate,
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      try {
        const profile = await userService.getFullProfile(request.user.uid);
        return reply.send(profile);
      } catch (err) {
        return handleError(err, reply);
      }
    }
  );

  // ── POST /user/checkin ─────────────────────────────────────────────────────
  // Performs daily check-in: computes streak and saves XP to Firestore.
  // XP body is optional — if provided, it is saved to Firestore alongside the streak.
  // Safe to call repeatedly — if already checked in today, returns alreadyCheckedIn: true.
  app.post<{ Body: Partial<CheckInXpState> }>(
    '/user/checkin',
    {
      preHandler: authenticate,
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      schema: {
        body: {
          type: 'object',
          properties: {
            currentXp:   { type: 'number', minimum: 0 },
            level:       { type: 'number', minimum: 1, maximum: 100 },
            nextLevelXp: { type: 'number', minimum: 1 },
            rankTitle:   { type: 'string', maxLength: 80 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      try {
        const body = request.body as Partial<CheckInXpState>;
        const hasXp = body.currentXp !== undefined || body.level !== undefined;
        const result = await userService.checkIn(
          request.user.uid,
          hasXp ? (body as CheckInXpState) : undefined,
        );
        return reply.send(result);
      } catch (err) {
        return handleError(err, reply);
      }
    }
  );

  // ── PUT /user/settings ───────────────────────────────────────────────────────────
  // Partial-update user profile & mission settings from SettingsScreen.
  // All body fields are optional — only provided fields are updated in Firestore.
  app.put<{ Body: UpdateSettingsDTO }>(
    '/user/settings',
    {
      preHandler: authenticate,
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            // Identity
            name:                { type: 'string', minLength: 1, maxLength: 80 },
            gender:              { type: 'string', enum: ['male', 'female'] },
            age:                 { type: 'number', minimum: 1,  maximum: 120 },
            height:              { type: 'number', minimum: 50, maximum: 300 },
            weight:              { type: 'number', minimum: 1,  maximum: 500 },
            // Engine
            archetypeId:         { type: 'string', enum: ['desk', 'field', 'heavy', 'custom'] },
            goalMode:            { type: 'string', enum: ['cut', 'maintain', 'bulk', 'custom'] },
            customSugarLimit:    { type: 'number', minimum: 1,  maximum: 500 },
            // Mission
            eventName:           { type: 'string', maxLength: 120 },
            targetWeight:        { type: 'number', minimum: 1,  maximum: 500 },
            targetDate:          { type: 'string' },
            // Account
            isWearableConnected: { type: 'boolean' },
            isManualSugarOverride: { type: 'boolean' },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const result = await userService.updateSettings(request.user.uid, request.body);
        return reply.send({
          message: 'Settings updated.',
          ...(result.sugarLimit !== undefined && { sugarLimit: result.sugarLimit }),
        });
      } catch (err) {
        return handleError(err, reply);
      }
    }
  );
}
