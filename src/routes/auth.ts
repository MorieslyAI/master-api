import type { FastifyInstance, FastifyReply } from 'fastify';
import { authService, type GoogleSignInDTO } from '../services/auth.service.js';
import { authenticate } from '../middleware/authenticate.js';
import { env } from '../config/env.js';

const REFRESH_COOKIE = 'refresh_token';
const COOKIE_PATH    = '/auth/refresh'; // Cookie hanya dikirim ke endpoint refresh

function refreshCookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    secure:   env.NODE_ENV === 'production',
    sameSite: 'strict' as const,
    path:     COOKIE_PATH,
    maxAge,   // detik
  };
}

// ─── Route Error Handler ──────────────────────────────────────────────────────

function handleError(err: unknown, reply: FastifyReply): void {
  const e = err as Error & { statusCode?: number };
  reply.code(e.statusCode ?? 500).send({ error: e.message ?? 'An internal server error occurred.' });
}

// ─── Auth Routes ─────────────────────────────────────────────────────────────

export async function authRoutes(app: FastifyInstance): Promise<void> {

  // ── POST /auth/register ────────────────────────────────────────────────────
  // Membuat akun baru via Firebase Authentication.
  // Mengembalikan Firebase ID Token (accessToken) + menyimpan refreshToken di cookie.
  app.post<{ Body: { email: string; password: string; displayName?: string } }>(
    '/auth/register',
    {
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      schema: {
        body: {
          type:     'object',
          required: ['email', 'password'],
          properties: {
            email:       { type: 'string', minLength: 5, maxLength: 255 },
            password:    { type: 'string', minLength: 6,  maxLength: 128 },
            displayName: { type: 'string', maxLength: 80 },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const tokens = await authService.register(request.body);

        reply.setCookie(
          REFRESH_COOKIE,
          tokens.refreshToken,
          refreshCookieOptions(env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60)
        );

        return reply.code(201).send({
          accessToken: tokens.accessToken,
          expiresIn:   tokens.expiresIn,
        });
      } catch (err) {
        return handleError(err, reply);
      }
    }
  );

  // ── POST /auth/login ───────────────────────────────────────────────────────
  // Login via Firebase Authentication.
  // Mengembalikan Firebase ID Token (accessToken) + menyimpan refreshToken di cookie.
  app.post<{ Body: { email: string; password: string } }>(
    '/auth/login',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        body: {
          type:     'object',
          required: ['email', 'password'],
          properties: {
            email:    { type: 'string', minLength: 5 },
            password: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const tokens = await authService.login(request.body);

        reply.setCookie(
          REFRESH_COOKIE,
          tokens.refreshToken,
          refreshCookieOptions(env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60)
        );

        return reply.send({
          accessToken: tokens.accessToken,
          expiresIn:   tokens.expiresIn,
        });
      } catch (err) {
        return handleError(err, reply);
      }
    }
  );

  // ── POST /auth/google ──────────────────────────────────────────────────────
  // Login / register via Google.
  // FE melakukan Google Sign-In dengan Firebase Client SDK, lalu kirim hasilnya ke sini.
  // BE memverifikasi token, membuat profil Firestore jika user baru, lalu set cookie.
  app.post<{ Body: GoogleSignInDTO }>(
    '/auth/google',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        body: {
          type:     'object',
          required: ['idToken', 'refreshToken'],
          properties: {
            idToken:      { type: 'string', minLength: 1 },
            refreshToken: { type: 'string', minLength: 1 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      try {
        const tokens = await authService.googleSignIn(request.body);

        reply.setCookie(
          REFRESH_COOKIE,
          tokens.refreshToken,
          refreshCookieOptions(env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60)
        );

        const statusCode = tokens.isNewUser ? 201 : 200;
        return reply.code(statusCode).send({
          accessToken: tokens.accessToken,
          expiresIn:   tokens.expiresIn,
          isNewUser:   tokens.isNewUser,
        });
      } catch (err) {
        return handleError(err, reply);
      }
    }
  );

  // ── POST /auth/refresh ─────────────────────────────────────────────────────
  // Menukar Firebase refresh token (dari cookie httpOnly) dengan ID Token baru.
  // Firebase refresh token dirotasi otomatis setiap kali digunakan.
  app.post(
    '/auth/refresh',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const refreshToken = request.cookies?.[REFRESH_COOKIE];

      if (!refreshToken) {
        return reply.code(401).send({ error: 'Refresh token not found.' });
      }

      try {
        const tokens = await authService.refresh(refreshToken);

        reply.setCookie(
          REFRESH_COOKIE,
          tokens.refreshToken,
          refreshCookieOptions(env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60)
        );

        return reply.send({
          accessToken: tokens.accessToken,
          expiresIn:   tokens.expiresIn,
        });
      } catch (err) {
        reply.clearCookie(REFRESH_COOKIE, { path: COOKIE_PATH });
        return handleError(err, reply);
      }
    }
  );

  // ── POST /auth/logout ──────────────────────────────────────────────────────
  // Mencabut semua refresh token user di Firebase Auth + menghapus cookie.
  // Butuh access token yang valid agar bisa mendapatkan UID untuk revoke.
  app.post(
    '/auth/logout',
    { preHandler: authenticate },
    async (request, reply) => {
      try {
        await authService.logout(request.user.uid);
      } catch {
        // Tetap lanjut logout meski revoke gagal
      }

      reply.clearCookie(REFRESH_COOKIE, { path: COOKIE_PATH });
      return reply.send({ message: 'Berhasil logout.' });
    }
  );

  // ── POST /auth/socket-token ────────────────────────────────────────────────
  // Mengembalikan short-lived JWT untuk koneksi WebSocket / Gemini Live.
  app.post<{ Body?: { scope?: 'chat' | 'video' | 'all' } }>(
    '/auth/socket-token',
    {
      preHandler: authenticate,
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: {
        body: {
          type: 'object',
          properties: {
            scope: { type: 'string', enum: ['chat', 'video', 'all'] },
          },
        },
      },
    },
    async (request, reply) => {
      const { uid: userId, email = '' } = request.user;
      const role  = (request.user['role'] as string) ?? 'user';
      const scope = request.body?.scope ?? 'all';

      try {
        const socketToken = await authService.issueSocketToken(userId, email, role, scope);
        return reply.send({
          socketToken,
          expiresIn: env.SOCKET_TOKEN_EXPIRES_IN,
          scope,
        });
      } catch (err) {
        return handleError(err, reply);
      }
    }
  );

  // ── GET /auth/me ───────────────────────────────────────────────────────────
  // Mengembalikan profil user dari Firestore (termasuk flag isCalibrationComplete).
  app.get(
    '/auth/me',
    { preHandler: authenticate },
    async (request, reply) => {
      try {
        const profile = await authService.getProfile(request.user.uid);
        return reply.send(profile);
      } catch (err) {
        return handleError(err, reply);
      }
    }
  );
}
