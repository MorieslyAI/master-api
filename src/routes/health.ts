import type { FastifyInstance } from 'fastify';
import { getDb } from '../lib/firebase.js';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async (_request, reply) => {
    const checks: Record<string, 'ok' | 'error'> = {
      api:       'ok',
      firestore: 'ok',
    };

    try {
      await getDb().collection('_health').limit(1).get();
    } catch {
      checks.firestore = 'error';
    }

    const allOk = Object.values(checks).every((v) => v === 'ok');

    return reply.code(allOk ? 200 : 503).send({
      status:    allOk ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      uptime:    Math.floor(process.uptime()),
      checks,
    });
  });
}
