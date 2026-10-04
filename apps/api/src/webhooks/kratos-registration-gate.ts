/**
 * Kratos self-service REGISTRATION gate.
 *
 * Founder decision (2026-10-04): a pod has no open sign-up.
 *   - Password self-registration is OFF (join = owner invite or Synap Cloud).
 *   - A Synap Cloud user (Kratos `oidc` provider "cp") gets a pod account on
 *     first sign-in ONLY when the CP's signed id_token says they own this pod,
 *     their email is verified, and the pod has no different human owner yet
 *     (first use, or recovery after a wipe). Everyone else is refused with
 *     {@link POD_ACCESS_REQUIRED} and clients offer "Request access" (the
 *     request itself lives on the CP).
 *
 * Two Kratos hooks call this router (see `generate_kratos_config` in `synap`):
 *
 *   POST /gate      — `registration.after.{password,oidc}` web_hook with
 *                     `can_interrupt: true`. Kratos v1.3.1 runs it PRE-PERSIST
 *                     (selfservice/hook/web_hook.go
 *                     ExecutePostRegistrationPrePersistHook), so a 403 with a
 *                     `messages` body aborts the flow before any identity
 *                     exists. The identity has no id yet at this point.
 *   POST /complete  — `registration.after.oidc` web_hook WITHOUT
 *                     `can_interrupt`, ordered BEFORE the `session` hook (the
 *                     session hook ends the post-persist chain). Runs
 *                     post-persist, so the identity id exists: it seeds the pod
 *                     owner (users row + pod-admin owner + federated link) via
 *                     the same door `/api/federation/bootstrap` uses.
 *
 * WHERE THE CLAIMS COME FROM: Kratos serialises `ctx.identity` with
 * `Identity.MarshalJSON` (identity/identity.go), which DROPS `credentials` and
 * `metadata_admin`. The raw id_token claims are not in the web_hook ctx at
 * all. So `kratos/oidc.cp.jsonnet` copies the verified claims
 * (`claims.iss`, `claims.sub`, `claims.raw_claims.email_verified`,
 * `claims.raw_claims.synap_pod_owner`) into `identity.metadata_public.synap_cp`
 * — the only place this hook can read them. Only the cp mapper may write that
 * key; the issuer is re-checked here against the pod's configured federation
 * issuer, so another provider's mapper cannot impersonate it.
 *
 * Auth: the same `X-Webhook-Secret` / `KRATOS_WEBHOOK_SECRET` as the
 * identity-sync webhook.
 */

import { timingSafeEqual } from "crypto";
import { Hono, type Context } from "hono";
import { createLogger } from "@synap-core/core";

/**
 * The ONE definition of the "no pod access" refusal. Clients (browser, relay,
 * pod-admin) match `id === 4000901` on the Kratos registration flow's
 * `ui.messages` and render "Request access" instead of an error.
 *
 * 4000xxx is Kratos' validation-error range; 4000901 is unused by Kratos
 * v1.3.1 (its own ids stop well below 4000100).
 */
export const POD_ACCESS_REQUIRED = {
  id: 4000901,
  text: "You don't have access to this pod yet.",
  context: { reason: "pod_access_required" },
} as const;

/** Kratos web_hook interrupt body (parsed by web_hook.go parseWebhookResponse). */
export function podAccessRequiredBody() {
  return {
    messages: [
      {
        // "#/" maps to an empty field pointer ⇒ Kratos adds the message to
        // the flow's GLOBAL ui.messages (ui/container AddMessage).
        instance_ptr: "#/",
        messages: [
          {
            id: POD_ACCESS_REQUIRED.id,
            text: POD_ACCESS_REQUIRED.text,
            type: "error",
            context: POD_ACCESS_REQUIRED.context,
          },
        ],
      },
    ],
  };
}

const logger = createLogger({ module: "kratos-registration-gate" });

export interface CloudClaims {
  iss: string;
  sub: string;
  emailVerified: boolean;
  podOwner: boolean;
}

export interface RegistrationHookPayload {
  method: string | null;
  identityId: string | null;
  email: string | null;
  name: string | null;
  cloud: CloudClaims | null;
}

export type GateDecision =
  | { allow: true; path: "owner_claim" | "existing_account" }
  | { allow: false; reason: string };

export interface RegistrationGateDeps {
  /** The pod's configured CP federation issuer. THROWS on a failed read. */
  readFederationIssuer(): Promise<string | null>;
  normalizeIssuerUrl(url: string): string | null;
  /** Mirrors `/federation/bootstrap`: a DIFFERENT human owner already exists. */
  hasDifferentHumanOwner(issuerUrl: string, sub: string): Promise<boolean>;
  /** A Kratos identity already holds this email. THROWS on a failed read. */
  kratosEmailExists(email: string): Promise<boolean>;
  /** Kratos identity exists in the pod `users` table. */
  podUserExists(identityId: string): Promise<boolean>;
  claimOwner(input: {
    issuerUrl: string;
    issuerSubject: string;
    kratosIdentityId: string;
    email: string;
    name?: string;
  }): Promise<
    | { status: "claimed"; userId: string; issuerApproved: boolean }
    | { status: "owner_exists" | "issuer_unusable" }
    | { status: "failed"; error: unknown }
  >;
  deleteKratosIdentity(identityId: string): Promise<boolean>;
}

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** Parse the body our jsonnet sends: `{ method, identity }`. */
export function parseRegistrationHookPayload(
  body: unknown
): RegistrationHookPayload {
  const root = (body ?? {}) as Record<string, unknown>;
  const identity = (root.identity ?? {}) as Record<string, unknown>;
  const traits = (identity.traits ?? {}) as Record<string, unknown>;
  const meta = (identity.metadata_public ?? {}) as Record<string, unknown>;
  const cp = meta.synap_cp as Record<string, unknown> | undefined;
  const id = str(identity.id);
  const iss = cp ? str(cp.iss) : null;
  const sub = cp ? str(cp.sub) : null;
  return {
    method: str(root.method),
    identityId: id && id !== NIL_UUID ? id : null,
    email: str(traits.email)?.trim().toLowerCase() ?? null,
    name: str(traits.name),
    cloud:
      cp && iss && sub
        ? {
            iss,
            sub,
            // Strict `=== true`: the mapper forwards the raw claim, and a
            // string "true" or a missing claim must never read as proof.
            emailVerified: cp.email_verified === true,
            podOwner: cp.pod_owner === true,
          }
        : null,
  };
}

/**
 * The owner-claim predicate, shared by `/gate` and `/complete` so the two
 * hooks can never disagree on who may become owner. Returns the canonical
 * issuer URL when eligible.
 */
async function ownerClaimIssuer(
  payload: RegistrationHookPayload,
  deps: RegistrationGateDeps
): Promise<string | null> {
  const cloud = payload.cloud;
  if (payload.method !== "oidc" || !cloud || !payload.email) return null;
  if (!cloud.podOwner || !cloud.emailVerified) return null;
  const configured = await deps.readFederationIssuer();
  if (!configured) return null;
  const configuredUrl = deps.normalizeIssuerUrl(configured);
  const claimedUrl = deps.normalizeIssuerUrl(cloud.iss);
  if (!configuredUrl || configuredUrl !== claimedUrl) return null;
  if (await deps.hasDifferentHumanOwner(configuredUrl, cloud.sub)) return null;
  return configuredUrl;
}

export async function decideRegistration(
  payload: RegistrationHookPayload,
  deps: RegistrationGateDeps
): Promise<GateDecision> {
  // Password (and any non-oidc method) self-registration is closed outright.
  if (payload.method !== "oidc") {
    return { allow: false, reason: "self_registration_disabled" };
  }
  if (await ownerClaimIssuer(payload, deps)) {
    return { allow: true, path: "owner_claim" };
  }
  // Kratos v1.3.1 runs this hook BEFORE IdentityManager.Create
  // (selfservice/flow/registration/hook.go), i.e. before its own duplicate
  // detection. An existing pod account signing in with Cloud for the first
  // time must reach that detection — it turns the registration into Kratos'
  // account-linking login (no new identity is created). Refusing here would
  // lock invited members out of "Continue with Synap Cloud".
  if (payload.email && (await deps.kratosEmailExists(payload.email))) {
    return { allow: true, path: "existing_account" };
  }
  return { allow: false, reason: "pod_access_required" };
}

function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function authorize(c: Context): Response | null {
  const expected = process.env.KRATOS_WEBHOOK_SECRET;
  if (!expected) {
    logger.error("KRATOS_WEBHOOK_SECRET not configured");
    return c.json({ error: "Webhook not configured" }, 500);
  }
  const secret = c.req.header("X-Webhook-Secret");
  if (!secret || !safeCompare(secret, expected)) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  return null;
}

export function createRegistrationGateRouter(deps: RegistrationGateDeps) {
  const router = new Hono();

  router.post("/gate", async (c) => {
    const denied = authorize(c);
    if (denied) return denied;
    const payload = parseRegistrationHookPayload(
      await c.req.json().catch(() => null)
    );
    let decision: GateDecision;
    try {
      decision = await decideRegistration(payload, deps);
    } catch (err) {
      // A failed read is NOT a denial: answer 503 (no `messages`) so Kratos
      // shows a system error instead of a false "no access".
      logger.error({ err }, "registration gate could not decide");
      return c.json({ error: "Registration gate unavailable" }, 503);
    }
    logger.info(
      {
        method: payload.method,
        allow: decision.allow,
        ...(decision.allow
          ? { path: decision.path }
          : { reason: decision.reason }),
      },
      "[synap:auth] registration gate decision"
    );
    if (!decision.allow) return c.json(podAccessRequiredBody(), 403);
    return c.body(null, 204);
  });

  router.post("/complete", async (c) => {
    const denied = authorize(c);
    if (denied) return denied;
    const payload = parseRegistrationHookPayload(
      await c.req.json().catch(() => null)
    );
    if (!payload.identityId || !payload.email) {
      return c.json({ error: "identity is required" }, 400);
    }
    const identityId = payload.identityId;
    let issuerUrl: string | null;
    try {
      issuerUrl = await ownerClaimIssuer(payload, deps);
    } catch (err) {
      logger.error({ err }, "registration complete could not decide");
      await deps.deleteKratosIdentity(identityId);
      return c.json({ error: "Registration gate unavailable" }, 503);
    }

    if (issuerUrl && payload.cloud) {
      const result = await deps.claimOwner({
        issuerUrl,
        issuerSubject: payload.cloud.sub,
        kratosIdentityId: identityId,
        email: payload.email,
        ...(payload.name ? { name: payload.name } : {}),
      });
      if (result.status === "claimed") {
        logger.info(
          { userId: result.userId, issuerApproved: result.issuerApproved },
          "[synap:auth] pod owner claimed via Cloud sign-in"
        );
        return c.json({ ok: true, path: "owner_claim" });
      }
      // Lost a race to another owner, or the seed failed: the identity Kratos
      // just persisted must not survive without pod access.
      logger.warn(
        { status: result.status, identityId },
        "[synap:auth] Cloud owner claim refused after persist — removing identity"
      );
      await deps.deleteKratosIdentity(identityId);
      return c.json(podAccessRequiredBody(), 403);
    }

    // Safety net. The gate only lets a non-owner through for an EXISTING
    // account, which Kratos turns into account linking without persisting a
    // new identity. If one was persisted anyway, it has no pod access.
    if (await deps.podUserExists(identityId)) {
      return c.json({ ok: true, path: "existing_user" });
    }
    logger.warn(
      { identityId },
      "[synap:auth] registration persisted an identity with no pod access — removing it"
    );
    await deps.deleteKratosIdentity(identityId);
    return c.json(podAccessRequiredBody(), 403);
  });

  return router;
}
