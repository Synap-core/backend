/**
 * Hub Protocol authentication middleware.
 *
 * EXTRACTED VERBATIM from `hub-protocol-rest.ts` (which now mounts it as
 * `app.use("/*", hubAuthMiddleware)`), so the door itself — not a re-derived
 * helper — can be exercised by tests. Behaviour and ordering are unchanged.
 *
 * Accepts four credential types:
 *   1. `Authorization: Bearer synap_pd_…` — a Synap app's DEVICE token (the
 *      desktop or Relay signed in through this pod's OAuth door): the PERSON,
 *      exactly as a Kratos session token is (`authenticatePersonDevice`)
 *   2. `Authorization: Bearer <pod+jwt>` — the per-turn IS delegation this pod
 *      signed itself (D4, `authenticateIsDelegation` below)
 *   3. `Authorization: Bearer <api-key>` — IS agents, external agents, CLI (API key auth)
 *   4. `X-Session-Token: <kratos-token>` — browser extension, web clients (Kratos session auth)
 *
 * Session callers (a Kratos session token, a device token) receive full
 * hub-protocol.read + hub-protocol.write scopes. Skip auth for the paths of
 * `HUB_AUTH_SKIP_PATHS` (`auth-skip.ts`).
 */

import {
  GRANT_DOOR_UNSUPPORTED,
  GRANT_OWNER_WIDE_UNSUPPORTED,
  isFencedGrant,
  ownerWideDoorAllowed,
  restDoorAllowed,
} from "../../../access/grant-door-fence.js";
import type { Context, Next } from "hono";
import { createLogger } from "@synap-core/core";
import {
  db,
  users,
  eq,
  runWithProbeWrites,
  runWithActingAgent,
  runWithCallingKey,
  runWithClientKey,
  runWithGrant,
  clientKeyForApiKey,
  requestConversationId,
  CONVERSATION_HEADER,
  CONVERSATION_CWD_HEADER,
  PROCESS_HEADER,
  RUNNER_STATE_HEADER,
  runWithReportedModel,
  MODEL_HEADER,
  MODEL_PROVIDER_HEADER,
  isProbeApiKey,
  isPodJwtShaped,
  grantOfScope,
  PodIdentityError,
  verifyIsDelegationToken,
  type VerifiedIsDelegation,
} from "@synap/database";
import { APP_PERSON_KEY_TYPE } from "@synap/database/schema";
import {
  AppGrantClaimError,
  parseAppGrantClaim,
} from "../../../services/app-grant-claim.js";
import {
  isPersonDeviceToken,
  resolvePersonDeviceSession,
} from "@synap/database/person-devices";
import { isIntelligenceServiceOrigin } from "@synap/intelligence-client";

import { apiKeyService } from "../../../services/api-keys.js";
import { resolveKeyIdentity } from "../../../access/key-identity.js";
import {
  isSubTokenFeatureEnabled,
  resolveExternalUserMapping,
} from "../../../services/external-user-mapping.js";
import { authErrorResponse, shortenKeyId } from "../../../utils/auth-error.js";
import {
  GUEST_REFUSED_BODY,
  isGuestPrincipal,
} from "../../../access/guest-containment.js";
import { reportNoPodAccess } from "../../../access/pod-access.js";
import { reportRunnerState } from "../../../services/focus-sessions/session-runners.js";
import {
  runAsDeviceSession,
  STEP_UP_REFUSAL_BODY,
  type DeviceSessionFacts,
} from "../../../utils/device-session.js";
import type { HubVariables } from "../rest/_shared.js";
import { hubAuthSkipped, hubRelativePath } from "./auth-skip.js";

const logger = createLogger({ module: "hub-protocol-auth" });

/**
 * Attach near-expiry warning headers when a validated key is within this many
 * days of `expiresAt`. Pure addition — it does NOT change the hard-401-on-expiry
 * behavior (that stays in `getApiKeyStatus`, which returns `status: "expired"`).
 * The IS reads `X-Key-Expires-Soon` / `X-Key-Expires-At` on its responses (see
 * packages/jobs intelligence-health-check) to surface a re-provision warning.
 */
const KEY_EXPIRY_WARNING_DAYS = 14;

/**
 * Refuse a GUEST principal on every authenticated hub route, whatever the
 * method. This door serves agents, the IS and tooling; a guest (a guest project
 * role and no pod participation) only ever reads what was shared with them,
 * through the app. See `access/guest-containment.ts`. `null` = not a guest.
 *
 * The same final principal meets the pod-access floor: one with no access to
 * the pod at all is REPORTED (B1, `access/pod-access.ts`), not yet refused.
 */
async function refuseGuestPrincipal(
  c: Context<{ Variables: HubVariables }>
): Promise<Response | null> {
  const userId = c.get("userId") as string | undefined;
  if (!userId) return null;
  if (await isGuestPrincipal(userId, c.req.raw)) {
    return c.json(GUEST_REFUSED_BODY, 403);
  }
  await reportNoPodAccess(userId, c.req.raw, "hub");
  return null;
}

/** The bearer token of an `Authorization` header — the ONE parser. */
export function extractBearerToken(
  authHeader: string | null | undefined
): string | null {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

/**
 * TRANSITION SWITCH (D4 step 4 → 5). While the IS fleet moves to delegation
 * tokens, the legacy `is_internal` key + `X-Delegated-Operator-Id` is still
 * accepted and LOGGED. `SYNAP_IS_LEGACY_DELEGATION=refuse` turns it off once
 * the log reads zero (founder cut-over); anything else keeps accepting.
 */
export function legacyIsDelegationAllowed(): boolean {
  return process.env.SYNAP_IS_LEGACY_DELEGATION?.trim() !== "refuse";
}

const legacyDelegationSeen = new Map<
  string,
  { count: number; since: number }
>();
const LEGACY_DELEGATION_LOG_INTERVAL_MS = 60_000;

/**
 * "is_internal delegated header accepted" — the signal the cut-over is watched
 * to zero on. One line per key per minute (with the count), never per request.
 */
function logLegacyDelegation(keyId: string): void {
  const now = Date.now();
  const seen = legacyDelegationSeen.get(keyId);
  if (!seen) {
    legacyDelegationSeen.set(keyId, { count: 0, since: now });
    logger.warn(
      { keyIdPrefix: shortenKeyId(keyId), count: 1 },
      "is_internal delegated header accepted"
    );
    return;
  }
  seen.count++;
  if (now - seen.since >= LEGACY_DELEGATION_LOG_INTERVAL_MS) {
    logger.warn(
      { keyIdPrefix: shortenKeyId(keyId), count: seen.count },
      "is_internal delegated header accepted"
    );
    seen.count = 0;
    seen.since = now;
  }
}

/**
 * A Bearer this pod signed as an IS delegation (D4, `utils/is-delegation.ts`).
 *
 * The principal is the SAME one the legacy `is_internal` key + header produced
 * — operator = `userId` = `linkedUserId`, `keyType` "is_internal", no acting
 * agent — so every downstream rule keyed on that principal (B1 persona naming
 * in `getCaller`, plaintext provider credentials, the human-only run cancel,
 * channel-grouped sessions) behaves exactly as before. What changes is where
 * the operator comes from: the pod's own signature over `sub`, never a header
 * the caller picks. Two deliberate narrowings:
 *   - no `apiKeyId`, so `mayActAsUser` refuses a body `userId` other than the
 *     operator (the stored key could name ANY user);
 *   - `act.sub` is verified but NOT entered as the request's acting agent:
 *     `getActingAgentUserId()` outranks the persona the IS names per write
 *     (`permission-check.ts`), so entering it would move every IS write onto a
 *     different governance lane — a separate, dogfooded step.
 * Grant: the same explicit full access the `is_internal` key carries.
 */
async function authenticateIsDelegation(
  c: Context<{ Variables: HubVariables }>,
  next: Next,
  token: string
): Promise<Response | void> {
  let delegation: VerifiedIsDelegation;
  try {
    delegation = await verifyIsDelegationToken(token, {
      isKnownAudience: isIntelligenceServiceOrigin,
    });
  } catch (err) {
    if (!(err instanceof PodIdentityError)) throw err; // a failed read is not a refusal
    logger.warn({ code: err.code }, "IS delegation token refused");
    return authErrorResponse(
      c,
      err.code === "POD_JWT_EXPIRED" ? "expired" : "key_revoked",
      { message: err.message }
    );
  }

  const headerOperator = c.req.header("x-delegated-operator-id");
  if (headerOperator && headerOperator !== delegation.operatorUserId) {
    logger.warn(
      { jti: delegation.jti },
      "IS delegation refused: X-Delegated-Operator-Id differs from the token's operator"
    );
    return authErrorResponse(c, "key_revoked", {
      message: "The delegated operator header does not match the delegation.",
    });
  }
  const operator = await db.query.users.findFirst({
    where: eq(users.id, delegation.operatorUserId),
    columns: { id: true },
  });
  if (!operator) {
    return authErrorResponse(c, "key_revoked", {
      message: "This delegation's operator is not a user of this pod.",
    });
  }

  // One bucket per AI service, as the single is_internal key had.
  if (
    !apiKeyService.checkRateLimit(
      `is-delegation:${delegation.audience}`,
      "request"
    )
  ) {
    return c.json({ error: "Rate limit exceeded" }, 429);
  }

  c.set("userId", delegation.operatorUserId);
  c.set("linkedUserId", delegation.operatorUserId);
  c.set("scopes", delegation.scopes);
  c.set("keyType", "is_internal");
  c.set("keyWorkspaceId", null);
  const refused = await refuseGuestPrincipal(c);
  if (refused) return refused;
  // The turn's grant: an APP's grant when the token carries one (`app_grant`,
  // narrowing only), else the full-access delegation grant as before. FAIL
  // CLOSED: a claim that does not parse is refused, never widened to `*`.
  let grant;
  if (delegation.appGrant) {
    try {
      grant = parseAppGrantClaim(delegation.appGrant);
    } catch (err) {
      if (!(err instanceof AppGrantClaimError)) throw err;
      logger.warn(
        { jti: delegation.jti },
        "IS delegation refused: bad app grant"
      );
      return authErrorResponse(c, "key_revoked", {
        message: "This delegation's app grant is malformed.",
      });
    }
    // The same door fence an API key's grant meets (see the key path above).
    const rel = hubRelativePath(c.req.path);
    if (isFencedGrant(grant) && !restDoorAllowed(c.req.method, rel, grant)) {
      return c.json(
        { error: GRANT_DOOR_UNSUPPORTED, code: "GRANT_DOOR_UNSUPPORTED" },
        403
      );
    }
    if (!ownerWideDoorAllowed(rel, grant, c.req.method)) {
      return c.json(
        { error: GRANT_OWNER_WIDE_UNSUPPORTED, code: "GRANT_DOOR_UNSUPPORTED" },
        403
      );
    }
  } else {
    grant = IS_DELEGATION_GRANT;
  }
  // W-A4: a non-channel IS run names itself (`is:<runId>`); the same resolver
  // as the stored key's, the AI service (the token's audience) as the client.
  return runWithClientKey(
    clientKeyForApiKey(
      { id: delegation.audience, keyType: "is_internal" },
      requestConversationId(c.req.header(CONVERSATION_HEADER))
    ),
    () => runWithGrant(grant, () => next())
  );
}

/** What a signed-in person holds on this door (a Kratos session or a device). */
const PERSON_SESSION_SCOPES = ["hub-protocol.read", "hub-protocol.write"];

/**
 * A Synap app's DEVICE token (`synap_pd_…`): the person, exactly where and how
 * a Kratos session token is (same scopes, same guest refusal), resolved by the
 * ONE validator `appSessionMiddleware` uses (`resolvePersonDeviceSession`).
 * The request is marked a device session the way app-session marks it
 * (`sessionKind`, and the async scope `runAsDeviceSession`), so every
 * credential door it reaches asks for a fresh sign-in: a Hub route through
 * `refuseStaleDeviceSession` (rest/_shared.ts), a service or a tRPC procedure
 * through `assertFreshAuthentication`, which reads the same scope. Tripwire:
 * `credential-doors-refuse-device-session` (it scans the Hub routes too).
 *
 * A token that does not resolve (unknown, expired, its device signed out) is
 * 401 `key_revoked` with `WWW-Authenticate: invalid_token`, so the app
 * refreshes; a failed lookup is 503, never "signed out".
 */
async function authenticatePersonDevice(
  c: Context<{ Variables: HubVariables }>,
  next: Next,
  token: string
): Promise<Response | void> {
  let session;
  try {
    session = await resolvePersonDeviceSession(db, token);
  } catch (err) {
    logger.warn({ err }, "device token lookup failed");
    return c.json(
      {
        error: "auth_service_unavailable",
        message: "Sign-in could not be checked. Please retry.",
      },
      503
    );
  }
  if (!session) {
    c.header("WWW-Authenticate", 'Bearer error="invalid_token"');
    return authErrorResponse(c, "key_revoked", {
      message:
        "This device's sign-in is invalid or expired. Refresh it, or sign in again.",
    });
  }
  c.set("userId", session.identity.id);
  c.set("scopes", [...PERSON_SESSION_SCOPES]);
  c.set("sessionKind", "person_device");
  c.set("personDeviceId", session.device.id);
  const refused = await refuseGuestPrincipal(c);
  if (refused) return refused;
  const device: DeviceSessionFacts = {
    id: session.device.id,
    authTime: session.device.authTime,
  };
  return runAsDeviceSession(device, async () => {
    await next();
    // The ONE Hub mapper for a step-up refusal. A route that maps errors
    // itself (`POST /proposals/:id/approve` reaching the approval floor, a
    // service guard behind `getCaller`) would otherwise answer its own 403
    // or 500 without the code the app steps up on. Any route, any mapping:
    // when this request was refused a step-up and answers an error, it
    // answers the step-up.
    if (device.stepUpRefused && c.res.status >= 400) {
      c.res = new Response(JSON.stringify(STEP_UP_REFUSAL_BODY), {
        status: 403,
        headers: { "content-type": "application/json" },
      });
      // Hono carries the old response's headers over: not its length.
      c.res.headers.delete("content-length");
    }
  });
}

/** The explicit full access the `is_internal` key is minted with (provision.ts). */
const IS_DELEGATION_GRANT = grantOfScope({ permissions: ["*"] });

export const hubAuthMiddleware = async (
  c: Context<{ Variables: HubVariables }>,
  next: Next
) => {
  const reqPath = c.req.path;
  // Paths that read no credential here (`auth-skip.ts`, the ONE list).
  if (hubAuthSkipped(reqPath)) return next();
  // `rel`: the path without its mount — what the door fences rule on.
  const rel = hubRelativePath(reqPath);

  // ── 1. Try API key (agents / IS) ─────────────────────────────
  const authHeader = c.req.header("authorization") ?? null;
  const token = extractBearerToken(authHeader);

  // Tried ONLY for a token with the device prefix: an API key or an IS
  // delegation never reaches this branch, and a device token never reaches
  // the key lookup (it is no `api_keys` row).
  if (token && isPersonDeviceToken(token)) {
    return authenticatePersonDevice(c, next, token);
  }

  if (token && isPodJwtShaped(token)) {
    return authenticateIsDelegation(c, next, token);
  }

  if (token) {
    // Use getApiKeyStatus (introspecting variant) so we can return a
    // structured failure reason — distinguishing revoked from expired
    // from unknown matters to operators trying to debug Eve CLI auth.
    const status = await apiKeyService.getApiKeyStatus(token);
    if (status.status === "invalid_format") {
      return authErrorResponse(c, "invalid_format");
    }
    if (status.status === "not_found") {
      // Either the key was never minted on this pod, or it was hard-revoked.
      // From the caller's perspective both look identical — collapse to
      // `key_revoked` with a hint that re-minting fixes it.
      return authErrorResponse(c, "key_revoked");
    }
    if (status.status === "revoked") {
      return authErrorResponse(c, "key_revoked", {
        keyIdPrefix: shortenKeyId(status.record.id),
      });
    }
    if (status.status === "expired") {
      return authErrorResponse(c, "expired", {
        keyIdPrefix: shortenKeyId(status.record.id),
      });
    }
    const keyRecord = status.record;
    // Match the legacy validateApiKey side effect: bump last_used_at /
    // usage_count (debounced internally to once per minute per key id).
    apiKeyService.recordKeyUse(keyRecord.id);

    // Near-expiry warning headers. Non-blocking — the request still succeeds;
    // expiry itself is enforced upstream (getApiKeyStatus → 401). Set before
    // next() so they persist onto whatever response the route handler emits.
    if (keyRecord.expiresAt) {
      const msLeft = keyRecord.expiresAt.getTime() - Date.now();
      if (msLeft <= KEY_EXPIRY_WARNING_DAYS * 24 * 60 * 60 * 1000) {
        c.header("X-Key-Expires-Soon", "true");
        c.header("X-Key-Expires-At", keyRecord.expiresAt.toISOString());
      }
    }

    const allowed = apiKeyService.checkRateLimit(keyRecord.id, "request");
    if (!allowed) {
      return c.json({ error: "Rate limit exceeded" }, 429);
    }

    // Default — pass-through. Used both as the "feature disabled" path and
    // as the safe fallback when the sub-token resolver fails for any reason.
    let resolvedUserId = keyRecord.userId;
    const resolvedScopes = keyRecord.scope;
    // TRUE only once the X-External-User-Id remap below has actually resolved
    // a mapping. This — not "the key has a linkedUserId" — is the honest signal
    // that `resolvedUserId` names an external end-user rather than the key
    // owner, and it is what the agent-identity remap further down must respect.
    let subTokenResolved = false;

    // Sub-token resolution — feature-flagged so existing single-key behavior
    // is the default. Anything other than the literal string "true" (incl.
    // unset) keeps the legacy behavior intact.
    //
    // IMPORTANT: skip the X-External-User-Id remap when the bearer is itself
    // a child key (Mode 2 — keyRecord.parentKeyId is set). The child key
    // already encodes the resolved Synap user; layering a header remap on
    // top would be ambiguous (whose user wins?) and would silently swap the
    // identity of legitimate child-key callers. The child key wins.
    // A person's app sign-in token (`app_person`) is that person and nobody
    // else: it never acts for an external user (app-person-token.ts, T1).
    if (
      isSubTokenFeatureEnabled() &&
      !keyRecord.parentKeyId &&
      keyRecord.keyType !== APP_PERSON_KEY_TYPE
    ) {
      const externalUserId = c.req.header("x-external-user-id");
      if (externalUserId) {
        // The source label is optional metadata (best-effort hint for the
        // auto-created user). We don't fetch the parent agent's type here —
        // doing so would add a DB round-trip on every authenticated request.
        // The mapping row keeps `source: undefined` and the resolver writes a
        // generic fallback name; integrations that want richer attribution
        // can call POST /setup/external-user with a `name` instead.
        const mapping = await resolveExternalUserMapping(
          keyRecord.id,
          externalUserId,
          {
            parentOwnerUserId: keyRecord.userId,
          }
        );
        if (mapping) {
          resolvedUserId = mapping.synapUserId;
          subTokenResolved = true;
          c.set("parentKeyId", keyRecord.id);
          c.set("externalUserId", externalUserId);
        } else {
          // Lookup/create failed — never fail closed. Fall back to the
          // parent key's owner with a warning so operators can investigate.
          logger.warn(
            { parentKeyId: keyRecord.id, externalUserId },
            "Sub-token mapping unavailable — falling back to parent key owner"
          );
        }
      }
    } else if (
      isSubTokenFeatureEnabled() &&
      keyRecord.parentKeyId &&
      c.req.header("x-external-user-id")
    ) {
      // Mode 2 (child key) bearer + an X-External-User-Id header is a misuse —
      // log it once so operators can see drift between the pipeline mode and
      // the bearer it's actually sending. We do NOT remap (the child key
      // wins) and we don't 4xx the request (the child key is still valid).
      logger.warn(
        { childKeyId: keyRecord.id, parentKeyId: keyRecord.parentKeyId },
        "Child API key sent with X-External-User-Id header — header IGNORED (child key wins)"
      );
    }

    c.set("userId", resolvedUserId);
    c.set("scopes", resolvedScopes);
    // Expose the api_keys.id of the bearer that authenticated the request,
    // so /auth/status (and any future introspection routes) can look up
    // metadata about the calling key without re-running bcrypt.
    c.set("apiKeyId", keyRecord.id);
    // SERVICE-KEY WORKSPACE CONFINEMENT (Item 3): expose the key's type +
    // workspace binding so the shared caller-context door can positively pin a
    // bound `service` key to its workspace. Inert for every other key type.
    c.set("keyType", keyRecord.keyType);
    c.set("keyWorkspaceId", keyRecord.workspaceId ?? null);
    // Which integration minted this key (F10: only the CLI's may review).
    c.set("keyHubId", keyRecord.hubId ?? null);
    // Agent key identity remap — via the ONE door `resolveKeyIdentity`
    // (access/key-identity.ts). When a key has a linkedUserId (= the human who
    // created the agent), the human owns the entities (effectiveUserId), while the
    // acting agent principal is tracked as agentUserId for proposal attribution
    // across all Hub Protocol write handlers. agentUserId is derived from the
    // principal's `userType === 'agent'` (the ONE is-agent signal), NOT from "has
    // a linked human". The is_internal X-Delegated-Operator-Id remap below layers
    // on top of this base.
    //
    // GUARD — `!subTokenResolved`, NOT `linkedUserId`. `resolveKeyIdentity` reads
    // only the api_keys row (`linkedUserId ?? userId`); it has never seen
    // `resolvedUserId`, so under a resolved sub-token its effectiveUserId is the
    // KEY's human, and an unguarded `c.set("userId", …)` here overwrites the
    // external end-user the remap above just resolved. A previous version of this
    // comment claimed the `linkedUserId` check made that impossible — it does not:
    // it tests whether the key has a linked human, which is precisely the case a
    // parent agent key holding sub-token traffic is in (agent keys are minted WITH
    // a linkedUserId; the mint fails closed rather than null it). So the guard now
    // asks the only question that matters — did a sub-token actually resolve? —
    // and when one did we set NEITHER `userId` nor `linkedUserId`: this request
    // belongs to the external end-user, and leaving `linkedUserId` on the context
    // would invite downstream dual-writes (see `rest/memory.ts`) to file the
    // external user's data under the pod owner as well. Non-sub-token traffic is
    // unchanged: a linked key's writes still own as the human.
    const keyIdentity = await resolveKeyIdentity(keyRecord);
    // Who HOLDS the key, whatever human it acts for (`/users/me.principal`).
    c.set("keyPrincipal", keyIdentity.principal);
    if (keyRecord.linkedUserId && !subTokenResolved) {
      c.set("linkedUserId", keyRecord.linkedUserId);
      c.set("userId", keyIdentity.effectiveUserId); // human owns the entities
    }
    if (keyIdentity.agentUserId) {
      c.set("agentUserId", keyIdentity.agentUserId); // agent performed the action
    }

    // ── Trusted-IS operator-floor read delegation ───────────────────────────
    // The IS orchestrator reads the pod with its shared service key. Without a
    // remap, reads scope to the service identity ("system") instead of the
    // operator whose turn the IS is processing — so the agent sees 0 entities.
    //
    // SECURITY: this remap is gated EXCLUSIVELY on keyType === "is_internal" —
    // the trusted pod-read key minted only by the CP-JWT-gated provision handler
    // (apps/api/src/routers/provision.ts). A normal key (hub_inbound, user_pat,
    // service, …) that sends X-Delegated-Operator-Id is IGNORED: the header is
    // only read inside this branch, so it can never be triggered by a key that
    // isn't is_internal. WRITES STAY GOVERNED: agentUserId is set to the IS key
    // owner, so the write-gate routes agent mutations through proposals.
    //
    // TRANSITION (D4): this branch is the LEGACY path. A current IS sends the
    // pod-signed delegation instead (`authenticateIsDelegation` above); this
    // one is accepted and logged until `SYNAP_IS_LEGACY_DELEGATION=refuse`.
    if (keyRecord.keyType === "is_internal") {
      const op = c.req.header("x-delegated-operator-id");
      if (op && !legacyIsDelegationAllowed()) {
        return authErrorResponse(c, "key_revoked", {
          message:
            "This pod no longer accepts a stored AI-service key acting for a user. The AI service must send this turn's delegation.",
        });
      }
      if (op) {
        logLegacyDelegation(keyRecord.id);
        // Validate the delegated operator names a real user on this pod before
        // trusting it as the read floor. Without this, an is_internal caller
        // could set an arbitrary header and read as any (or a non-existent) user.
        const operator = await db.query.users.findFirst({
          where: eq(users.id, op),
          columns: { id: true },
        });
        if (!operator) {
          return authErrorResponse(c, "no_auth", {
            message: "x-delegated-operator-id does not resolve to a pod user.",
          });
        }
        c.set("userId", op); // operator owns/sees the entities (data floor)
        // Attribute writes to the key owner ONLY if it's a real agent user. A
        // self-hosted IS key is owned by the "system" sentinel (no users row,
        // not userType='agent'), and setting it here made every write that
        // didn't carry its own body.agentUserId 400 ("invalid agentUserId").
        // Skip it for the sentinel: governed IS writes pass a real agentUserId
        // in the body (the acting agent); a write that omits it then falls back
        // to an operator-direct write, not the rejected "system".
        //
        // ATTRIBUTION (B1): we deliberately do NOT resolve the operator's
        // personal agent here to stamp agentUserId — doing so would flip
        // `checkPermissionOrPropose` from the operator's RBAC + legacy
        // `source:"intelligence"` path onto the AGENT governance ladder, and a
        // personal agent that isn't a member of the target workspace would then
        // file a `workspace.join` proposal instead of the intended write
        // (outcome change). Attribution is instead resolved inside
        // `createProposal` (permission-check.ts) AFTER the ladder has already
        // decided on the operator — so the OUTCOME is unchanged and only the
        // proposal's attributed agentUserId differs.
        if (keyRecord.userId && keyRecord.userId !== "system") {
          c.set("agentUserId", keyRecord.userId); // IS performed the action → proposals
        }
        c.set("linkedUserId", op);
      }
    }
    // Guest containment: evaluated on the FINAL principal (after every remap).
    const refusedKey = await refuseGuestPrincipal(c);
    if (refusedKey) return refusedKey;
    // Request write facts for the floors below: D8 probe key, D6 agent principal
    // (read AFTER every remap above set it). A plain human key enters no scope.
    // C1: the calling client, so an agent write without `X-Session-Id` groups
    // into THIS client's session (never the IS's shared key — see the helper).
    // W1 fence: a scoped key may only READ through doors whose reads are
    // bounded by its grant (access/grant-door-fence.ts). Fail closed.
    // `rel` (computed above) is the path with the mount stripped — both mounts.
    if (isFencedGrant(keyIdentity.grant)) {
      if (!restDoorAllowed(c.req.method, rel, keyIdentity.grant!)) {
        return c.json(
          { error: GRANT_DOOR_UNSUPPORTED, code: "GRANT_DOOR_UNSUPPORTED" },
          403
        );
      }
    }
    // Owner-wide doors (webhooks, …; plus write-only owner-wide doors such as
    // capability credentials): no grant narrows their effect, so only an
    // unbounded full-access key may use them.
    if (!ownerWideDoorAllowed(rel, keyIdentity.grant, c.req.method)) {
      return c.json(
        {
          error: GRANT_OWNER_WIDE_UNSUPPORTED,
          code: "GRANT_DOOR_UNSUPPORTED",
        },
        403
      );
    }
    // W1: the key's grant bounds every write gate and scoped read below.
    return runWithProbeWrites(isProbeApiKey(keyRecord), () =>
      runWithActingAgent(c.get("agentUserId") as string | undefined, () =>
        // B7: the calling key, recorded on every proposal this request files.
        runWithCallingKey(keyRecord.id, () =>
          runWithClientKey(
            clientKeyForApiKey(
              keyRecord,
              requestConversationId(c.req.header(CONVERSATION_HEADER))
            ),
            () =>
              // 0389: the model and provider the client says it runs on.
              runWithReportedModel(
                c.req.header(MODEL_HEADER),
                c.req.header(MODEL_PROVIDER_HEADER),
                () => {
                  // 0384: what the runner says it is doing, recorded off the request path.
                  void reportRunnerState();
                  return runWithGrant(keyIdentity.grant, () => next());
                }
              ),
            c.req.header(CONVERSATION_CWD_HEADER),
            c.req.header(PROCESS_HEADER),
            c.req.header(RUNNER_STATE_HEADER)
          )
        )
      )
    );
  }

  // ── 2. Try Kratos session token (browser extension / web clients) ────────
  const sessionToken = c.req.header("x-session-token");
  if (sessionToken) {
    try {
      const { getSession } = await import("@synap/auth");
      const headers = new Headers({ "x-session-token": sessionToken });
      const session = await getSession(headers);
      if (session?.identity?.id) {
        c.set("userId", session.identity.id as string);
        // Authenticated pod users get full hub-protocol scopes
        c.set("scopes", [...PERSON_SESSION_SCOPES]);
        const refusedSession = await refuseGuestPrincipal(c);
        if (refusedSession) return refusedSession;
        return next();
      }
    } catch (err) {
      logger.warn({ err }, "Session token validation failed");
    }
    // Session token was provided but rejected — surface as `key_revoked`
    // so the envelope reason set stays closed. (Session tokens are not
    // api_keys rows, but from the operator's perspective the failure mode
    // is the same: "your credential is no longer accepted".)
    return authErrorResponse(c, "key_revoked", {
      message:
        "Session token is invalid or expired. Re-authenticate via Better Auth.",
    });
  }

  return authErrorResponse(c, "no_auth");
};
