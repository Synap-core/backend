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
 *     request itself lives on the CP). A password sign-up is refused with
 *     {@link SELF_REGISTRATION_DISABLED}.
 *   - Join plan phase 4 (decision B2, Q3 (a)): an INVITED person may make
 *     their pod account with Synap Cloud. The invite page starts the
 *     registration with `transient_payload.invite_token`; the gate lets it
 *     through only when that token opens an unexpired invite sent to the
 *     CP-verified email of this Cloud account, and `/complete` accepts the
 *     invite through the one accept door (`acceptInviteFor`). An invite for
 *     another email is refused with {@link INVITE_EMAIL_MISMATCH}.
 *   - The owner's "Allow sign-in with Synap Cloud" switch (Cloud trust `off`,
 *     ADDENDUM 2026-10-23) refuses EVERY Synap Cloud registration here, owner
 *     claim and invite alike ({@link CLOUD_SIGN_IN_DISABLED}); the login hook
 *     (`kratos-cloud-trust.ts` `/login/cloud`) refuses Cloud sign-in.
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
 * The invite token travels in the flow's `transient_payload`: Kratos v1.3.1
 * keeps it across the OIDC round trip (the continuity container,
 * selfservice/strategy/oidc/strategy.go) and serialises it as
 * `ctx.flow.transient_payload`, which the hook bodies forward.
 *
 * Auth: the same `X-Webhook-Secret` / `KRATOS_WEBHOOK_SECRET` as the
 * identity-sync webhook.
 */

import { timingSafeEqual } from "crypto";
import { Hono, type Context } from "hono";
import { createLogger } from "@synap-core/core";
import type { CloudTrustMode } from "@synap-core/types/account-recovery";
import {
  CLOUD_SIGN_IN_DISABLED,
  INVITE_EMAIL_MISMATCH,
  POD_ACCESS_REQUIRED,
  SELF_REGISTRATION_DISABLED,
} from "@synap-core/types/kratos-messages";

/**
 * The refusal messages live in ONE place, `@synap-core/types/kratos-messages`,
 * so the clients that match them (pod-admin, browser, relay) import the same
 * ids this gate emits. Re-exported for existing importers.
 *   - POD_ACCESS_REQUIRED (4000901): a Cloud user with no access to this pod.
 *   - SELF_REGISTRATION_DISABLED (4000902): password/non-Cloud self sign-up.
 */
export { POD_ACCESS_REQUIRED, SELF_REGISTRATION_DISABLED };

/** Every refusal the gate answers, keyed by `GateDecision.reason`. */
const REFUSALS = {
  pod_access_required: POD_ACCESS_REQUIRED,
  self_registration_disabled: SELF_REGISTRATION_DISABLED,
  cloud_sign_in_disabled: CLOUD_SIGN_IN_DISABLED,
  invite_email_mismatch: INVITE_EMAIL_MISMATCH,
} as const;
type RefusalReason = keyof typeof REFUSALS;

/** A pod-defined Kratos message (`@synap-core/types/kratos-messages`). */
export interface HookRefusal {
  readonly id: number;
  readonly text: string;
  readonly context: Readonly<Record<string, string>>;
}

/**
 * Kratos web_hook interrupt body (parsed by web_hook.go parseWebhookResponse).
 * Shared with the Cloud-trust hooks (`kratos-cloud-trust.ts`).
 */
export function refusalBody(message: HookRefusal) {
  return {
    messages: [
      {
        // "#/" maps to an empty field pointer ⇒ Kratos adds the message to
        // the flow's GLOBAL ui.messages (ui/container AddMessage).
        instance_ptr: "#/",
        messages: [
          {
            id: message.id,
            text: message.text,
            type: "error",
            context: message.context,
          },
        ],
      },
    ],
  };
}

export function podAccessRequiredBody() {
  return refusalBody(POD_ACCESS_REQUIRED);
}

export function selfRegistrationDisabledBody() {
  return refusalBody(SELF_REGISTRATION_DISABLED);
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
  /** `transient_payload.invite_token`: a registration started on the invite page. */
  inviteToken: string | null;
}

export type GateDecision =
  | { allow: true; path: "owner_claim" | "invite" | "existing_account" }
  | { allow: false; reason: RefusalReason };

/** What the gate needs to know about an invite. */
export interface GateInvite {
  email: string;
  expiresAt: Date;
}

export interface RegistrationGateDeps {
  /** The owner's Cloud trust (`off` = no Synap Cloud sign-in). THROWS on a failed read. */
  readCloudTrust(): Promise<CloudTrustMode>;
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
  /** The pending invite this token opens, or null. THROWS on a failed read. */
  findInvite(token: string): Promise<GateInvite | null>;
  /**
   * Accept the invite for the identity Kratos just persisted: the pod `users`
   * row, then the one accept door (`acceptInviteFor`). `gone` = the invite was
   * spent or withdrawn since `/gate`. THROWS on a failed write.
   */
  acceptInvite(input: {
    token: string;
    kratosIdentityId: string;
    email: string;
    name?: string;
  }): Promise<"accepted" | "gone">;
}

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** Parse the body our jsonnet sends: `{ method, identity, transient_payload }`. */
export function parseRegistrationHookPayload(
  body: unknown
): RegistrationHookPayload {
  const root = (body ?? {}) as Record<string, unknown>;
  const identity = (root.identity ?? {}) as Record<string, unknown>;
  const transient = (root.transient_payload ?? {}) as Record<string, unknown>;
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
    inviteToken: str(transient.invite_token)?.trim() ?? null,
  };
}

/**
 * The claimed issuer, canonical, when it IS the pod's configured CP: another
 * provider's mapper cannot write `synap_cp` and pass as Synap Cloud.
 */
async function configuredCloudIssuer(
  cloud: CloudClaims,
  deps: RegistrationGateDeps
): Promise<string | null> {
  const configured = await deps.readFederationIssuer();
  if (!configured) return null;
  const configuredUrl = deps.normalizeIssuerUrl(configured);
  const claimedUrl = deps.normalizeIssuerUrl(cloud.iss);
  if (!configuredUrl || configuredUrl !== claimedUrl) return null;
  return configuredUrl;
}

/** A Synap Cloud registration on a pod whose owner turned Cloud sign-in off. */
async function cloudSignInRefused(
  payload: RegistrationHookPayload,
  deps: RegistrationGateDeps
): Promise<boolean> {
  return payload.cloud !== null && (await deps.readCloudTrust()) === "off";
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
  const configuredUrl = await configuredCloudIssuer(cloud, deps);
  if (!configuredUrl) return null;
  if (await deps.hasDifferentHumanOwner(configuredUrl, cloud.sub)) return null;
  return configuredUrl;
}

/**
 * The invite-bound Cloud join, shared by `/gate` and `/complete` like
 * {@link ownerClaimIssuer}. `open`: the token opens an unexpired invite.
 * `bound`: that invite was sent to this Cloud account's VERIFIED email (Q3 (a):
 * an invite is for the address it was sent to, never for whoever shows up).
 */
async function inviteClaim(
  payload: RegistrationHookPayload,
  deps: RegistrationGateDeps
): Promise<{ open: boolean; bound: boolean }> {
  const cloud = payload.cloud;
  const none = { open: false, bound: false };
  if (payload.method !== "oidc" || !cloud || !payload.inviteToken) return none;
  if (!(await configuredCloudIssuer(cloud, deps))) return none;
  const invite = await deps.findInvite(payload.inviteToken);
  if (!invite || invite.expiresAt.getTime() <= Date.now()) return none;
  const bound =
    cloud.emailVerified &&
    payload.email !== null &&
    invite.email.trim().toLowerCase() === payload.email;
  return { open: true, bound };
}

export async function decideRegistration(
  payload: RegistrationHookPayload,
  deps: RegistrationGateDeps
): Promise<GateDecision> {
  // Password (and any non-oidc method) self-registration is closed outright.
  if (payload.method !== "oidc") {
    return { allow: false, reason: "self_registration_disabled" };
  }
  // The owner's switch governs HOW anyone signs in: off refuses every Synap
  // Cloud registration, the owner's own claim and an invite included.
  if (await cloudSignInRefused(payload, deps)) {
    return { allow: false, reason: "cloud_sign_in_disabled" };
  }
  if (await ownerClaimIssuer(payload, deps)) {
    return { allow: true, path: "owner_claim" };
  }
  const invite = await inviteClaim(payload, deps);
  if (invite.bound) return { allow: true, path: "invite" };
  // Kratos v1.3.1 runs this hook BEFORE IdentityManager.Create
  // (selfservice/flow/registration/hook.go), i.e. before its own duplicate
  // detection. An existing pod account signing in with Cloud for the first
  // time must reach that detection — it turns the registration into Kratos'
  // account-linking login (no new identity is created). Refusing here would
  // lock invited members out of "Continue with Synap Cloud".
  if (payload.email && (await deps.kratosEmailExists(payload.email))) {
    return { allow: true, path: "existing_account" };
  }
  // An open invite for ANOTHER email (or an unverified one) is said as such,
  // not as "no access": the person holds an invitation, not for this account.
  if (invite.open) return { allow: false, reason: "invite_email_mismatch" };
  return { allow: false, reason: "pod_access_required" };
}

function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/** X-Webhook-Secret check shared by every Kratos hook route. */
export function authorize(c: Context): Response | null {
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
    if (!decision.allow) {
      return c.json(refusalBody(REFUSALS[decision.reason]), 403);
    }
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
    let inviteBound = false;
    try {
      // Re-checked post-persist: the switch may have moved since `/gate`.
      if (await cloudSignInRefused(payload, deps)) {
        logger.warn(
          { identityId },
          "[synap:auth] Cloud sign-in turned off after the gate — removing identity"
        );
        await deps.deleteKratosIdentity(identityId);
        return c.json(refusalBody(CLOUD_SIGN_IN_DISABLED), 403);
      }
      issuerUrl = await ownerClaimIssuer(payload, deps);
      if (!issuerUrl) inviteBound = (await inviteClaim(payload, deps)).bound;
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

    if (inviteBound && payload.inviteToken) {
      let accepted: "accepted" | "gone";
      try {
        accepted = await deps.acceptInvite({
          token: payload.inviteToken,
          kratosIdentityId: identityId,
          email: payload.email,
          ...(payload.name ? { name: payload.name } : {}),
        });
      } catch (err) {
        logger.error(
          { err, identityId },
          "[synap:auth] invite accept failed after Cloud sign-up — removing identity"
        );
        await deps.deleteKratosIdentity(identityId);
        return c.json({ error: "Registration gate unavailable" }, 503);
      }
      if (accepted === "accepted") {
        logger.info(
          { identityId },
          "[synap:auth] invite accepted via Cloud sign-up"
        );
        return c.json({ ok: true, path: "invite" });
      }
      // Spent or withdrawn between the gate and now: no access, no account.
      logger.warn(
        { identityId },
        "[synap:auth] invite gone after the gate — removing identity"
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
