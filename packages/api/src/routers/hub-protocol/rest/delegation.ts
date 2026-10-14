/**
 * Hub Protocol REST — refresh an IS delegation (D4, SECURITY-PLAN-R1 §3).
 *
 *   POST /delegation/refresh   Authorization: Bearer <current is_delegation>
 *     → 200 { token, expiresAt, maxExpiresAt }   (unix seconds)
 *     → 401 { reason: "expired" }      the token is past its life or max_exp
 *     → 401 { reason: "key_revoked" }  not a delegation this pod verifies
 *
 * Long IS work (a turn that outlives the token's 15 minutes) asks for a new
 * token BEFORE the current one expires. The new token carries the SAME
 * operator, acting agent, channel, run, audience and `max_exp`, with a new
 * `jti` and `exp = min(now + 15 min, max_exp)` — so no refresh chain ever
 * outlives the 2 hours the pod granted when the turn started
 * (`refreshIsDelegationToken`, database utils/is-delegation.ts).
 *
 * Auth: the hub middleware already verified the Bearer as a delegation
 * (`authenticateIsDelegation`). The handler verifies it again through the same
 * door to READ its claims — the request body is never read, so nothing the
 * caller sends can widen the new token. A stored API key reaching this route
 * is refused: only a delegation can be refreshed.
 *
 * Skipped by the idempotency cache (it returns a credential).
 */

import {
  PodIdentityError,
  isPodJwtShaped,
  refreshIsDelegationToken,
} from "@synap/database";
import { isIntelligenceServiceOrigin } from "@synap/intelligence-client";

import { authErrorResponse } from "../../../utils/auth-error.js";
import { extractBearerToken } from "../_middleware/auth.js";
import { logger, type HubHono } from "./_shared.js";

export const DELEGATION_REFRESH_PATH = "/delegation/refresh";

export function registerDelegationRoutes(app: HubHono): void {
  app.post(DELEGATION_REFRESH_PATH, async (c) => {
    const token = extractBearerToken(c.req.header("authorization"));
    if (!token || !isPodJwtShaped(token)) {
      return authErrorResponse(c, "key_revoked", {
        message: "Only an AI-service delegation can be refreshed.",
      });
    }
    try {
      const {
        token: next,
        expiresAt,
        previous,
      } = await refreshIsDelegationToken(token, {
        isKnownAudience: isIntelligenceServiceOrigin,
      });
      logger.info(
        { jti: previous.jti, runId: previous.runId },
        "IS delegation refreshed"
      );
      return c.json({
        token: next,
        expiresAt,
        maxExpiresAt: previous.maxExpiresAt,
      });
    } catch (err) {
      if (!(err instanceof PodIdentityError)) throw err; // a failed read is not a refusal
      logger.warn({ code: err.code }, "IS delegation refresh refused");
      return authErrorResponse(
        c,
        err.code === "POD_JWT_EXPIRED" ? "expired" : "key_revoked",
        { message: err.message }
      );
    }
  });
}
