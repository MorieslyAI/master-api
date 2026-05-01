import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

// ─── Socket Token ─────────────────────────────────────────────────────────────
// Access token sekarang ditangani oleh Firebase Authentication (ID Token).
// File ini hanya menyimpan logika socket token untuk Gemini Live / WebSocket.

export type SocketScope = 'chat' | 'video' | 'all';

export interface SocketTokenPayload {
  sub:   string; // userId (Firebase UID)
  jti:   string; // unique ID → untuk blacklist di Redis (future)
  scope: SocketScope;
  type:  'socket';
  iat?:  number;
  exp?:  number;
}

export function signSocketToken(
  userId: string,
  jti:    string,
  scope:  SocketScope = 'all'
): string {
  return jwt.sign(
    { sub: userId, jti, scope, type: 'socket' },
    env.JWT_SOCKET_SECRET,
    { expiresIn: `${env.SOCKET_TOKEN_EXPIRES_IN}s`, issuer: 'master-api' } as any
  );
}

export function verifySocketToken(token: string): SocketTokenPayload {
  return jwt.verify(token, env.JWT_SOCKET_SECRET, {
    issuer: 'master-api',
  }) as SocketTokenPayload;
}
