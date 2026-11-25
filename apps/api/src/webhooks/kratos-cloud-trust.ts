/**
 * Kratos hooks that enforce the owner's Synap Cloud trust (founder decision
 * R1, 2026-10-04: Cloud may SIGN IN by default; RECOVERY is opt-in).
 *
 * Wired in `generate_kratos_config` (`synap`), both with `can_interrupt: true`:
 *
 *   POST /settings/guard — `settings.after.{password,passkey,profile,oidc}`.
 *     The passkey hook calls `?method=passkey`: a person who already holds a
 *     proof factor changes passkeys only with a redeemed proof (W3 slice 3).
 *     Kratos v1.3.1 runs a can_interrupt settings web_hook PRE-PERSIST
 *     (selfservice/hook/web_hook.go ExecuteSettingsPrePersistHook), so a 403
 *     with `messages` aborts the change before the identity is written. The
 *     hook ctx carries the request cookies but NOT the session
 *     (templateContext.Session is only set for login/registration), so the
 *     jsonnet body forwards the `ory_kratos_session` cookie and this route
 *     resolves the session itself to read `authentication_methods`.
 *     An API flow (no cookie) cannot prove a pod-held factor: it is treated
 *     as Cloud-only (fail closed). No client uses API settings flows today.
 *     A passkey grant is redeemed only by the session that obtained it
 *     (founder decision of 9 Nov 2026, "Add this device", session 84c74a23):
 *     the session the cookie resolves to gives the key
 *     (`presenceSessionKey("kratos", session.id)`, the derivation the pod's
 *     `callerSessionKey` uses), and with no session there is no key, so a
 *     guarded passkey change is refused.
 *
 *   POST /login/cloud — `login.after.oidc`. Runs before the session cookie is
 *     issued (selfservice/flow/login/hook.go PostLoginHook: hooks, then
 *     UpsertAndIssueCookie), so `off` refuses "Continue with Synap Cloud".
 *
 * A failed read answers 503 (no `messages`): Kratos then shows a system
 * error, never a false refusal and never a silent allow.
 */

import { Hono } from "hono";
import {
  CLOUD_SESSION_CANNOT_CHANGE_CREDENTIALS,
  CLOUD_SIGN_IN_DISABLED,
  PASSKEY_CHANGE_NEEDS_PRESENCE,
} from "@synap-core/types/kratos-messages";
import type { CloudTrustMode } from "@synap-core/types/account-recovery";
import { presenceSessionKey } from "@synap-core/types/presence";
import {
  decideCredentialChange,
  sessionIsCloudOnly,
  type KratosSessionLike,
} from "../account-recovery/policy.js";
import { authorize, refusalBody } from "./kratos-registration-gate.js";

export interface CloudTrustHookDeps {
  readCloudTrust(): Promise<CloudTrustMode>;
  /** Kratos whoami for an `ory_kratos_session` cookie value. null = not a valid session; throws on a failed read. */
  resolveSession(cookieValue: string): Promise<KratosSessionLike | null>;
  /** Password / passkey in Kratos, or unused recovery codes. Throws on a failed read. */
  accountHasPodHeldFactor(identityId: string): Promise<boolean>;
  /**
   * A passkey change (`?method=passkey`, W3 slice 3, founder decision 2): a
   * person who already holds a proof factor (a passkey, a Relay device key)
   * changes passkeys only by redeeming a proof from one of them
   * (`presence.authorizePasskeyChange`), or an approved device link
   * ("Add this device"), once, by the session that obtained it
   * (`sessionKey`, null when the hook carried no session). Each read throws
   * on failure.
   */
  passkeyChange: {
    hasProofFactor(identityId: string): Promise<boolean>;
    redeemGrant(
      identityId: string,
      sessionKey: string | null
    ): Promise<boolean>;
    /** Tell the person; never throws (the change is about to land). */
    notify(identityId: string): Promise<void>;
  };
  logger: {
    info(obj: Record<string, unknown>, msg?: string): void;
    error(obj: Record<string, unknown>, msg?: string): void;
  };
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

export function createCloudTrustHookRouter(deps: CloudTrustHookDeps) {
  const router = new Hono();

  router.post("/settings/guard", async (c) => {
    const denied = authorize(c);
    if (denied) return denied;
    const body = (await c.req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    const identityId = str(body?.identity_id);
    if (!identityId) return c.json({ error: "identity_id is required" }, 400);
    const cookie = str(body?.session_cookie);

    try {
      const trust = await deps.readCloudTrust();
      let cloudOnly = true;
      let sessionKey: string | null = null;
      if (cookie) {
        const session = await deps.resolveSession(cookie);
        if (session?.identity?.id === identityId) {
          cloudOnly = sessionIsCloudOnly(session);
          sessionKey = presenceSessionKey("kratos", session.id);
        }
      }
      const decision = decideCredentialChange({
        trust,
        cloudOnly,
        accountHasPodHeldFactor: cloudOnly
          ? await deps.accountHasPodHeldFactor(identityId)
          : true,
      });
      deps.logger.info(
        {
          identityId,
          trust,
          cloudOnly,
          allow: decision.allow,
          ...(decision.allow ? { via: decision.via } : {}),
        },
        "[synap:auth] settings Cloud-trust guard"
      );
      if (!decision.allow) {
        return c.json(
          refusalBody(CLOUD_SESSION_CANNOT_CHANGE_CREDENTIALS),
          403
        );
      }
      if (c.req.query("method") === "passkey") {
        const guarded = await deps.passkeyChange.hasProofFactor(identityId);
        if (
          guarded &&
          !(await deps.passkeyChange.redeemGrant(identityId, sessionKey))
        ) {
          deps.logger.info(
            { identityId },
            "[synap:auth] passkey change refused: no proof from an existing factor"
          );
          return c.json(refusalBody(PASSKEY_CHANGE_NEEDS_PRESENCE), 403);
        }
        await deps.passkeyChange.notify(identityId);
      }
      return c.body(null, 204);
    } catch (err) {
      deps.logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        "[synap:auth] settings Cloud-trust guard could not decide"
      );
      return c.json({ error: "Settings guard unavailable" }, 503);
    }
  });

  router.post("/login/cloud", async (c) => {
    const denied = authorize(c);
    if (denied) return denied;
    try {
      const trust = await deps.readCloudTrust();
      if (trust === "off") {
        deps.logger.info({ trust }, "[synap:auth] Cloud sign-in refused (off)");
        return c.json(refusalBody(CLOUD_SIGN_IN_DISABLED), 403);
      }
      return c.body(null, 204);
    } catch (err) {
      deps.logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        "[synap:auth] Cloud sign-in gate could not decide"
      );
      return c.json({ error: "Cloud sign-in gate unavailable" }, 503);
    }
  });

  return router;
}
