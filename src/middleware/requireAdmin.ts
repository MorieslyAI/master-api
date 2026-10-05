import type { FastifyReply, FastifyRequest } from "fastify";
import { getDb } from "../lib/firebase.js";

const COL_USERS = "users";

export async function requireAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const snap = await getDb().collection(COL_USERS).doc(request.user.uid).get();
  const data = snap.data() ?? {};
  const role = String(data["role"] ?? request.user["role"] ?? "user").toLowerCase();

  if (role !== "admin") {
    reply.code(403).send({
      error: "Akses ditolak. Endpoint ini hanya untuk Admin.",
      code: "ADMIN_REQUIRED",
    });
  }
}
