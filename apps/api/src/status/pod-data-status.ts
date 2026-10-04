/**
 * Pod DATA answers: GET /status/backup (via `readBackupStatus`) and /health's `data`.
 * A data alarm is a body field, never a non-200 — canary swaps and healthchecks gate on HTTP status.
 * Both routes are public: error detail goes to the server log, never the body.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "@synap-core/core";
import type { BackupStatus, BackupRunSummary } from "@synap/database";

/** Where a public route's error detail goes instead of its response body. */
export type ErrorLog = (err: unknown, msg: string) => void;
const statusLogger = createLogger({ module: "pod-data-status" });
const logToServer: ErrorLog = (err, msg) => statusLogger.error({ err }, msg);

// ── /status/backup ──────────────────────────────────────────────────────────

/** A run as the PUBLIC route shows it: no fingerprint (row counts), no reason text. */
export interface PublicBackupRun {
  at: string;
  status: BackupRunSummary["status"];
  sizeBytes: number | null;
  snapshotId: string | null;
}

export interface PublicBackupStatus {
  status: BackupStatus["status"] | "unknown";
  offsite: boolean | null;
  lastBackup: PublicBackupRun | null;
  lastSuccessAt: string | null;
  lastDrill: Pick<PublicBackupRun, "at" | "status"> | null;
  staleAfterHours: number | null;
  checkedAt: string;
  note?: string;
}

const publicRun = (r: BackupRunSummary | null): PublicBackupRun | null =>
  r ? { at: r.at, status: r.status, sizeBytes: r.sizeBytes, snapshotId: r.snapshotId } : null;

export function toPublicBackupStatus(s: BackupStatus, now: Date): PublicBackupStatus {
  return {
    status: s.status,
    offsite: s.offsite,
    lastBackup: publicRun(s.lastBackup),
    lastSuccessAt: s.lastSuccess?.at ?? null,
    lastDrill: s.lastDrill ? { at: s.lastDrill.at, status: s.lastDrill.status } : null,
    staleAfterHours: s.staleAfterHours,
    checkedAt: now.toISOString(),
  };
}

/**
 * The /status/backup body. A failed ledger read is `unknown` + a note (HTTP
 * 200, like /status/release's degraded lookups) — never "never".
 */
export async function backupStatusBody(
  read: () => Promise<BackupStatus>,
  now: Date = new Date(),
  log: ErrorLog = logToServer
): Promise<PublicBackupStatus> {
  try {
    return toPublicBackupStatus(await read(), now);
  } catch (err) {
    log(err, "GET /status/backup: could not read backup_runs");
    return {
      status: "unknown",
      offsite: null,
      lastBackup: null,
      lastSuccessAt: null,
      lastDrill: null,
      staleAfterHours: null,
      checkedAt: now.toISOString(),
      note: "Could not read backup_runs (details are in the server log).",
    };
  }
}

// ── /health data check ──────────────────────────────────────────────────────

/** Where deploy/state is visible inside the backend (compose mounts deploy/ ro). */
export const DEFAULT_POD_STATE_DIR = "/opt/synap/deploy/state";

export interface DataHealth {
  /** ok · empty (had users, now none — ALARM) · unknown (could not check) */
  status: "ok" | "empty" | "unknown";
  /** deploy/state/postgres-initialized present; null = state dir not visible here */
  initialized: boolean | null;
  hasUsers: boolean | null;
  checkedAt: string;
  /** A fixed public phrase; the detail is in the server log. */
  error?: string;
}

export interface DataHealthDeps {
  stateDir: string;
  hasUsers: () => Promise<boolean>;
  exists?: (path: string) => boolean;
  timeoutMs?: number;
  now?: () => Date;
  log?: ErrorLog;
}

const USERS_CHECK_TIMED_OUT = "users check timed out";

export async function checkDataHealth(deps: DataHealthDeps): Promise<DataHealth> {
  const exists = deps.exists ?? existsSync;
  const checkedAt = (deps.now ?? (() => new Date()))().toISOString();
  const initialized = exists(deps.stateDir)
    ? exists(join(deps.stateDir, "postgres-initialized"))
    : null;
  let hasUsers: boolean;
  try {
    hasUsers = await Promise.race([
      deps.hasUsers(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(USERS_CHECK_TIMED_OUT)), deps.timeoutMs ?? 2000).unref?.()
      ),
    ]);
  } catch (err) {
    (deps.log ?? logToServer)(err, "GET /health: users check failed");
    const timedOut = err instanceof Error && err.message === USERS_CHECK_TIMED_OUT;
    return {
      status: "unknown",
      initialized,
      hasUsers: null,
      checkedAt,
      error: timedOut ? USERS_CHECK_TIMED_OUT : "users check failed",
    };
  }
  return {
    status: initialized === true && !hasUsers ? "empty" : "ok",
    initialized,
    hasUsers,
    checkedAt,
  };
}

/** Memoize for `ttlMs` so /health stays cheap under 10 s probes. */
export function cachedDataHealth(
  deps: DataHealthDeps,
  ttlMs = 30_000
): () => Promise<DataHealth> {
  let last: { at: number; value: Promise<DataHealth> } | null = null;
  return () => {
    const t = Date.now();
    if (!last || t - last.at > ttlMs) last = { at: t, value: checkDataHealth(deps) };
    return last.value;
  };
}

/** Liveness stays "ok" unless the DATA is gone; HTTP stays 200 either way. */
export function healthStatusFor(data: DataHealth): "ok" | "degraded" {
  return data.status === "empty" ? "degraded" : "ok";
}
