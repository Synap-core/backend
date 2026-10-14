/**
 * is-delegation — the per-turn token a pod hands its Intelligence Service
 * (SECURITY-PLAN-R1 §3, founder decision D4). The ONE place its claims are
 * written and read; signing and verification go through the pod-identity door
 * (`signPodJwt` / `verifyOwnPodJwt`), never a second signer.
 *
 * WHY. The IS used to hold each pod's `is_internal` hub key (no expiry) and
 * name the operator in `X-Delegated-Operator-Id`, so whoever held the key could
 * act as ANY pod user, forever. Now the pod decides the principal: when it
 * starts IS work for a turn it signs
 *
 *   iss  = this pod's origin            aud     = the IS origin it calls
 *   sub  = the operator (TurnPrincipal) act.sub = the acting agent, if any
 *   channel_id, run_id                  scope   = "hub-protocol.read hub-protocol.write"
 *   exp  = ≤ 15 min                     max_exp = ≤ 2 h after the first mint
 *   jti
 *
 * and the IS sends it back as `Authorization: Bearer <token>` on every hub
 * call of that turn. The pod verifies its OWN signature and takes the operator
 * from `sub`.
 *
 * REPLAY MODEL. The token is a bearer credential, multi-use within its life:
 * one turn makes many hub calls, so `jti` is NOT single-use (it identifies the
 * turn's delegation in logs and is the handle for a future deny-list). What
 * bounds a stolen token is everything else: one operator, one IS audience,
 * ≤ 15 minutes (≤ 2 h through a refresh), and the IS losing its database
 * yields nothing at all once the stored key is gone.
 *
 * MINTING CONDITION. A token is minted when this pod holds its identity key
 * file. Enrollment with the CP (`pod-cp-auth.ts`) is NOT required: the pod is
 * the only verifier, and it verifies against the same file. A hand-installed
 * pod without the file sends no token and the IS keeps using the stored key —
 * the transition the pod's hub auth still accepts (logged).
 *
 * IMPORT-LIGHT: node built-ins and the pod-identity door only. The pod→IS
 * clients import this through `@synap/database/is-delegation`, and they are
 * loaded by DB-less code and tests; `@synap-core/core` validates the whole pod
 * config at import, so its logger is loaded lazily, on a mint failure only.
 */

import {
  PodIdentityError,
  podJwtTtlCeiling,
  signPodJwt,
  verifyOwnPodJwt,
} from "./pod-identity.js";

/** The pod→IS request header that carries the token to the IS. */
export const IS_DELEGATION_HEADER = "X-Synap-Delegation";
export const IS_DELEGATION_PURPOSE = "is_delegation";
export const IS_DELEGATION_TTL_SECONDS = podJwtTtlCeiling(
  IS_DELEGATION_PURPOSE
);
/** The hard bound a refresh can never pass (`max_exp`). */
export const IS_DELEGATION_MAX_LIFETIME_SECONDS = 2 * 60 * 60;
/** What the `is_internal` key held; a delegation carries no more. */
export const IS_DELEGATION_SCOPES = [
  "hub-protocol.read",
  "hub-protocol.write",
] as const;

export interface IsDelegationGrant {
  /** The IS endpoint the pod is calling; its origin becomes `aud`. */
  isUrl: string;
  /** Who the turn runs as (the TurnPrincipal) — becomes `sub`. */
  operatorUserId: string;
  /** The acting agent of the turn, if any — becomes `act.sub`. */
  agentUserId?: string | null;
  channelId?: string | null;
  runId?: string | null;
  /** A refresh keeps the original bound; omitted = now + 2 h. */
  maxExpiresAt?: number;
}

export interface VerifiedIsDelegation {
  operatorUserId: string;
  agentUserId: string | null;
  channelId: string | null;
  runId: string | null;
  scopes: string[];
  /** The IS origin the token was minted for. */
  audience: string;
  jti: string;
  /** Unix seconds. */
  expiresAt: number;
  maxExpiresAt: number;
}

/** An optional string claim: absent → null, a non-empty string → it, else undefined (invalid). */
function optionalString(value: unknown): string | null | undefined {
  if (value === undefined) return null;
  return typeof value === "string" && value ? value : undefined;
}

/** Sign a delegation for one turn. Throws `PodIdentityError`. */
export function mintIsDelegationToken(
  grant: IsDelegationGrant,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): string {
  if (!grant.operatorUserId) {
    throw new PodIdentityError(
      "POD_JWT_BAD_REQUEST",
      "A delegation names the operator it runs as."
    );
  }
  let audience: string;
  try {
    audience = new URL(grant.isUrl).origin;
  } catch {
    throw new PodIdentityError(
      "POD_JWT_BAD_REQUEST",
      "A delegation's audience must be the AI service URL."
    );
  }
  const maxExp =
    grant.maxExpiresAt ?? nowSeconds + IS_DELEGATION_MAX_LIFETIME_SECONDS;
  const ttl = Math.min(IS_DELEGATION_TTL_SECONDS, maxExp - nowSeconds);
  if (ttl <= 0) {
    throw new PodIdentityError(
      "POD_JWT_EXPIRED",
      "This delegation has reached its maximum lifetime."
    );
  }
  return signPodJwt(
    { audience, purpose: IS_DELEGATION_PURPOSE },
    {
      sub: grant.operatorUserId,
      ...(grant.agentUserId ? { act: { sub: grant.agentUserId } } : {}),
      ...(grant.channelId ? { channel_id: grant.channelId } : {}),
      ...(grant.runId ? { run_id: grant.runId } : {}),
      scope: IS_DELEGATION_SCOPES.join(" "),
      max_exp: maxExp,
    },
    ttl
  );
}

const loggedMintFailures = new Map<string, number>();
const MINT_FAILURE_LOG_INTERVAL_MS = 60_000;

/**
 * The header to attach to a pod→IS request that starts IS work for a turn:
 * `{ "X-Synap-Delegation": <token> }`, or `{}` when this pod cannot sign.
 *
 * TRANSITION (D4 steps 1–4): no token is not an error yet — the IS then uses
 * the stored `is_internal` key, which the pod still accepts. "No key file" is
 * a fact about a hand-installed pod and stays quiet; a key file that exists
 * but cannot sign (unreadable, wrong curve, no PUBLIC_URL) is logged as an
 * error once a minute, so it is never mistaken for "not set up". After the
 * cut-over (step 5) there is no fallback and this must throw instead.
 */
export function isDelegationHeaders(
  grant: IsDelegationGrant
): Record<string, string> {
  try {
    return { [IS_DELEGATION_HEADER]: mintIsDelegationToken(grant) };
  } catch (err) {
    const code =
      err instanceof PodIdentityError ? err.code : "IS_DELEGATION_MINT_FAILED";
    if (code === "POD_IDENTITY_MISSING") return {};
    const last = loggedMintFailures.get(code) ?? 0;
    if (Date.now() - last >= MINT_FAILURE_LOG_INTERVAL_MS) {
      loggedMintFailures.set(code, Date.now());
      const message = err instanceof Error ? err.message : String(err);
      void import("@synap-core/core")
        .then(({ createLogger }) =>
          createLogger({ module: "is-delegation" }).error(
            { code, message },
            "IS delegation token could not be minted — the AI service falls back to its stored pod key"
          )
        )
        .catch(() => undefined); // a log line must never fail the request
    }
    return {};
  }
}

/**
 * Verify a delegation the IS handed back. `isKnownAudience` answers whether
 * `aud` is an AI service this pod still uses (a disconnected service's tokens
 * die with it). Throws `PodIdentityError` (`POD_JWT_INVALID` /
 * `POD_JWT_EXPIRED`); the caller checks that the operator is a pod user.
 */
export async function verifyIsDelegationToken(
  token: string,
  options: {
    isKnownAudience: (audience: string) => boolean | Promise<boolean>;
    nowSeconds?: number;
  }
): Promise<VerifiedIsDelegation> {
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const payload = verifyOwnPodJwt(token, IS_DELEGATION_PURPOSE, now);
  const invalid = (why: string) =>
    new PodIdentityError("POD_JWT_INVALID", `This delegation ${why}.`);

  const audience = payload.aud as string;
  if (!(await options.isKnownAudience(audience))) {
    throw invalid("is for an AI service this pod does not use");
  }
  const sub = payload.sub;
  if (typeof sub !== "string" || !sub) throw invalid("names no operator");

  const maxExp = payload.max_exp;
  const iat = payload.iat as number;
  const exp = payload.exp as number;
  if (
    typeof maxExp !== "number" ||
    exp > maxExp ||
    maxExp - iat > IS_DELEGATION_MAX_LIFETIME_SECONDS
  ) {
    // exp ≤ max_exp, so "past max_exp" is already refused as expired above.
    throw invalid("has an invalid maximum lifetime");
  }

  const scopes =
    typeof payload.scope === "string"
      ? payload.scope.split(" ").filter(Boolean)
      : [];
  if (
    scopes.length === 0 ||
    !scopes.every((s) =>
      (IS_DELEGATION_SCOPES as readonly string[]).includes(s)
    )
  ) {
    throw invalid("carries an unknown scope");
  }

  let agentUserId: string | null = null;
  if (payload.act !== undefined) {
    const act = payload.act as { sub?: unknown } | null;
    if (!act || typeof act !== "object" || typeof act.sub !== "string") {
      throw invalid("names an invalid acting agent");
    }
    agentUserId = act.sub;
  }
  const channelId = optionalString(payload.channel_id);
  const runId = optionalString(payload.run_id);
  if (channelId === undefined || runId === undefined) {
    throw invalid("carries an invalid channel or run");
  }

  return {
    operatorUserId: sub,
    agentUserId,
    channelId,
    runId,
    scopes,
    audience,
    jti: payload.jti as string,
    expiresAt: exp,
    maxExpiresAt: maxExp,
  };
}

/**
 * Refresh a delegation the IS still holds (`POST /api/hub/delegation/refresh`,
 * SECURITY-PLAN-R1 §3 "for long IS work"). The current token must verify; the
 * new one carries the SAME sub, act, channel, run, audience and `max_exp`, a
 * new `jti`, and `exp = min(now + 15 min, max_exp)`. A token at or past
 * `max_exp` cannot be refreshed (it no longer verifies; a refresh that would
 * leave no lifetime throws `POD_JWT_EXPIRED`). Nothing widens: no claim the
 * caller sends is read — only the verified token.
 *
 * The previous token is NOT revoked: calls of the same turn already in flight
 * still carry it, and it dies at its own `exp` (≤ 15 min). A refresh chain
 * therefore holds at most two live tokens for one turn, both bounded by the
 * same `max_exp` (see REPLAY MODEL above).
 */
export async function refreshIsDelegationToken(
  token: string,
  options: {
    isKnownAudience: (audience: string) => boolean | Promise<boolean>;
    nowSeconds?: number;
  }
): Promise<{
  token: string;
  /** Unix seconds. */
  expiresAt: number;
  previous: VerifiedIsDelegation;
}> {
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const previous = await verifyIsDelegationToken(token, {
    isKnownAudience: options.isKnownAudience,
    nowSeconds: now,
  });
  const next = mintIsDelegationToken(
    {
      isUrl: previous.audience,
      operatorUserId: previous.operatorUserId,
      agentUserId: previous.agentUserId,
      channelId: previous.channelId,
      runId: previous.runId,
      maxExpiresAt: previous.maxExpiresAt,
    },
    now
  );
  const { exp } = JSON.parse(
    Buffer.from(next.split(".")[1]!, "base64url").toString("utf8")
  ) as { exp: number };
  return { token: next, expiresAt: exp, previous };
}
