import type { FastifyRequest, FastifyReply, preHandlerHookHandler } from "fastify";
import { getPlanLimits, getUserPlan } from "../services/plan.service.js";
import type { PlanLimits } from "../config/plan.constants.js";

/**
 * Fastify preHandler factory that 403s a request unless the user's current
 * plan satisfies `predicate`. Must run after `authenticate` (needs request.user).
 */
export function requirePlanFeature(
  predicate: (limits: PlanLimits) => boolean,
  message = "Fitur ini tidak tersedia di paket Anda saat ini. Upgrade untuk membuka akses.",
): preHandlerHookHandler {
  return async function planFeatureGate(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const plan = await getUserPlan(request.user.uid);
    const limits = getPlanLimits(plan);

    if (!predicate(limits)) {
      reply.code(403).send({
        error: message,
        code: "PLAN_UPGRADE_REQUIRED",
        currentPlan: plan,
      });
    }
  };
}
