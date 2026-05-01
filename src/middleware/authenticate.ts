import type { FastifyRequest, FastifyReply } from 'fastify';
import { getAuth } from 'firebase-admin/auth';

// Verifies the Firebase ID Token from the Authorization: Bearer <token> header
export async function authenticate(
  request: FastifyRequest,
  reply:   FastifyReply
): Promise<void> {
  const authHeader = request.headers['authorization'];

  if (!authHeader?.startsWith('Bearer ')) {
    reply.code(401).send({
      error: 'Token not found. Include the Authorization: Bearer <token> header.',
    });
    return;
  }

  const token = authHeader.slice(7);

  try {
    request.user = await getAuth().verifyIdToken(token);
  } catch (err: unknown) {
    const firebaseErr = err as { code?: string };
    const isExpired   = firebaseErr.code === 'auth/id-token-expired';
    const isRevoked   = firebaseErr.code === 'auth/id-token-revoked';

    reply.code(401).send({
      error: isExpired
        ? 'Token has expired.'
        : isRevoked
          ? 'Session is invalid. Please log in again.'
          : 'Invalid token.',
      ...(isExpired && { code: 'TOKEN_EXPIRED' }),
    });
  }
}
