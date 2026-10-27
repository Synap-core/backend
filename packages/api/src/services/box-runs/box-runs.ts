/**
 * Box runs — the queue, the lease and the evidence of a box skill's runs
 * (0356, run box design C4 phase 0). The ONE writer of `box_runs`.
 *
 *   enqueue   ← `runSkill`, the one skill door (the person's own Run, an
 *               agent's run once its gate or proposal says run). Never refused
 *               for "queue full": a run waits with its turn kept. Refused when
 *               the skill is off, or when no computer of the person runs
 *               scripts (a queue nobody can take is not "running").
 *   lease     ← the person's computer (Hub `POST /box-runs/lease`), FIFO by
 *               `queued_at`, one winner per row (`FOR UPDATE SKIP LOCKED`).
 *   heartbeat / uploads / finish ← the same computer, presenting the lease id.
 *   stop      ← the person (a queued run stops at once; a leased or running
 *               one is told through its next heartbeat).
 *
 * A computer only ever leases runs of ITS OWN person (the approver who
 * connected it): it sees the script and its parameters, and a shared pod
 * runner is a later decision, not a default.
 *
 * Lease rules (the box contract, code-runtime plan v2):
 *   - a `leased` run whose lease expired goes back to the queue (the box never
 *     started the script, so a retry has no side effects), at most
 *     {@link BOX_MAX_LEASE_ATTEMPTS} times: past that the next lease call
 *     fails it with an INFRA verdict, so one poison run cannot hold the head
 *     of the person's queue forever;
 *   - a `running` run whose lease expired is read as STALLED and is never
 *     re-leased (the script may have had side effects); once it is past
 *     {@link BOX_STALL_GRACE_SECONDS} the next lease call fails it with an
 *     INFRA verdict ("heartbeat lost").
 */

import { randomUUID } from "node:crypto";
import {
  and,
  asc,
  eq,
  gt,
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
  BOX_RUNNER_SCOPE,
  apiKeys,
  boxRuns,
  skills,
  users,
  type BoxRunEvidence,
  type BoxRunRow,
  type BoxRunSpec,
} from "@synap/database/schema";
import { createLogger } from "@synap-core/core";
import { MACHINE_AGENT_TYPE } from "@synap-core/types/agents";
import { boxRunSpecFor } from "./box-spec.js";

const logger = createLogger({ module: "box-runs" });

/** A lease lives this long; each heartbeat extends it to now + TTL. */
export const BOX_LEASE_TTL_SECONDS = 120;
/** The cadence the lease response asks for. */
export const BOX_HEARTBEAT_INTERVAL_SECONDS = 30;
/** A running run silent this long past its lease is failed (INFRA). */
export const BOX_STALL_GRACE_SECONDS = 2 * BOX_LEASE_TTL_SECONDS;
/** Log head and tail are each kept up to this many UTF-8 bytes. */
export const BOX_LOG_CAP = 64 * 1024;
/** A run whose box never started is leased at most this many times. */
export const BOX_MAX_LEASE_ATTEMPTS = 3;
/** Files one run may return. */
export const BOX_MAX_FILES = 20;

// Constants, never input: inlined so Postgres types the interval itself.
const ttl = () =>
  sql.raw(`now() + interval '${BOX_LEASE_TTL_SECONDS} seconds'`);

/**
 * One line in the run's session room (started, finished) — never per-line
 * chatter. Best-effort through the pod's one room-notice door: a notice that
 * cannot post never fails the run.
 */
async function roomNotice(
  sessionId: string | null,
  content: string,
  key: string
): Promise<void> {
  if (!sessionId) return;
  try {
    const { postSessionNotice } =
      await import("../agent-dispatch/binding-call.js");
    await postSessionNotice(sessionId, content, key);
  } catch (err) {
    logger.warn({ err, sessionId }, "box run: room notice not posted");
  }
}

// ── Enqueue ─────────────────────────────────────────────────────────────────

export interface EnqueueBoxRunInput {
  skillId: string;
  parameters: Record<string, unknown> | undefined;
  userId: string;
  agentUserId?: string | null;
  sessionId?: string | null;
  workspaceId?: string | null;
  proposalId?: string | null;
}

/** What a queued box run hands back as the capability run's result. */
export interface BoxRunQueuedResult {
  status: "queued";
  boxRunId: string;
  message: string;
}

/** True for the result a queued box run hands back (not yet performed). */
export function isQueuedBoxRunResult(
  result: unknown
): result is BoxRunQueuedResult {
  return (
    !!result &&
    typeof result === "object" &&
    (result as { status?: unknown }).status === "queued" &&
    typeof (result as { boxRunId?: unknown }).boxRunId === "string"
  );
}

/**
 * Said when no computer can take the run: the setting that fixes it, by name.
 */
export const NO_BOX_RUNNER_ERROR =
  'No computer of yours runs scripts. Turn on "Runs scripts" for one in pod-admin › Computers, then run it again.';

/**
 * Does this person have a computer that can lease a box run now: a computer
 * of theirs with a live key holding `box.runner` (what the Hub routes check).
 */
async function hasBoxRunner(personId: string): Promise<boolean> {
  const [key] = await db
    .select({ id: apiKeys.id })
    .from(apiKeys)
    .innerJoin(users, eq(users.id, apiKeys.userId))
    .where(
      and(
        eq(users.agentType, MACHINE_AGENT_TYPE),
        eq(users.createdByUserId, personId),
        eq(apiKeys.isActive, true),
        isNull(apiKeys.revokedAt),
        or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, sql`now()`)),
        sql`${BOX_RUNNER_SCOPE} = ANY(${apiKeys.scope})`
      )
    )
    .limit(1);
  return !!key;
}

export async function enqueueBoxRun(
  input: EnqueueBoxRunInput
): Promise<
  | { ok: true; run: BoxRunRow; result: BoxRunQueuedResult }
  | { ok: false; error: string }
> {
  const [skill] = await db
    .select({
      name: skills.name,
      code: skills.code,
      metadata: skills.metadata,
      status: skills.status,
      approved: skills.approved,
    })
    .from(skills)
    .where(eq(skills.id, input.skillId))
    .limit(1);
  if (!skill)
    return { ok: false, error: `Box skill ${input.skillId} not found.` };
  // The sandbox's own gate, in its words: a run approved while the skill was
  // on still finds it off (or its code edited, which turns it off) here.
  if (skill.status !== "active" || skill.approved !== true) {
    return {
      ok: false,
      error:
        skill.approved === false
          ? "Skill is not approved for execution."
          : `Skill is ${skill.status}`,
    };
  }
  const spec = boxRunSpecFor(skill);
  if (!spec.ok) return spec;
  if (!(await hasBoxRunner(input.userId))) {
    return { ok: false, error: NO_BOX_RUNNER_ERROR };
  }

  const [run] = await db
    .insert(boxRuns)
    .values({
      skillId: input.skillId,
      userId: input.userId,
      agentUserId: input.agentUserId ?? null,
      sessionId: input.sessionId ?? null,
      workspaceId: input.workspaceId ?? null,
      proposalId: input.proposalId ?? null,
      spec: spec.spec,
      parameters: input.parameters ?? {},
    })
    .returning();
  await roomNotice(
    run.sessionId,
    `Queued “${skill.name}” to run in a box on your computer.`,
    `box-run:${run.id}:queued`
  );
  return {
    ok: true,
    run,
    result: {
      status: "queued",
      boxRunId: run.id,
      message: `Queued "${skill.name}" to run in a box on your computer. It starts when your computer picks it up; its log and files come back on the run.`,
    },
  };
}

// ── Lease ───────────────────────────────────────────────────────────────────

export interface BoxRunner {
  /** The computer (machine agent user id). */
  machineUserId: string;
  /** Its person — the only requester whose runs it may lease. */
  ownerUserId: string;
}

export interface LeasedBoxRun {
  id: string;
  leaseId: string;
  leaseExpiresAt: string;
  heartbeatIntervalSeconds: number;
  attempt: number;
  queuedAt: string;
  script: BoxRunSpec & { skillId: string | null };
  parameters: Record<string, unknown>;
}

/**
 * Settle what the clock decided before picking the head: a stop requested on
 * a leased run whose box never answered, a leased run whose box never started
 * after {@link BOX_MAX_LEASE_ATTEMPTS} leases, and a running run silent past
 * grace.
 */
async function settleExpired(ownerUserId: string): Promise<void> {
  await db
    .update(boxRuns)
    .set({
      status: "stopped",
      finishedAt: new Date(),
      updatedAt: new Date(),
      leaseId: null,
    })
    .where(
      and(
        eq(boxRuns.userId, ownerUserId),
        eq(boxRuns.status, "leased"),
        isNotNull(boxRuns.stopRequestedAt),
        lt(boxRuns.leaseExpiresAt, sql`now()`)
      )
    );
  const infra = (infraReason: string): BoxRunEvidence => ({
    verdict: "infra",
    exitCode: null,
    durationMs: null,
    infraReason,
    log: { head: "", tail: "", totalBytes: null, truncated: false },
    blockedEgress: [],
    installedPackages: [],
    files: [],
  });
  const neverStarted = `the box never started (${BOX_MAX_LEASE_ATTEMPTS} attempts)`;
  await db
    .update(boxRuns)
    .set({
      status: "failed",
      error: `The run did not complete on the computer: ${neverStarted}.`,
      evidence: infra(neverStarted),
      finishedAt: new Date(),
      updatedAt: new Date(),
      leaseId: null,
    })
    .where(
      and(
        eq(boxRuns.userId, ownerUserId),
        eq(boxRuns.status, "leased"),
        isNull(boxRuns.stopRequestedAt),
        lt(boxRuns.leaseExpiresAt, sql`now()`),
        gte(boxRuns.attempt, BOX_MAX_LEASE_ATTEMPTS)
      )
    );
  await db
    .update(boxRuns)
    .set({
      status: "failed",
      error: "The computer stopped answering while the script ran.",
      evidence: infra("heartbeat lost"),
      finishedAt: new Date(),
      updatedAt: new Date(),
      leaseId: null,
    })
    .where(
      and(
        eq(boxRuns.userId, ownerUserId),
        eq(boxRuns.status, "running"),
        lt(
          boxRuns.leaseExpiresAt,
          sql.raw(`now() - interval '${BOX_STALL_GRACE_SECONDS} seconds'`)
        )
      )
    );
}

/** The rows a lease may take: queued, or leased-but-expired without a stop. */
const leasable = () =>
  or(
    eq(boxRuns.status, "queued"),
    and(
      eq(boxRuns.status, "leased"),
      lt(boxRuns.leaseExpiresAt, sql`now()`),
      isNull(boxRuns.stopRequestedAt)
    )
  );

export async function leaseBoxRun(
  runner: BoxRunner
): Promise<LeasedBoxRun | null> {
  await settleExpired(runner.ownerUserId);
  const head = db
    .select({ id: boxRuns.id })
    .from(boxRuns)
    .where(and(eq(boxRuns.userId, runner.ownerUserId), leasable()))
    .orderBy(asc(boxRuns.queuedAt), asc(boxRuns.id))
    .limit(1)
    .for("update", { skipLocked: true });
  const leaseId = randomUUID();
  const [run] = await db
    .update(boxRuns)
    .set({
      status: "leased",
      leaseId,
      leasedBy: runner.machineUserId,
      leaseExpiresAt: ttl(),
      lastHeartbeatAt: sql`now()`,
      leasedAt: sql`now()`,
      attempt: sql`${boxRuns.attempt} + 1`,
      updatedAt: sql`now()`,
    })
    // ONE row, by a SCALAR subquery (`id = (…)`), never `id IN (…)`: the
    // planner may re-run an IN subquery per outer row, and with SKIP LOCKED
    // each re-run skips the row just claimed — one lease took the whole queue
    // (caught by the FIFO test). `leasable()` again on the outer row: the
    // inner pick is a snapshot.
    .where(and(sql`${boxRuns.id} = (${head})`, leasable()))
    .returning();
  if (!run) return null;
  return {
    id: run.id,
    leaseId,
    leaseExpiresAt: run.leaseExpiresAt!.toISOString(),
    heartbeatIntervalSeconds: BOX_HEARTBEAT_INTERVAL_SECONDS,
    attempt: run.attempt,
    queuedAt: run.queuedAt.toISOString(),
    script: { skillId: run.skillId, ...run.spec },
    parameters: run.parameters,
  };
}

// ── Heartbeat ───────────────────────────────────────────────────────────────

export type LeaseRefusal = { ok: false; code: "NOT_FOUND" | "LEASE_LOST" };

/** The run this computer's person owns, for the 404-vs-409 answer. */
async function refusalFor(
  runId: string,
  runner: BoxRunner
): Promise<LeaseRefusal> {
  const [row] = await db
    .select({ id: boxRuns.id })
    .from(boxRuns)
    .where(and(eq(boxRuns.id, runId), eq(boxRuns.userId, runner.ownerUserId)))
    .limit(1);
  return { ok: false, code: row ? "LEASE_LOST" : "NOT_FOUND" };
}

/** The lease predicate every leaser act shares: this run, this lease, live. */
const holdsLease = (runId: string, leaseId: string, runner: BoxRunner) =>
  and(
    eq(boxRuns.id, runId),
    eq(boxRuns.userId, runner.ownerUserId),
    eq(boxRuns.leasedBy, runner.machineUserId),
    eq(boxRuns.leaseId, leaseId),
    inArray(boxRuns.status, ["leased", "running"])
  );

export async function heartbeatBoxRun(input: {
  runId: string;
  leaseId: string;
  phase: "setup" | "running";
  runner: BoxRunner;
}): Promise<
  { ok: true; leaseExpiresAt: string; stopRequested: boolean } | LeaseRefusal
> {
  const starting = input.phase === "running";
  const [row] = await db
    .update(boxRuns)
    .set({
      leaseExpiresAt: ttl(),
      lastHeartbeatAt: sql`now()`,
      updatedAt: sql`now()`,
      ...(starting
        ? {
            status: "running" as const,
            startedAt: sql`coalesce(${boxRuns.startedAt}, now())`,
          }
        : {}),
    })
    .where(holdsLease(input.runId, input.leaseId, input.runner))
    .returning({
      leaseExpiresAt: boxRuns.leaseExpiresAt,
      stopRequestedAt: boxRuns.stopRequestedAt,
    });
  if (!row) return refusalFor(input.runId, input.runner);
  return {
    ok: true,
    leaseExpiresAt: row.leaseExpiresAt!.toISOString(),
    stopRequested: row.stopRequestedAt !== null,
  };
}

// ── Uploads ─────────────────────────────────────────────────────────────────

/**
 * The run row a leaser act may use, or the refusal. Read-only: the uploads
 * door mints a ticket for the run's REQUESTER through the existing presigned
 * lane, never for the computer.
 */
export async function loadLeasedBoxRun(input: {
  runId: string;
  leaseId: string;
  runner: BoxRunner;
}): Promise<{ ok: true; run: BoxRunRow } | LeaseRefusal> {
  const [run] = await db
    .select()
    .from(boxRuns)
    .where(holdsLease(input.runId, input.leaseId, input.runner))
    .limit(1);
  if (!run) return refusalFor(input.runId, input.runner);
  return { ok: true, run };
}

// ── Finish ──────────────────────────────────────────────────────────────────

export interface FinishBoxRunInput {
  runId: string;
  leaseId: string;
  runner: BoxRunner;
  verdict: BoxRunEvidence["verdict"];
  exitCode: number | null;
  durationMs: number | null;
  infraReason?: string;
  log?: {
    head?: string;
    tail?: string;
    totalBytes?: number | null;
    truncated?: boolean;
  };
  blockedEgress?: BoxRunEvidence["blockedEgress"];
  installedPackages?: BoxRunEvidence["installedPackages"];
  files?: Array<{
    path: string;
    size?: number;
    sha256?: string;
    title?: string;
    uploadToken?: string;
  }>;
}

/** Stored status for a verdict: `timeout`/`infra` are failures of the run. */
export function boxStatusForVerdict(
  verdict: BoxRunEvidence["verdict"]
): "done" | "failed" | "stopped" {
  return verdict === "done"
    ? "done"
    : verdict === "stopped"
      ? "stopped"
      : "failed";
}

/** A UTF-8 continuation byte: cutting before one splits a character. */
const isContinuation = (b: number | undefined) =>
  b !== undefined && (b & 0xc0) === 0x80;

/** The first `cap` UTF-8 bytes of `text`, never half a character. */
function headBytes(text: string, cap: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= cap) return text;
  let end = cap;
  while (end > 0 && isContinuation(buf[end])) end--;
  return buf.subarray(0, end).toString("utf8");
}

/** The last `cap` UTF-8 bytes of `text`, never half a character. */
function tailBytes(text: string, cap: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= cap) return text;
  let start = buf.length - cap;
  while (start < buf.length && isContinuation(buf[start])) start++;
  return buf.subarray(start).toString("utf8");
}

/** Head and tail kept to {@link BOX_LOG_CAP} UTF-8 bytes each (the contract). */
export function capLog(log: FinishBoxRunInput["log"]): BoxRunEvidence["log"] {
  const head = headBytes(log?.head ?? "", BOX_LOG_CAP);
  const tail = tailBytes(log?.tail ?? "", BOX_LOG_CAP);
  const cut = head !== (log?.head ?? "") || tail !== (log?.tail ?? "");
  return {
    head,
    tail,
    totalBytes: log?.totalBytes ?? null,
    truncated: cut || log?.truncated === true,
  };
}

function failureSentence(input: FinishBoxRunInput): string | null {
  switch (input.verdict) {
    case "done":
    case "stopped":
      return null;
    case "timeout":
      return "The script ran past its time limit and was stopped.";
    case "infra":
      return `The run did not complete on the computer: ${input.infraReason ?? "unknown reason"}.`;
    default:
      return input.exitCode != null
        ? `The script exited with code ${input.exitCode}.`
        : "The script failed.";
  }
}

/**
 * Close the run, then store its files as the REQUESTER through the governed
 * file door (`finalizeAgentUpload`). Closing first makes finish single-shot:
 * a second finish on the same lease finds no live lease (409), and a file
 * door failure can never leave a run open.
 */
export async function finishBoxRun(
  input: FinishBoxRunInput
): Promise<{ ok: true; run: BoxRunRow } | LeaseRefusal> {
  const status = boxStatusForVerdict(input.verdict);
  const files = (input.files ?? []).slice(0, BOX_MAX_FILES);
  const evidence: BoxRunEvidence = {
    verdict: input.verdict,
    exitCode: input.exitCode,
    durationMs: input.durationMs,
    ...(input.infraReason ? { infraReason: input.infraReason } : {}),
    log: capLog(input.log),
    blockedEgress: input.blockedEgress ?? [],
    installedPackages: input.installedPackages ?? [],
    files: files.map((f) => ({
      path: f.path,
      ...(f.size !== undefined ? { size: f.size } : {}),
      ...(f.sha256 ? { sha256: f.sha256 } : {}),
      ...(f.title ? { title: f.title } : {}),
      status: "not_stored" as const,
    })),
  };
  const [closed] = await db
    .update(boxRuns)
    .set({
      status,
      evidence,
      error: failureSentence(input),
      finishedAt: sql`now()`,
      updatedAt: sql`now()`,
      leaseId: null,
      leaseExpiresAt: null,
    })
    .where(holdsLease(input.runId, input.leaseId, input.runner))
    .returning();
  if (!closed) return refusalFor(input.runId, input.runner);

  if (files.some((f) => f.uploadToken)) {
    const { finalizeAgentUpload } = await import("../files/agent-upload.js");
    for (const [i, f] of files.entries()) {
      if (!f.uploadToken) continue;
      try {
        const fin = await finalizeAgentUpload({
          userId: closed.userId,
          ...(closed.agentUserId ? { agentUserId: closed.agentUserId } : {}),
          scopes: ["hub-protocol.read", "hub-protocol.write"],
          uploadToken: f.uploadToken,
          ...(f.title ? { title: f.title } : {}),
          ...(closed.sessionId ? { sessionId: closed.sessionId } : {}),
        });
        evidence.files[i] = !fin.ok
          ? { ...evidence.files[i], status: "refused", error: fin.error }
          : fin.status === "created"
            ? {
                ...evidence.files[i],
                status: "created",
                fileEntityId: fin.fileEntityId,
                documentId: fin.documentId,
              }
            : {
                ...evidence.files[i],
                status: "proposed",
                documentId: fin.documentId,
                ...(fin.status === "proposed" && fin.proposalId
                  ? { proposalId: fin.proposalId }
                  : {}),
              };
      } catch (err) {
        logger.error(
          { err, runId: closed.id, path: f.path },
          "box run file not stored"
        );
        evidence.files[i] = {
          ...evidence.files[i],
          status: "refused",
          error: "The file door failed to store this file.",
        };
      }
    }
    await db
      .update(boxRuns)
      .set({ evidence, updatedAt: sql`now()` })
      .where(eq(boxRuns.id, closed.id));
    closed.evidence = evidence;
  }

  const stored = evidence.files.filter(
    (f) => f.status === "created" || f.status === "proposed"
  ).length;
  await roomNotice(
    closed.sessionId,
    status === "done"
      ? `“${closed.spec.name}” finished in its box${stored ? ` · ${stored} file${stored === 1 ? "" : "s"}` : ""}.`
      : status === "stopped"
        ? `“${closed.spec.name}” was stopped.`
        : `“${closed.spec.name}” did not finish: ${closed.error ?? "it failed"}`,
    `box-run:${closed.id}:finished`
  );

  if (status === "done" && closed.skillId) {
    const { markSkillProven } =
      await import("../capabilities/execute-capability.js");
    await markSkillProven(closed.skillId);
  }
  return { ok: true, run: closed };
}

// ── Stop ────────────────────────────────────────────────────────────────────

/**
 * The person's Stop. A queued run stops at once; a leased or running one is
 * marked and told through its next heartbeat (`stopRequested`), and the
 * computer finishes it as `stopped`. Owner-floored on the loaded row.
 */
export async function stopBoxRun(input: {
  runId: string;
  userId: string;
}): Promise<"stopped" | "stop_requested" | "already_finished" | "not_found"> {
  const [stopped] = await db
    .update(boxRuns)
    .set({
      status: "stopped",
      stopRequestedAt: sql`now()`,
      finishedAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(boxRuns.id, input.runId),
        eq(boxRuns.userId, input.userId),
        eq(boxRuns.status, "queued")
      )
    )
    .returning({ id: boxRuns.id });
  if (stopped) return "stopped";
  const [marked] = await db
    .update(boxRuns)
    .set({
      stopRequestedAt: sql`coalesce(${boxRuns.stopRequestedAt}, now())`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(boxRuns.id, input.runId),
        eq(boxRuns.userId, input.userId),
        inArray(boxRuns.status, ["leased", "running"])
      )
    )
    .returning({ id: boxRuns.id });
  if (marked) return "stop_requested";
  const [exists] = await db
    .select({ id: boxRuns.id })
    .from(boxRuns)
    .where(and(eq(boxRuns.id, input.runId), eq(boxRuns.userId, input.userId)))
    .limit(1);
  return exists ? "already_finished" : "not_found";
}

// ── Read verdict ────────────────────────────────────────────────────────────

/** The status a reader shows: the stored one, or `stalled` (never stored). */
export type BoxRunReadStatus = BoxRunRow["status"] | "stalled";

export function boxRunReadStatus(
  run: Pick<BoxRunRow, "status" | "leaseExpiresAt">,
  now: Date = new Date()
): BoxRunReadStatus {
  if (
    run.status === "running" &&
    run.leaseExpiresAt &&
    run.leaseExpiresAt.getTime() < now.getTime()
  ) {
    return "stalled";
  }
  return run.status;
}
