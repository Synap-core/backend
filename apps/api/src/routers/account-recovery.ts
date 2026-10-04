/**
 * Pod account recovery — `/api/account-recovery/*`.
 *
 * The contract (request/response shapes) is `@synap-core/types/account-recovery`;
 * this is its one implementation. Real dependencies are wired in
 * `account-recovery-deps.ts`; this file holds every decision, so the tests
 * drive the real routes with fake dependencies.
 *
 *   GET  /doors        unauthenticated — which "Can't sign in?" doors work here
 *   POST /redeem       unauthenticated — trade a recovery code for a one-time
 *                      Kratos recovery link (privileged settings flow)
 *   GET  /status       session — codes set?, courier, Cloud trust, session marks
 *   POST /codes        session, privileged — create / regenerate the batch
 *   PUT  /cloud-trust  session, privileged, pod admin — off | sign_in | sign_in_recovery
 *
 * Redeem is the online guessing target, so it is:
 *   - rate limited per email AND globally (per-IP is a shared bucket behind
 *     Cloudflare);
 *   - constant work: one scrypt derivation whether or not the account exists,
 *     and a response-time floor, so a wrong email and a wrong code answer the
 *     same `401 invalid_code` in the same time class;
 *   - single use: the claim is `UPDATE … WHERE used_at IS NULL`;
 *   - never logged: no code (typed, stored or Kratos') reaches a logger or an
 *     event, and nothing goes to the Control Plane or the IS.
 */

import { createHash, randomUUID } from "node:crypto";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import {
  formatRecoveryCode,
  isCloudTrustMode,
  normalizeRecoveryCode,
  type AccountRecoveryError,
  type AccountRecoveryErrorCode,
  type AccountRecoveryStatus,
  type CloudTrustMode,
  type GeneratedRecoveryCodes,
  type RecoveryDoors,
  type RedeemRecoveryCodeSuccess,
} from "@synap-core/types/account-recovery";
import {
  generateRecoveryCodes,
  hashRecoveryCode,
  matchRecoveryCode,
  newBatchSalt,
  type CandidateCode,
} from "../account-recovery/codes.js";
import {
  decideCredentialChange,
  sessionIsCloudOnly,
  sessionIsPrivileged,
  type KratosSessionLike,
} from "../account-recovery/policy.js";
import {
  FixedWindowLimiter,
  REDEEM_GLOBAL,
  REDEEM_PER_EMAIL,
} from "../account-recovery/rate-limit.js";

export interface RecoveryLogger {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}

export interface PodAccount {
  /** `users.id` — the key recovery codes are stored under. */
  userId: string;
  /** The Kratos identity id (`users.kratos_identity_id`, else `users.id`). */
  identityId: string;
}

export interface KratosRecoveryLink {
  recoveryLink: string;
  recoveryCode: string;
  expiresAt: string;
}

export interface AccountRecoveryDeps {
  now(): Date;
  sleep(ms: number): Promise<void>;
  logger: RecoveryLogger;

  /** Session middlewares for the authenticated routes (auth + guest refusal). */
  authenticate: MiddlewareHandler[];

  findAccountByEmail(email: string): Promise<PodAccount | null>;
  findAccountByIdentity(identityId: string): Promise<PodAccount | null>;

  codes: {
    listUnused(userId: string): Promise<CandidateCode[]>;
    claim(id: string, usedAt: Date): Promise<boolean>;
    release(id: string, usedAt: Date): Promise<void>;
    replaceBatch(
      userId: string,
      batchId: string,
      codeHashes: readonly string[],
      createdAt: Date
    ): Promise<void>;
    summary(
      userId: string
    ): Promise<{ total: number; remaining: number; createdAt: Date | null }>;
    anyUnused(): Promise<boolean>;
  };

  /** Kratos admin `POST /admin/recovery/code` (browser flow). Throws on failure. */
  createKratosRecovery(identityId: string): Promise<KratosRecoveryLink>;
  /** Kratos admin `DELETE /admin/identities/{id}/sessions`. Throws on failure. */
  revokeIdentitySessions(identityId: string): Promise<void>;
  /** Kratos admin identity read: password / passkey present. Throws on failure. */
  identityHasPodHeldCredential(identityId: string): Promise<boolean>;

  readCloudTrust(): Promise<CloudTrustMode>;
  writeCloudTrust(mode: CloudTrustMode): Promise<void>;
  /** A CP OIDC client is configured on this pod. */
  cloudSignInAvailable(): Promise<boolean>;
  courierStatus(): "configured" | "catchall" | "unknown";
  isPodAdmin(userId: string): Promise<boolean>;

  /** Best-effort audit append. Never receives a code. */
  audit(entry: {
    userId: string;
    change: string;
    data?: Record<string, unknown>;
  }): Promise<void>;
}

/** A wrong email and a wrong code both wait until at least this long. */
export const REDEEM_MIN_RESPONSE_MS = 350;
/** Kratos one-time recovery flow lifetime handed to the redeemer. */
export const KRATOS_RECOVERY_EXPIRES_IN = "15m";

const MESSAGES: Record<AccountRecoveryErrorCode, string> = {
  invalid_code: "That email and recovery code don't match an unused code.",
  rate_limited: "Too many attempts. Wait 15 minutes and try again.",
  recovery_unavailable:
    "Recovery is unavailable on this pod right now. Try again in a few minutes.",
  invalid_request: "Enter your email and a recovery code.",
  unauthorized: "Sign in first.",
  reauth_required: "Sign in again to confirm it's you.",
  cloud_session_not_allowed:
    "Signing in with Synap Cloud can't change how you sign in to this pod. Sign in with your pod password, or use a recovery code.",
  forbidden: "Only the pod owner can change this.",
};

function fail(
  c: Context,
  code: AccountRecoveryErrorCode,
  status: 400 | 401 | 403 | 429 | 503
) {
  const body: AccountRecoveryError = {
    ok: false,
    error: code,
    message: MESSAGES[code],
  };
  return c.json(body, status);
}

function emailKey(email: string): string {
  return createHash("sha256").update(email).digest("hex").slice(0, 32);
}

/** The pod-admin URL Relay/browser open: Kratos' link + the one-time code in the FRAGMENT. */
export function buildContinueUrl(link: KratosRecoveryLink): string {
  return `${link.recoveryLink}#code=${encodeURIComponent(link.recoveryCode)}`;
}

export interface AccountRecoveryLimiters {
  perEmail: FixedWindowLimiter;
  global: FixedWindowLimiter;
}

export function defaultLimiters(now: () => number = Date.now) {
  return {
    perEmail: new FixedWindowLimiter(
      REDEEM_PER_EMAIL.limit,
      REDEEM_PER_EMAIL.windowMs,
      now
    ),
    global: new FixedWindowLimiter(
      REDEEM_GLOBAL.limit,
      REDEEM_GLOBAL.windowMs,
      now
    ),
  } satisfies AccountRecoveryLimiters;
}

export function createAccountRecoveryRouter(
  deps: AccountRecoveryDeps,
  limiters: AccountRecoveryLimiters = defaultLimiters()
) {
  const router = new Hono();
  const { logger } = deps;

  // ── Unauthenticated ───────────────────────────────────────────────────

  router.get("/doors", async (c) => {
    try {
      const [anyCodes, trust, cloudAvailable] = await Promise.all([
        deps.codes.anyUnused(),
        deps.readCloudTrust(),
        deps.cloudSignInAvailable(),
      ]);
      const doors: RecoveryDoors = {
        recoveryCode: anyCodes,
        email: deps.courierStatus() === "configured",
        cloud: trust === "sign_in_recovery" && cloudAvailable,
      };
      return c.json(doors);
    } catch (err) {
      logger.error({ err }, "[account-recovery] doors read failed");
      return fail(c, "recovery_unavailable", 503);
    }
  });

  router.post("/redeem", async (c) => {
    const started = deps.now().getTime();
    const floor = async () => {
      const elapsed = deps.now().getTime() - started;
      if (elapsed < REDEEM_MIN_RESPONSE_MS) {
        await deps.sleep(REDEEM_MIN_RESPONSE_MS - elapsed);
      }
    };

    const body = (await c.req.json().catch(() => null)) as {
      email?: unknown;
      code?: unknown;
    } | null;
    const email =
      typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
    const typed = typeof body?.code === "string" ? body.code : "";
    if (!email || email.length > 254 || !typed || typed.length > 64) {
      return fail(c, "invalid_request", 400);
    }

    // Both buckets are charged for every attempt, known account or not, so a
    // 429 says nothing about whether the email exists.
    const globalOk = limiters.global.hit("global");
    const emailOk = limiters.perEmail.hit(emailKey(email));
    if (!globalOk || !emailOk) {
      logger.warn(
        { emailKey: emailKey(email), scope: globalOk ? "email" : "global" },
        "[account-recovery] redeem rate limited"
      );
      return fail(c, "rate_limited", 429);
    }

    const normalized = normalizeRecoveryCode(typed);
    let account: PodAccount | null;
    let candidates: CandidateCode[];
    try {
      account = await deps.findAccountByEmail(email);
      candidates = account ? await deps.codes.listUnused(account.userId) : [];
    } catch (err) {
      logger.error({ err }, "[account-recovery] redeem read failed");
      await floor();
      return fail(c, "recovery_unavailable", 503);
    }

    const matchedId = await matchRecoveryCode(normalized, candidates);
    if (!account || !matchedId) {
      if (account) {
        // Not awaited: an extra write only for KNOWN accounts would put the
        // two failure answers in different time classes.
        void deps
          .audit({ userId: account.userId, change: "account_recovery.code_rejected" })
          .catch(() => undefined);
      }
      await floor();
      return fail(c, "invalid_code", 401);
    }

    const claimedAt = deps.now();
    let claimed: boolean;
    try {
      claimed = await deps.codes.claim(matchedId, claimedAt);
    } catch (err) {
      logger.error({ err }, "[account-recovery] redeem claim failed");
      await floor();
      return fail(c, "recovery_unavailable", 503);
    }
    if (!claimed) {
      // A concurrent redeem of the same code won. Same answer as a wrong code.
      await floor();
      return fail(c, "invalid_code", 401);
    }

    let link: KratosRecoveryLink;
    try {
      link = await deps.createKratosRecovery(account.identityId);
      await deps.revokeIdentitySessions(account.identityId);
    } catch (err) {
      // The pod could not finish the recovery: give the code back rather than
      // burn it on our outage.
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        "[account-recovery] Kratos recovery failed — code released"
      );
      await deps.codes.release(matchedId, claimedAt).catch((releaseErr) =>
        logger.error(
          { err: releaseErr },
          "[account-recovery] code release failed"
        )
      );
      await floor();
      return fail(c, "recovery_unavailable", 503);
    }

    const remaining = Math.max(0, candidates.length - 1);
    await deps.audit({
      userId: account.userId,
      change: "account_recovery.code_redeemed",
      data: { remaining, sessionsRevoked: true },
    });
    logger.info(
      { userId: account.userId, remaining },
      "[account-recovery] recovery code redeemed"
    );
    await floor();
    const ok: RedeemRecoveryCodeSuccess = {
      ok: true,
      continueUrl: buildContinueUrl(link),
      expiresAt: link.expiresAt,
      sessionsRevoked: true,
    };
    return c.json(ok);
  });

  // ── Authenticated ─────────────────────────────────────────────────────

  for (const path of ["/status", "/codes", "/cloud-trust"]) {
    router.use(path, ...deps.authenticate);
  }

  interface Caller {
    account: PodAccount;
    session: KratosSessionLike;
    privileged: boolean;
    cloudOnly: boolean;
  }

  async function resolveCaller(c: Context): Promise<Caller | null> {
    const identityId = c.get("userId" as never) as string | undefined;
    const session = (c.get("session" as never) ?? {}) as KratosSessionLike;
    if (!identityId) return null;
    const account = await deps.findAccountByIdentity(identityId);
    if (!account) return null;
    return {
      account,
      session,
      privileged: sessionIsPrivileged(session, deps.now()),
      cloudOnly: sessionIsCloudOnly(session),
    };
  }

  async function accountHasPodHeldFactor(account: PodAccount) {
    const [kratosFactor, summary] = await Promise.all([
      deps.identityHasPodHeldCredential(account.identityId),
      deps.codes.summary(account.userId),
    ]);
    return kratosFactor || summary.remaining > 0;
  }

  async function buildStatus(caller: Caller): Promise<AccountRecoveryStatus> {
    const [summary, trust, cloudAvailable, canEdit, podHeld] =
      await Promise.all([
        deps.codes.summary(caller.account.userId),
        deps.readCloudTrust(),
        deps.cloudSignInAvailable(),
        deps.isPodAdmin(caller.account.userId),
        accountHasPodHeldFactor(caller.account),
      ]);
    const courier = deps.courierStatus();
    const decision = decideCredentialChange({
      trust,
      cloudOnly: caller.cloudOnly,
      accountHasPodHeldFactor: podHeld,
    });
    return {
      recoveryCodes: {
        set: summary.remaining > 0,
        remaining: summary.remaining,
        total: summary.total,
        createdAt: summary.createdAt ? summary.createdAt.toISOString() : null,
      },
      courier: { configured: courier === "configured", status: courier },
      cloud: { trust, available: cloudAvailable, canEdit },
      session: {
        privileged: caller.privileged,
        cloudOnly: caller.cloudOnly,
        canManage: caller.privileged && decision.allow,
      },
    };
  }

  /**
   * The gate every credential-changing route passes: a recent sign-in, then
   * the R1 Cloud rule. Returns a response when refused.
   */
  async function guardCredentialChange(c: Context, caller: Caller) {
    if (!caller.privileged) return fail(c, "reauth_required", 403);
    const decision = decideCredentialChange({
      trust: await deps.readCloudTrust(),
      cloudOnly: caller.cloudOnly,
      accountHasPodHeldFactor: await accountHasPodHeldFactor(caller.account),
    });
    if (!decision.allow) return fail(c, "cloud_session_not_allowed", 403);
    return null;
  }

  router.get("/status", async (c) => {
    try {
      const caller = await resolveCaller(c);
      if (!caller) return fail(c, "unauthorized", 401);
      return c.json(await buildStatus(caller));
    } catch (err) {
      logger.error({ err }, "[account-recovery] status read failed");
      return fail(c, "recovery_unavailable", 503);
    }
  });

  router.post("/codes", async (c) => {
    try {
      const caller = await resolveCaller(c);
      if (!caller) return fail(c, "unauthorized", 401);
      const refused = await guardCredentialChange(c, caller);
      if (refused) return refused;

      const codes = generateRecoveryCodes();
      const salt = newBatchSalt();
      const hashes = await Promise.all(
        codes.map((code) => hashRecoveryCode(code, salt))
      );
      const createdAt = deps.now();
      await deps.codes.replaceBatch(
        caller.account.userId,
        randomUUID(),
        hashes,
        createdAt
      );
      await deps.audit({
        userId: caller.account.userId,
        change: "account_recovery.codes_generated",
        data: { count: codes.length, cloudOnly: caller.cloudOnly },
      });
      const body: GeneratedRecoveryCodes = {
        ok: true,
        codes: codes.map(formatRecoveryCode),
        createdAt: createdAt.toISOString(),
      };
      c.header("Cache-Control", "no-store");
      return c.json(body);
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        "[account-recovery] code generation failed"
      );
      return fail(c, "recovery_unavailable", 503);
    }
  });

  router.put("/cloud-trust", async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      mode?: unknown;
    } | null;
    if (!isCloudTrustMode(body?.mode)) return fail(c, "invalid_request", 400);
    const mode = body.mode;
    try {
      const caller = await resolveCaller(c);
      if (!caller) return fail(c, "unauthorized", 401);
      if (!(await deps.isPodAdmin(caller.account.userId))) {
        return fail(c, "forbidden", 403);
      }
      const refused = await guardCredentialChange(c, caller);
      if (refused) return refused;
      const previous = await deps.readCloudTrust();
      await deps.writeCloudTrust(mode);
      await deps.audit({
        userId: caller.account.userId,
        change: "account_recovery.cloud_trust_changed",
        data: { from: previous, to: mode },
      });
      return c.json(await buildStatus(caller));
    } catch (err) {
      logger.error({ err }, "[account-recovery] cloud trust write failed");
      return fail(c, "recovery_unavailable", 503);
    }
  });

  return router;
}
