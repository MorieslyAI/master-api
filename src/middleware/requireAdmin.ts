import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * Must run after `authenticate`. Admin access is determined from the signed
 * Firebase custom claim, so a client cannot promote itself through request data.
 */
export async function requireAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (request.user?.["role"] !== "admin") {
    reply.code(403).send({ error: "Akses khusus admin diperlukan." });
  }
}
