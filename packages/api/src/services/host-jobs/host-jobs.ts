/**
 * Host jobs — the queue, the lease and the evidence of the host runner's work
 * on a computer (0409, plan 64072312 U7; one model with two kinds, installer
 * reconciliation f75fbb48 §3.2). The ONE writer of `host_jobs`, and of the
 * installation status and observed state the runner's lease, reports and
 * finishes move.
 *
 *   lease     ← the computer (Hub `POST /host-jobs/lease`, scope
 *               `host.runner`), FIFO by `queued_at`, one winner per row
 *               (`FOR UPDATE SKIP LOCKED`). A computer leases only the jobs of
 *               installations ON ITSELF (`installations.machine_user_id`) that
 *               belong to its own person.
 *   heartbeat / report / finish ← the same computer, presenting the lease id.
 *   logs      ← the owner reads the last log the runner sent; a person asks
 *               for one (`requestHostJobLogs`), the next heartbeat says so.
 *
 * The lease rules are the box runner's (services/box-runs), copied on purpose:
 * a `leased` job whose lease expired goes back to the queue (the runner never
 * started it), at most {@link HOST_MAX_LEASE_ATTEMPTS} times; a `running` job
 * whose lease expired is read as STALLED and never re-leased (it may have
 * started containers); past {@link HOST_STALL_GRACE_SECONDS} the next lease
 * call fails it with an INFRA verdict.
 *
 * Installation status is the LIFECYCLE only and moves only from the state
 * the job expects (compare-and-set): an install lease turns `planned`,
 * `installed` or `failed` into `installing` (from `installed`/`failed` it is a
 * repair at the approved version), its finish turns `installing` into
 * `installed` or `failed`; an update goes `installed` → `updating` →
 * `installed` (a failed update keeps the previous version, so it is
 * `installed` again with the reason); a remove goes `removing` → `removed`; a
 * verify moves nothing. Reports and finishes store what the runner OBSERVED
 * (health, verify, version, os, arch). Health (ok, degraded, drifted, stale,
 * unknown, failed) is a READ verdict ({@link installationHealth}), never
 * stored.
 */

import { randomUUID } from "node:crypto";
import {
  and,
  asc,
  eq,
  exists,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";
import { db } from "@synap/database";
import {
  hostJobs,
  installations,
  type HostJobEvidence,
  type HostJobRow,
  type InstallationHealth,
  type InstallationRow,
  type InstallationStatus,
} from "@synap/database/schema";
import type {
  HostLog,
  HostVerify,
  LeasedHostJob,
} from "@synap-core/types/host-jobs";
import { boxStatusForVerdict, capLog } from "../box-runs/box-runs.js";
import { redactSecrets } from "../../utils/redact-secrets.js";

/** A lease lives this long; each heartbeat extends it to now + TTL. */
export const HOST_LEASE_TTL_SECONDS = 120;
/** The cadence the lease response asks for. */
export const HOST_HEARTBEAT_INTERVAL_SECONDS = 30;
/** A running job silent this long past its lease is failed (INFRA). */
export const HOST_STALL_GRACE_SECONDS = 2 * HOST_LEASE_TTL_SECONDS;
/** A job whose runner never started it is leased at most this many times. */
export const HOST_MAX_LEASE_ATTEMPTS = 3;
/**
 * The heartbeat window: an installed SERVICE whose computer has not reported
 * for this long READS as unknown ("devbox not seen since 14:02").
 */
export const INSTALLATION_REPORT_WINDOW_SECONDS = 5 * 60;
/**
 * A TOOL's verify is due again after this long unless its manifest says
 * otherwise (`verify.reverifyEvery`); past it, the tool READS as stale.
 */
export const TOOL_REVERIFY_DEFAULT_SECONDS = 7 * 24 * 60 * 60;

const ttl = () =>
  sql.raw(`now() + interval '${HOST_LEASE_TTL_SECONDS} seconds'`);

export interface HostRunner {
  /** The computer (machine agent user id). */
  machineUserId: string;
  /** Its person: the only owner whose jobs it may lease. */
  ownerUserId: string;
}

export type HostLeaseRefusal = {
  ok: false;
  code: "NOT_FOUND" | "LEASE_LOST";
};

/** The job is this computer's: its own person's, for an installation on it. */
const onThisComputer = (runner: HostRunner) =>
  and(
    eq(hostJobs.userId, runner.ownerUserId),
    eq(hostJobs.machineUserId, runner.machineUserId),
    exists(
      db
        .select({ one: sql`1` })
        .from(installations)
        .where(
          and(
            eq(installations.id, hostJobs.installationId),
            eq(installations.machineUserId, runner.machineUserId),
            eq(installations.userId, runner.ownerUserId)
          )
        )
    )
  );

const infraEvidence = (infraReason: string): HostJobEvidence => ({
  verdict: "infra",
  durationMs: null,
  infraReason,
  steps: [],
  log: { head: "", tail: "", totalBytes: null, truncated: false },
});

/** Settle what the clock decided before picking the head (box-runs' rules). */
async function settleExpired(runner: HostRunner): Promise<void> {
  const mine = and(
    eq(hostJobs.userId, runner.ownerUserId),
    eq(hostJobs.machineUserId, runner.machineUserId)
  );
  await db
    .update(hostJobs)
    .set({
      status: "stopped",
      finishedAt: new Date(),
      updatedAt: new Date(),
      leaseId: null,
    })
    .where(
      and(
        mine,
        eq(hostJobs.status, "leased"),
        isNotNull(hostJobs.stopRequestedAt),
        lt(hostJobs.leaseExpiresAt, sql`now()`)
      )
    );
  const neverStarted = `the runner never started it (${HOST_MAX_LEASE_ATTEMPTS} attempts)`;
  await db
    .update(hostJobs)
    .set({
      status: "failed",
      error: `The job did not complete on the computer: ${neverStarted}.`,
      evidence: infraEvidence(neverStarted),
      finishedAt: new Date(),
      updatedAt: new Date(),
      leaseId: null,
    })
    .where(
      and(
        mine,
        eq(hostJobs.status, "leased"),
        isNull(hostJobs.stopRequestedAt),
        lt(hostJobs.leaseExpiresAt, sql`now()`),
        gte(hostJobs.attempt, HOST_MAX_LEASE_ATTEMPTS)
      )
    );
  await db
    .update(hostJobs)
    .set({
      status: "failed",
      error: "The computer stopped answering while the job ran.",
      evidence: infraEvidence("heartbeat lost"),
      finishedAt: new Date(),
      updatedAt: new Date(),
      leaseId: null,
    })
    .where(
      and(
        mine,
        eq(hostJobs.status, "running"),
        lt(
          hostJobs.leaseExpiresAt,
          sql.raw(`now() - interval '${HOST_STALL_GRACE_SECONDS} seconds'`)
        )
      )
    );
}

const leasable = () =>
  or(
    eq(hostJobs.status, "queued"),
    and(
      eq(hostJobs.status, "leased"),
      lt(hostJobs.leaseExpiresAt, sql`now()`),
      isNull(hostJobs.stopRequestedAt)
    )
  );

/**
 * Move an installation from `from` to `to`, only when it is still in one of
 * `from` (compare-and-set). Returns the stored status after the move.
 */
async function moveInstallation(
  installationId: string,
  from: readonly InstallationStatus[],
  to: InstallationStatus,
  extra: Partial<
    Pick<
      InstallationRow,
      | "statusDetail"
      | "installedAt"
      | "removedAt"
      | "health"
      | "lastReportAt"
      | "observedVersion"
      | "observedOs"
      | "observedArch"
      | "verifiedAt"
    >
  > = {}
): Promise<InstallationStatus | null> {
  const [moved] = await db
    .update(installations)
    .set({ status: to, updatedAt: new Date(), ...extra })
    .where(
      and(
        eq(installations.id, installationId),
        inArray(installations.status, [...from])
      )
    )
    .returning({ status: installations.status });
  if (moved) return moved.status;
  const [row] = await db
    .select({ status: installations.status })
    .from(installations)
    .where(eq(installations.id, installationId))
    .limit(1);
  return row?.status ?? null;
}

// ── Lease ───────────────────────────────────────────────────────────────────

export async function leaseHostJob(
  runner: HostRunner
): Promise<LeasedHostJob | null> {
  await settleExpired(runner);
  const head = db
    .select({ id: hostJobs.id })
    .from(hostJobs)
    .where(and(onThisComputer(runner), leasable()))
    .orderBy(asc(hostJobs.queuedAt), asc(hostJobs.id))
    .limit(1)
    .for("update", { skipLocked: true });
  const leaseId = randomUUID();
  const [job] = await db
    .update(hostJobs)
    .set({
      status: "leased",
      leaseId,
      leasedBy: runner.machineUserId,
      leaseExpiresAt: ttl(),
      lastHeartbeatAt: sql`now()`,
      leasedAt: sql`now()`,
      attempt: sql`${hostJobs.attempt} + 1`,
      updatedAt: sql`now()`,
    })
    // ONE row by a scalar subquery, never `IN (…)` (see box-runs: with SKIP
    // LOCKED an IN subquery re-run per row took the whole queue).
    .where(and(sql`${hostJobs.id} = (${head})`, leasable()))
    .returning();
  if (!job) return null;

  if (job.kind === "install") {
    // From installed or failed it is a repair at the approved version.
    await moveInstallation(
      job.installationId,
      ["planned"],
      "installing"
    );
  } else if (job.kind === "update") {
    await moveInstallation(job.installationId, ["installed"], "updating");
  } else if (job.kind === "remove") {
    await moveInstallation(
      job.installationId,
      ["planned", "installing", "installed", "updating", "failed"],
      "removing"
    );
  }

  const [inst] = await db
    .select()
    .from(installations)
    .where(eq(installations.id, job.installationId))
    .limit(1);
  return {
    id: job.id,
    kind: job.kind,
    leaseId,
    leaseExpiresAt: job.leaseExpiresAt!.toISOString(),
    heartbeatIntervalSeconds: HOST_HEARTBEAT_INTERVAL_SECONDS,
    attempt: job.attempt,
    queuedAt: job.queuedAt.toISOString(),
    installation: {
      id: job.installationId,
      kind: inst?.kind ?? "service",
      capabilityKey: inst?.capabilityKey ?? "",
      capabilityVersion: inst?.capabilityVersion ?? null,
      upstreamVersion: inst?.upstreamVersion ?? null,
      desiredVersion: inst?.desiredVersion ?? null,
      manifest: inst?.manifest ?? {},
      digests: inst?.digests ?? {},
    },
    bindingId: job.bindingId,
    skillId: job.skillId,
    spec: job.spec,
    parameters: job.parameters,
  };
}

// ── Leaser acts ─────────────────────────────────────────────────────────────

async function refusalFor(
  jobId: string,
  runner: HostRunner
): Promise<HostLeaseRefusal> {
  const [row] = await db
    .select({ id: hostJobs.id })
    .from(hostJobs)
    .where(and(eq(hostJobs.id, jobId), onThisComputer(runner)))
    .limit(1);
  return { ok: false, code: row ? "LEASE_LOST" : "NOT_FOUND" };
}

/** Every leaser act: this job, this computer, this lease, still live. */
const holdsLease = (jobId: string, leaseId: string, runner: HostRunner) =>
  and(
    eq(hostJobs.id, jobId),
    onThisComputer(runner),
    eq(hostJobs.leasedBy, runner.machineUserId),
    eq(hostJobs.leaseId, leaseId),
    inArray(hostJobs.status, ["leased", "running"])
  );

/** A log as stored: capped like a box run's, and scrubbed of secrets. */
function storedLog(log: HostLog | undefined): HostJobEvidence["log"] {
  const capped = capLog(log);
  return {
    ...capped,
    head: redactSecrets(capped.head),
    tail: redactSecrets(capped.tail),
  };
}

export async function heartbeatHostJob(input: {
  jobId: string;
  leaseId: string;
  phase: "setup" | "running";
  runner: HostRunner;
}): Promise<
  | {
      ok: true;
      leaseExpiresAt: string;
      stopRequested: boolean;
      logsRequested: boolean;
    }
  | HostLeaseRefusal
> {
  const starting = input.phase === "running";
  const [row] = await db
    .update(hostJobs)
    .set({
      leaseExpiresAt: ttl(),
      lastHeartbeatAt: sql`now()`,
      updatedAt: sql`now()`,
      ...(starting
        ? {
            status: "running" as const,
            startedAt: sql`coalesce(${hostJobs.startedAt}, now())`,
          }
        : {}),
    })
    .where(holdsLease(input.jobId, input.leaseId, input.runner))
    .returning({
      leaseExpiresAt: hostJobs.leaseExpiresAt,
      stopRequestedAt: hostJobs.stopRequestedAt,
      logsRequestedAt: hostJobs.logsRequestedAt,
      logReceivedAt: hostJobs.logReceivedAt,
    });
  if (!row) return refusalFor(input.jobId, input.runner);
  return {
    ok: true,
    leaseExpiresAt: row.leaseExpiresAt!.toISOString(),
    stopRequested: row.stopRequestedAt !== null,
    logsRequested: logsOwed(row),
  };
}

/** A request newer than the last log received is still owed. */
function logsOwed(row: {
  logsRequestedAt: Date | null;
  logReceivedAt: Date | null;
}): boolean {
  return (
    row.logsRequestedAt !== null &&
    (row.logReceivedAt === null || row.logReceivedAt < row.logsRequestedAt)
  );
}

/** What the runner observed, as the wire sends it (a tool's verify, …). */
export interface HostObserved {
  observedVersion?: string | null;
  os?: string;
  arch?: string;
  verify?: HostVerify;
}

/** The verify excerpt as stored: masked again, whatever the runner did. */
function storedVerify(
  verify: HostVerify
): NonNullable<InstallationHealth["verify"]> {
  return {
    ok: verify.ok,
    exitCode: verify.exitCode,
    ...(verify.excerpt !== undefined
      ? { excerpt: verify.excerpt }
      : {}),
    ...(verify.outputSha256 ? { outputSha256: verify.outputSha256 } : {}),
    ...(verify.smoke
      ? {
          smoke: {
            ok: verify.smoke.ok,
            ...(verify.smoke.exitCode !== undefined
              ? { exitCode: verify.smoke.exitCode }
              : {}),
            ...(verify.smoke.excerpt !== undefined
              ? { excerpt: redactSecrets(verify.smoke.excerpt) }
              : {}),
          },
        }
      : {}),
  };
}

/**
 * The installation columns a report or finish writes from what the runner
 * observed. Only the fields it sent: a report with no verify keeps the last.
 */
function observedColumns(
  previous: InstallationHealth | null,
  input: HostObserved & { health?: InstallationHealth }
): Partial<InstallationRow> {
  const out: Partial<InstallationRow> = {};
  if (input.observedVersion !== undefined)
    out.observedVersion = input.observedVersion;
  if (input.os !== undefined) out.observedOs = input.os;
  if (input.arch !== undefined) out.observedArch = input.arch;
  if (input.health || input.verify) {
    out.health = {
      ...(previous ?? {}),
      ...(input.health ?? {}),
      ...(input.verify ? { verify: storedVerify(input.verify) } : {}),
    };
    out.lastReportAt = new Date();
  }
  if (input.verify || input.health?.services) out.verifiedAt = new Date();
  return out;
}

async function writeObserved(
  installationId: string,
  input: HostObserved & { health?: InstallationHealth }
): Promise<void> {
  const [row] = await db
    .select({ health: installations.health })
    .from(installations)
    .where(eq(installations.id, installationId))
    .limit(1);
  const columns = observedColumns(row?.health ?? null, input);
  if (Object.keys(columns).length === 0) return;
  await db
    .update(installations)
    .set({ ...columns, updatedAt: new Date() })
    .where(eq(installations.id, installationId));
}

/**
 * Health (services, versions, ports, disk), a tool's verify and what it
 * observed, and, when asked for, the masked log. A report never moves the
 * installation's lifecycle (finishes do); health is derived at read time.
 */
export async function reportHostJob(
  input: {
    jobId: string;
    leaseId: string;
    runner: HostRunner;
    health?: InstallationHealth;
    log?: HostLog;
  } & HostObserved
): Promise<
  | { ok: true; installationId: string; status: InstallationStatus | null }
  | HostLeaseRefusal
> {
  const [job] = await db
    .update(hostJobs)
    .set({
      updatedAt: sql`now()`,
      ...(input.log
        ? { log: storedLog(input.log), logReceivedAt: sql`now()` }
        : {}),
    })
    .where(holdsLease(input.jobId, input.leaseId, input.runner))
    .returning({ installationId: hostJobs.installationId });
  if (!job) return refusalFor(input.jobId, input.runner);
  await writeObserved(job.installationId, input);
  const [row] = await db
    .select({ status: installations.status })
    .from(installations)
    .where(eq(installations.id, job.installationId))
    .limit(1);
  return {
    ok: true,
    installationId: job.installationId,
    status: row?.status ?? null,
  };
}

export interface FinishHostJobInput {
  jobId: string;
  leaseId: string;
  runner: HostRunner;
  verdict: HostJobEvidence["verdict"];
  durationMs: number | null;
  infraReason?: string;
  steps?: HostJobEvidence["steps"];
  log?: HostLog;
  output?: Record<string, unknown>;
  cleanedUp?: string[];
  observed?: HostObserved;
}

function failureSentence(input: FinishHostJobInput): string | null {
  switch (input.verdict) {
    case "done":
    case "stopped":
      return null;
    case "timeout":
      return "The job ran past its time limit and was stopped.";
    case "infra":
      return `The job did not complete on the computer: ${input.infraReason ?? "unknown reason"}.`;
    default: {
      const step = input.steps?.find((s) => !s.ok);
      return step
        ? `The step “${step.name}” failed${step.detail ? `: ${step.detail}` : "."}`
        : "The job failed.";
    }
  }
}

/**
 * Close the job (single-shot: a second finish finds no live lease, 409), then
 * move its installation by the job's kind.
 */
export async function finishHostJob(input: FinishHostJobInput): Promise<
  | {
      ok: true;
      job: HostJobRow;
      installationStatus: InstallationStatus | null;
    }
  | HostLeaseRefusal
> {
  const status = boxStatusForVerdict(input.verdict);
  const log = storedLog(input.log);
  const evidence: HostJobEvidence = {
    verdict: input.verdict,
    durationMs: input.durationMs,
    ...(input.infraReason ? { infraReason: input.infraReason } : {}),
    steps: input.steps ?? [],
    log,
    ...(input.output ? { output: input.output } : {}),
    ...(input.cleanedUp ? { cleanedUp: input.cleanedUp } : {}),
  };
  const error = failureSentence(input);
  const [job] = await db
    .update(hostJobs)
    .set({
      status,
      evidence,
      error,
      log,
      logReceivedAt: sql`now()`,
      finishedAt: sql`now()`,
      updatedAt: sql`now()`,
      leaseId: null,
    })
    .where(holdsLease(input.jobId, input.leaseId, input.runner))
    .returning();
  if (!job) return refusalFor(input.jobId, input.runner);

  // What the runner observed lands whatever the verdict: a failed verify is
  // what the reconciler repairs from.
  if (input.observed) await writeObserved(job.installationId, input.observed);

  const ok = status === "done";
  let installationStatus: InstallationStatus | null = null;
  switch (job.kind) {
    case "install":
      installationStatus = await moveInstallation(
        job.installationId,
        ["installing"],
        ok ? "installed" : "failed",
        ok
          ? { installedAt: new Date(), statusDetail: null }
          : { statusDetail: error ?? "The install was stopped." }
      );
      break;
    case "update":
      // A failed update keeps the previous version running (design §4).
      installationStatus = await moveInstallation(
        job.installationId,
        ["updating"],
        "installed",
        {
          statusDetail: ok
            ? null
            : `The update did not complete; the previous version kept running. ${error ?? ""}`.trim(),
        }
      );
      break;
    case "remove":
      installationStatus = await moveInstallation(
        job.installationId,
        ["removing"],
        ok ? "removed" : "failed",
        ok
          ? { removedAt: new Date(), statusDetail: null }
          : { statusDetail: error ?? "The removal was stopped." }
      );
      break;
    default: {
      const [row] = await db
        .select({ status: installations.status })
        .from(installations)
        .where(eq(installations.id, job.installationId))
        .limit(1);
      installationStatus = row?.status ?? null;
    }
  }
  return { ok: true, job, installationStatus };
}

// ── Logs (the owner) ────────────────────────────────────────────────────────

/**
 * A person asks for a live job's logs: the next heartbeat answers
 * `logsRequested`, and the runner sends them in its next report. Owner floor;
 * a finished job already holds its last log.
 */
export async function requestHostJobLogs(input: {
  jobId: string;
  ownerUserId: string;
}): Promise<
  { ok: true; requested: boolean } | { ok: false; code: "NOT_FOUND" }
> {
  const [row] = await db
    .update(hostJobs)
    .set({ logsRequestedAt: sql`now()`, updatedAt: sql`now()` })
    .where(
      and(
        eq(hostJobs.id, input.jobId),
        eq(hostJobs.userId, input.ownerUserId),
        inArray(hostJobs.status, ["leased", "running"])
      )
    )
    .returning({ id: hostJobs.id });
  if (row) return { ok: true, requested: true };
  const [exists_] = await db
    .select({ id: hostJobs.id })
    .from(hostJobs)
    .where(
      and(eq(hostJobs.id, input.jobId), eq(hostJobs.userId, input.ownerUserId))
    )
    .limit(1);
  return exists_
    ? { ok: true, requested: false }
    : { ok: false, code: "NOT_FOUND" };
}

// ── Read verdicts ───────────────────────────────────────────────────────────

/** An installation's health, as read. Never stored. */
export const INSTALLATION_HEALTH_VERDICTS = [
  "ok",
  "degraded",
  "drifted",
  "stale",
  "unknown",
  "failed",
] as const;
export type InstallationHealthVerdict =
  (typeof INSTALLATION_HEALTH_VERDICTS)[number];

/** A host job as read: `stalled` when a running job's lease ran out. */
export function hostJobReadStatus(
  row: Pick<HostJobRow, "status" | "leaseExpiresAt">,
  now: Date = new Date()
): HostJobRow["status"] | "stalled" {
  return row.status === "running" &&
    row.leaseExpiresAt !== null &&
    row.leaseExpiresAt < now
    ? "stalled"
    : row.status;
}

/** An ISO 8601 duration (`P7D`, `PT12H`) in seconds; null when unreadable. */
export function isoDurationSeconds(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const m =
    /^P(?!$)(?:(\d+)D)?(?:T(?=\d)(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(
      value
    );
  if (!m) return null;
  const [d, h, min, sec] = m.slice(1).map((n) => Number(n ?? 0));
  return d! * 86_400 + h! * 3_600 + min! * 60 + sec!;
}

/** How often a tool is verified again: its manifest's, else the default. */
function reverifySeconds(manifest: Record<string, unknown>): number {
  const verify = manifest.verify as Record<string, unknown> | undefined;
  return (
    isoDurationSeconds(verify?.reverifyEvery) ?? TOOL_REVERIFY_DEFAULT_SECONDS
  );
}

/**
 * An installation's health, derived at read time and never stored
 * (reconciliation f75fbb48 §3.1). Only a lifecycle that ran has a health:
 * `failed` reads failed; `installed` reads, first match wins:
 *   - unknown   a service's computer has not reported within
 *               {@link INSTALLATION_REPORT_WINDOW_SECONDS}, or a tool was
 *               never verified;
 *   - failed    a tool's last verify did not pass;
 *   - degraded  a service reported a service not healthy;
 *   - drifted   the observed version is not the approved one;
 *   - stale     a tool's last verify is older than its `reverifyEvery`;
 *   - ok        otherwise.
 * Any other lifecycle (planned, installing, updating, removing, removed) has
 * no health yet: `null`.
 */
export function installationHealth(
  row: Pick<
    InstallationRow,
    | "kind"
    | "status"
    | "statusDetail"
    | "health"
    | "lastReportAt"
    | "installedAt"
    | "verifiedAt"
    | "observedVersion"
    | "desiredVersion"
    | "manifest"
  >,
  now: Date = new Date()
): {
  health: InstallationHealthVerdict | null;
  detail: string | null;
  notSeenSince: Date | null;
} {
  const verdict = (
    health: InstallationHealthVerdict,
    detail: string | null = null,
    notSeenSince: Date | null = null
  ) => ({ health, detail, notSeenSince });
  if (row.status === "failed") return verdict("failed", row.statusDetail);
  if (row.status !== "installed") {
    return { health: null, detail: null, notSeenSince: null };
  }
  const ageSeconds = (at: Date) => (now.getTime() - at.getTime()) / 1000;

  if (row.kind === "service") {
    const seen = row.lastReportAt ?? row.installedAt;
    if (
      seen === null ||
      ageSeconds(seen) > INSTALLATION_REPORT_WINDOW_SECONDS
    ) {
      return verdict(
        "unknown",
        seen
          ? `The computer has not reported since ${seen.toISOString()}.`
          : "The computer has never reported on this installation.",
        seen
      );
    }
    const sick = Object.entries(row.health?.services ?? {}).filter(
      ([, s]) => !s.healthy
    );
    if (sick.length > 0) {
      return verdict(
        "degraded",
        `Not healthy: ${sick
          .map(([id, s]) => (s.detail ? `${id} (${s.detail})` : id))
          .join(", ")}.`
      );
    }
  } else {
    if (row.verifiedAt === null) {
      return verdict("unknown", "This tool has not been checked yet.");
    }
    if (row.health?.verify && !row.health.verify.ok) {
      return verdict(
        "failed",
        `The last check failed (exit code ${row.health.verify.exitCode}).`
      );
    }
  }
  if (
    row.desiredVersion &&
    row.observedVersion &&
    row.observedVersion !== row.desiredVersion
  ) {
    return verdict(
      "drifted",
      `Version ${row.observedVersion} is on the computer; ${row.desiredVersion} was approved.`
    );
  }
  if (
    row.kind === "tool" &&
    row.verifiedAt !== null &&
    ageSeconds(row.verifiedAt) > reverifySeconds(row.manifest)
  ) {
    return verdict(
      "stale",
      `Last checked ${row.verifiedAt.toISOString()}; a check is due.`
    );
  }
  return verdict("ok");
}
