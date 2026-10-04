/**
 * Two read-only answers about the pod's DATA, kept out of the liveness path:
 *
 *  1. GET /status/backup — where the backups stand (public metadata, like
 *     /status/release). The rule is `readBackupStatus` (@synap/database), the
 *     one derivation pod-admin's system.getBackupStatus also uses.
 *  2. The `data` section of GET /health — "this pod had users and now has
 *     none" (the 2026-10-02 empty-but-healthy window).
 *
 * WHY /health stays 200 on a data alarm. Every orchestrator reading /health
 * looks only at the HTTP status: the backend container healthcheck, the
 * update-pod.sh / `synap` canary swaps (which roll back on non-200), the CP
 * health-check job (→ pod "warning"), Uptime Kuma, warm-pool claims, the
 * browser's pod failover. A non-200 for EMPTY DATA would make updates roll
 * back, failover kick in and nothing get fixed — the process is fine; the data
 * is what is wrong. So the HTTP status keeps meaning "the process serves";
 * the alarm is in the body: top-level `status` becomes "degraded" (synap-cli
 * discovery already accepts it; no consumer gates on the body) and `data`
 * carries the reason. Mapped 2026-10-04 across synap-backend, CP, hestia-cli,
 * relay-app, browser, synap-cli, synap-app, IS.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { BackupStatus, BackupRunSummary } from "@synap/database";

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
  now: Date = new Date()
): Promise<PublicBackupStatus> {
  try {
    return toPublicBackupStatus(await read(), now);
  } catch (err) {
    return {
      status: "unknown",
      offsite: null,
      lastBackup: null,
      lastSuccessAt: null,
      lastDrill: null,
      staleAfterHours: null,
      checkedAt: now.toISOString(),
      note: `Could not read backup_runs: ${err instanceof Error ? err.message : String(err)}`,
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
  error?: string;
}

export interface DataHealthDeps {
  stateDir: string;
  hasUsers: () => Promise<boolean>;
  exists?: (path: string) => boolean;
  timeoutMs?: number;
  now?: () => Date;
}

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
        setTimeout(() => reject(new Error("users check timed out")), deps.timeoutMs ?? 2000).unref?.()
      ),
    ]);
  } catch (err) {
    return {
      status: "unknown",
      initialized,
      hasUsers: null,
      checkedAt,
      error: err instanceof Error ? err.message : String(err),
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
