import type { DecodedIdToken } from 'firebase-admin/auth';

declare module 'fastify' {
  interface FastifyRequest {
    /** Di-set oleh middleware `authenticate` setelah Firebase ID Token diverifikasi */
    user: DecodedIdToken;
  }
}
