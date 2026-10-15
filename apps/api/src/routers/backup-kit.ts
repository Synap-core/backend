/**
 * The owner's restic recovery kit — `/api/backup/*` (W7-PLAN §4, option B:
 * re-downloadable behind a fresh sign-in, confirmed by reading it back).
 *
 *   POST /recovery-kit          owner, privileged (≤ 15 min since sign-in), not
 *                               a Cloud-only session → the kit as a download
 *   POST /recovery-kit/confirm  owner → { last6 } typed back from the kit →
 *                               the marker becomes `saved`
 *
 * The kit opens every backup, so:
 *   - the bytes leave the pod only in the download's body: never a log line,
 *     an audit field, an error message or another response;
 *   - the download is `no-store` and audited (who, when — never what);
 *   - the confirm compares in constant time and is rate limited per owner;
 *   - a Cloud-only session never gets the kit (`decideOwnerSecretRead`), so the
 *     Control Plane cannot fetch what it must never read.
 *
 * Decisions live here; the files and Postgres are wired in
 * `backup-kit-deps.ts`, so the tests drive the real routes with fakes.
 */

import { Hono, type Context, type MiddlewareHandler } from "hono";
import type { CloudTrustMode } from "@synap-core/types/account-recovery";
import {
  decideOwnerSecretRead,
  sessionIsCloudOnly,
  sessionIsPrivileged,
  type KratosSessionLike,
} from "../account-recovery/policy.js";
import { FixedWindowLimiter } from "../account-recovery/rate-limit.js";
import { kitPasswordTail, readBackMatches } from "../backup-kit/kit-store.js";
import type { PodAccount, RecoveryLogger } from "./account-recovery.js";

export type BackupKitErrorCode =
  | "unauthorized"
  | "forbidden"
  | "reauth_required"
  | "cloud_session_not_allowed"
  | "invalid_request"
  | "kit_not_found"
  | "kit_mismatch"
  | "rate_limited"
  | "kit_unavailable";

const MESSAGES: Record<BackupKitErrorCode, string> = {
  unauthorized: "Sign in first.",
  forbidden: "Only the pod owner can do this.",
  reauth_required: "Sign in again to confirm it's you.",
  cloud_session_not_allowed:
    "A Synap Cloud sign-in can't download the recovery kit. Sign in with your pod password.",
  invalid_request: "Type the last 6 characters of the password.",
  kit_not_found:
    "This pod has no recovery kit. Turn on off-site backups first.",
  kit_mismatch: "Those aren't the last 6 characters of the password.",
  rate_limited: "Too many attempts. Wait 15 minutes and try again.",
  kit_unavailable:
    "The recovery kit can't be read right now. Try again in a few minutes.",
};

function fail(
  c: Context,
  code: BackupKitErrorCode,
  status: 400 | 401 | 403 | 404 | 422 | 429 | 503
) {
  return c.json({ ok: false, error: code, message: MESSAGES[code] }, status);
}

export interface BackupKitDeps {
  now(): Date;
  logger: RecoveryLogger;
  /** Session middlewares (auth + guest refusal). */
  authenticate: MiddlewareHandler[];
  findAccountByIdentity(identityId: string): Promise<PodAccount | null>;
  isPodAdmin(userId: string): Promise<boolean>;
  readCloudTrust(): Promise<CloudTrustMode>;
  kit: {
    /** The kit text; null when none was generated. Throws on any other failure. */
    readText(): Promise<string | null>;
    /** Throws when the marker cannot be written. */
    markSaved(): Promise<void>;
  };
  /** The pod's public host, for the file name; null when unknown. */
  podHost(): string | null;
  /** Best-effort audit append. Never receives the kit. */
  audit(entry: {
    userId: string;
    change: string;
    data?: Record<string, unknown>;
  }): Promise<void>;
}

/** Read-back attempts per owner per window. */
export const KIT_CONFIRM_LIMIT = { limit: 5, windowMs: 15 * 60 * 1000 };

/** `synap-recovery-kit-<host>.txt`, safe for a Content-Disposition header. */
export function kitFileName(host: string | null): string {
  const slug = (host ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug ? `synap-recovery-kit-${slug}.txt` : "synap-recovery-kit.txt";
}

export function createBackupKitRouter(
  deps: BackupKitDeps,
  confirmLimiter: FixedWindowLimiter = new FixedWindowLimiter(
    KIT_CONFIRM_LIMIT.limit,
    KIT_CONFIRM_LIMIT.windowMs
  )
) {
  const router = new Hono();
  const { logger } = deps;
  router.use("*", ...deps.authenticate);

  /** The owner behind this session, or the refusal to send. */
  async function owner(c: Context) {
    const identityId = c.get("userId" as never) as string | undefined;
    const session = (c.get("session" as never) ?? {}) as KratosSessionLike;
    if (!identityId) return { refused: fail(c, "unauthorized", 401) } as const;
    const account = await deps.findAccountByIdentity(identityId);
    if (!account) return { refused: fail(c, "unauthorized", 401) } as const;
    if (!(await deps.isPodAdmin(account.userId))) {
      return { refused: fail(c, "forbidden", 403) } as const;
    }
    return { account, session } as const;
  }

  router.post("/recovery-kit", async (c) => {
    try {
      const who = await owner(c);
      if ("refused" in who) return who.refused;
      if (!sessionIsPrivileged(who.session, deps.now())) {
        return fail(c, "reauth_required", 403);
      }
      const decision = decideOwnerSecretRead({
        trust: await deps.readCloudTrust(),
        cloudOnly: sessionIsCloudOnly(who.session),
      });
      if (!decision.allow) return fail(c, decision.reason, 403);

      const text = await deps.kit.readText();
      if (text === null) return fail(c, "kit_not_found", 404);
      await deps.audit({
        userId: who.account.userId,
        change: "backup.recovery_kit_downloaded",
      });
      c.header("Cache-Control", "no-store");
      c.header(
        "Content-Disposition",
        `attachment; filename="${kitFileName(deps.podHost())}"`
      );
      c.header("Content-Type", "text/plain; charset=utf-8");
      return c.body(text, 200);
    } catch (err) {
      // The error's code only: a read error never carries the kit, but its
      // message names the path, and that is all the log needs.
      logger.error(
        { code: (err as NodeJS.ErrnoException)?.code ?? "unknown" },
        "[backup-kit] recovery kit read failed"
      );
      return fail(c, "kit_unavailable", 503);
    }
  });

  router.post("/recovery-kit/confirm", async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      last6?: unknown;
    } | null;
    const typed = typeof body?.last6 === "string" ? body.last6 : "";
    if (!typed || typed.length > 32) return fail(c, "invalid_request", 400);
    try {
      const who = await owner(c);
      if ("refused" in who) return who.refused;
      if (!confirmLimiter.hit(who.account.userId)) {
        logger.warn(
          { userId: who.account.userId },
          "[backup-kit] read-back rate limited"
        );
        return fail(c, "rate_limited", 429);
      }
      const text = await deps.kit.readText();
      if (text === null) return fail(c, "kit_not_found", 404);
      const tail = kitPasswordTail(text);
      if (!tail) {
        logger.error({}, "[backup-kit] the kit has no password line");
        return fail(c, "kit_unavailable", 503);
      }
      if (!readBackMatches(typed, tail)) {
        await deps.audit({
          userId: who.account.userId,
          change: "backup.recovery_kit_readback_rejected",
        });
        return fail(c, "kit_mismatch", 422);
      }
      await deps.kit.markSaved();
      await deps.audit({
        userId: who.account.userId,
        change: "backup.recovery_kit_saved",
      });
      return c.json({ ok: true, recoveryKitSaved: true });
    } catch (err) {
      logger.error(
        { code: (err as NodeJS.ErrnoException)?.code ?? "unknown" },
        "[backup-kit] read-back failed"
      );
      return fail(c, "kit_unavailable", 503);
    }
  });

  return router;
}
