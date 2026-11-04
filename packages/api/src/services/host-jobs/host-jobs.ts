/**
 * Host jobs — the queue, the lease and the evidence of the host runner's work
 * on a computer (0399, plan 64072312 U7). The ONE writer of `host_jobs`, and
 * of the installation status the runner's lease, reports and finishes move.
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
 * Installation status moves only from the state the job expects
 * (compare-and-set): an install lease turns `planned` into `installing`, its
 * finish turns `installing` into `healthy` or `failed`; an update goes
 * `updating` → `healthy` (a failed update keeps the previous version, so it is
 * `healthy` again with the reason); a remove goes `removing` → `removed`.
 * "Degraded because the computer stopped reporting" is a READ verdict
 * ({@link installationReadStatus}), never stored.
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
import type { HostLog, LeasedHostJob } from "@synap-core/types/host-jobs";
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
 * The heartbeat window: a healthy installation whose computer has not
 * reported for this long READS as degraded ("devbox not seen since 14:02").
 */
export const INSTALLATION_REPORT_WINDOW_SECONDS = 5 * 60;

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
    eq(hostJobs.machineUserId, runner.machineUserId)
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
      "statusDetail" | "installedAt" | "removedAt" | "health" | "lastReportAt"
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
    await moveInstallation(job.installationId, ["planned"], "installing");
  } else if (job.kind === "update") {
    await moveInstallation(
      job.installationId,
      ["healthy", "degraded"],
      "updating"
    );
  } else if (job.kind === "remove") {
    await moveInstallation(
      job.installationId,
      ["planned", "installing", "healthy", "degraded", "updating", "failed"],
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
      capabilityKey: inst?.capabilityKey ?? "",
      capabilityVersion: inst?.capabilityVersion ?? null,
      upstreamVersion: inst?.upstreamVersion ?? null,
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

/**
 * Health (versions, ports, disk) and, when asked for, the masked log. Health
 * moves a running installation between healthy and degraded; it never moves
 * one that is installing, updating or removing (their finish does).
 */
export async function reportHostJob(input: {
  jobId: string;
  leaseId: string;
  runner: HostRunner;
  health?: InstallationHealth;
  log?: HostLog;
}): Promise<
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
  let status: InstallationStatus | null;
  if (input.health) {
    const services = Object.values(input.health.services);
    const allHealthy = services.length > 0 && services.every((s) => s.healthy);
    const report = { health: input.health, lastReportAt: new Date() };
    status = await moveInstallation(
      job.installationId,
      ["healthy", "degraded"],
      allHealthy ? "healthy" : "degraded",
      {
        ...report,
        statusDetail: allHealthy
          ? null
          : `Not healthy: ${Object.entries(input.health.services)
              .filter(([, s]) => !s.healthy)
              .map(([id, s]) => (s.detail ? `${id} (${s.detail})` : id))
              .join(", ")}.`,
      }
    );
    if (status !== "healthy" && status !== "degraded") {
      // Installing, updating or removing: keep the report, not the verdict.
      await db
        .update(installations)
        .set({ ...report, updatedAt: new Date() })
        .where(eq(installations.id, job.installationId));
    }
  } else {
    const [row] = await db
      .select({ status: installations.status })
      .from(installations)
      .where(eq(installations.id, job.installationId))
      .limit(1);
    status = row?.status ?? null;
  }
  return { ok: true, installationId: job.installationId, status };
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

  const ok = status === "done";
  let installationStatus: InstallationStatus | null = null;
  switch (job.kind) {
    case "install":
      installationStatus = await moveInstallation(
        job.installationId,
        ["installing"],
        ok ? "healthy" : "failed",
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
        "healthy",
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

/**
 * An installation as read: a healthy one whose computer has not reported
 * within {@link INSTALLATION_REPORT_WINDOW_SECONDS} reads `degraded`, with the
 * last time it was seen. Never stored (design §4 "the computer goes offline").
 */
export function installationReadStatus(
  row: Pick<
    InstallationRow,
    "status" | "lastReportAt" | "installedAt" | "statusDetail"
  >,
  now: Date = new Date()
): {
  status: InstallationStatus;
  notSeenSince: Date | null;
  detail: string | null;
} {
  // The last sign of life: a report, else the install's own finish.
  const seen = row.lastReportAt ?? row.installedAt;
  const silent =
    row.status === "healthy" &&
    (seen === null ||
      now.getTime() - seen.getTime() >
        INSTALLATION_REPORT_WINDOW_SECONDS * 1000);
  if (!silent) {
    return { status: row.status, notSeenSince: null, detail: row.statusDetail };
  }
  return {
    status: "degraded",
    notSeenSince: seen,
    detail: seen
      ? `The computer has not reported since ${seen.toISOString()}.`
      : "The computer has never reported on this installation.",
  };
}
