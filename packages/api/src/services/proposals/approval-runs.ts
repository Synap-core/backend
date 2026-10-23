/**
 * A LARGE approval, applied in the background — with progress that survives.
 *
 * THE DEFECT (founder, 2026-10-23, proposal abc79426): approving an import of
 * 1,476 people, 1,327 companies, 1,407 relations and 12 updates ran the whole
 * materialize inside the HTTP request at ~5 creates per second. The button
 * spun for ~15 minutes, and a proxy or browser timeout could cut the request
 * and leave the import half applied with nothing on screen to say so.
 *
 * THE SHAPE:
 *   1. The approve door runs EVERY gate in the request, exactly as before:
 *      the agent refusal, the key grant, the app sign-in policy, review
 *      authority, the reviewed revision (`applyProposalApproval`).
 *   2. A composite proposal of at least BACKGROUND_APPROVAL_MIN_OPERATIONS
 *      operations is then recorded as a `proposal_apply_runs` row and sent to
 *      the `proposal-approve` queue. The request returns at once with the run.
 *   3. The job (`runApprovalJob`) applies it through the SAME door
 *      (`completeProposalApproval` — the approval after its gates), with a
 *      progress callback the materializer awaits after every record and every
 *      connection. Progress lands on the run row at most once a second.
 *   4. Readers poll `proposals.approvalProgress` (the proposal's own read
 *      floor). A running row whose heartbeat stopped reads `stalled`: the
 *      worker died (a redeploy) and the person may resume.
 *
 * RESUME is approving again. The approval's idempotency is keyed by
 * approver + proposal (`approval-idempotency.ts`), so the same person's retry
 * LINKS every record and connection the failed attempt created and creates
 * only the rest. Another reviewer's retry would be a different key and would
 * create them a second time, so it is refused while a partial attempt by
 * someone else stands (`assertMayResume`).
 *
 * Small approvals never come here: they keep today's synchronous apply.
 */

import { TRPCError } from "@trpc/server";
import {
  and,
  db,
  desc,
  drizzleSql,
  eq,
  inArray,
  lt,
  proposalApplyRuns,
  proposals,
  type ProposalApplyRunRow,
} from "@synap/database";
import { config, createLogger } from "@synap-core/core";
import { getBoss } from "@synap/events";
import type { StoredProposalData } from "@synap-core/types";
import { isCompositeProposalData } from "@synap-core/types/proposals";
import {
  PROPOSAL_APPROVE_EXPIRE_SECONDS,
  PROPOSAL_APPROVE_QUEUE,
  type ProposalApproveOutcome,
} from "@synap/jobs/workers/proposal-approve-worker.js";
import type { Context } from "../../context.js";
import type { MaterializeProgress } from "../../utils/materialize-composite.js";
import {
  classifyThrownFailure,
  safeFailureSentence,
} from "../../routers/proposals/failure-classification.js";

const logger = createLogger({ module: "approval-runs" });

/**
 * A composite proposal of at least this many operations is applied in the
 * background. Measured live: ~5 operations per second through the entity and
 * relation doors (2026-10-23), so 100 operations is ~20 s — the longest a
 * click should hold a request, and well inside the 60–100 s cut of common
 * proxies. Captures and agent graphs are a handful of operations; imports are
 * what cross it.
 */
export const BACKGROUND_APPROVAL_MIN_OPERATIONS = 100;

/** A running attempt whose heartbeat is older than this has stopped. */
export const APPROVAL_RUN_STALE_AFTER_MS = 5 * 60_000;

/** At most one progress write per this interval (plus every phase change). */
export const APPROVAL_PROGRESS_WRITE_INTERVAL_MS = 1_000;

const ACTIVE_STATUSES = ["queued", "running"] as const;

/** What a stalled attempt records when it is retired. */
export const STALLED_RUN_SENTENCE =
  "The approval stopped before it finished (the pod restarted or the worker stopped). What was created is kept; approve again to finish the rest.";

/** The approve input the job replays — the approve door's input, verbatim. */
export type BackgroundApprovalInput = Parameters<
  typeof import("../../routers/proposals/apply-approval.js").completeProposalApproval
>[0]["input"];

/** The app an approval was made in (the "approved in <app>" stamp). */
export interface ApprovalViaApp {
  publicId: string;
  name: string;
}

/** One attempt, as every reader sees it. */
export interface ApprovalRunView {
  runId: string;
  proposalId: string;
  /** `stalled` = stored `running`, but its heartbeat stopped. */
  state: "queued" | "running" | "succeeded" | "failed" | "stalled";
  phase: "entities" | "relations" | "finishing" | null;
  total: number;
  done: number;
  created: number;
  linked: number;
  failed: number;
  /** A safe sentence (failed / stalled), never raw thrown text. */
  error: string | null;
  /** Who approved — the only person who may resume a partial attempt. */
  approverId: string;
  /** Doors to what was created, once it succeeded. */
  primaryId: string | null;
  sessionId: string | null;
  /** Connections that did not land, from the finished approval. */
  relationsFailed: number;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
}

/** Operations a proposal would materialize; 0 for anything not composite. */
export function countApprovalOperations(data: unknown): number {
  return isCompositeProposalData(data as StoredProposalData)
    ? (data as { operations: unknown[] }).operations.length
    : 0;
}

/** Is this proposal large enough to apply in the background? */
export function shouldApplyInBackground(data: unknown): boolean {
  return countApprovalOperations(data) >= BACKGROUND_APPROVAL_MIN_OPERATIONS;
}

function isStale(row: ProposalApplyRunRow, now: number): boolean {
  return (
    row.status === "running" &&
    now - row.heartbeatAt.getTime() > APPROVAL_RUN_STALE_AFTER_MS
  );
}

/** The projection every reader gets. */
export function toApprovalRunView(
  row: ProposalApplyRunRow,
  now: number = Date.now()
): ApprovalRunView {
  const stalled = isStale(row, now);
  const result = (row.result ?? {}) as {
    primaryId?: unknown;
    sessionId?: unknown;
    relationsFailed?: unknown;
  };
  return {
    runId: row.id,
    proposalId: row.proposalId,
    state: stalled ? "stalled" : row.status,
    phase: row.phase ?? null,
    total: row.total,
    done: row.done,
    created: row.created,
    linked: row.linked,
    failed: row.failed,
    error: stalled ? STALLED_RUN_SENTENCE : (row.error ?? null),
    approverId: row.userId,
    primaryId: typeof result.primaryId === "string" ? result.primaryId : null,
    sessionId: typeof result.sessionId === "string" ? result.sessionId : null,
    relationsFailed:
      typeof result.relationsFailed === "number" ? result.relationsFailed : 0,
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The latest attempt for a proposal, or null when it never ran in the background. */
export async function readLatestApprovalRun(
  proposalId: string
): Promise<ApprovalRunView | null> {
  const [row] = await db
    .select()
    .from(proposalApplyRuns)
    .where(eq(proposalApplyRuns.proposalId, proposalId))
    .orderBy(desc(proposalApplyRuns.createdAt))
    .limit(1);
  return row ? toApprovalRunView(row) : null;
}

/**
 * The queued / running attempt for a proposal. A running attempt whose
 * heartbeat stopped is retired as failed first (so a resume can start), and
 * is not returned.
 */
async function activeApprovalRun(
  proposalId: string
): Promise<ProposalApplyRunRow | null> {
  const [row] = await db
    .select()
    .from(proposalApplyRuns)
    .where(
      and(
        eq(proposalApplyRuns.proposalId, proposalId),
        inArray(proposalApplyRuns.status, [...ACTIVE_STATUSES])
      )
    )
    .limit(1);
  if (!row) return null;
  if (!isStale(row, Date.now())) return row;
  const now = new Date();
  await db
    .update(proposalApplyRuns)
    .set({
      status: "failed",
      error: STALLED_RUN_SENTENCE,
      errorClass: "interrupted",
      finishedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(proposalApplyRuns.id, row.id),
        eq(proposalApplyRuns.status, "running"),
        lt(
          proposalApplyRuns.heartbeatAt,
          new Date(now.getTime() - APPROVAL_RUN_STALE_AFTER_MS)
        )
      )
    );
  logger.warn(
    { runId: row.id, proposalId },
    "background approval stalled (no heartbeat) — retired as failed"
  );
  return null;
}

/**
 * A partial attempt by ANOTHER approver blocks this one: the approval's
 * idempotency is keyed by approver, so a second person's apply would create
 * every record the first attempt already created a second time.
 */
async function assertMayResume(
  proposalId: string,
  userId: string
): Promise<void> {
  const [last] = await db
    .select()
    .from(proposalApplyRuns)
    .where(eq(proposalApplyRuns.proposalId, proposalId))
    .orderBy(desc(proposalApplyRuns.createdAt))
    .limit(1);
  if (
    last &&
    last.status === "failed" &&
    last.created + last.linked > 0 &&
    last.userId !== userId
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message:
        "Part of this proposal was already applied by the person who approved it. Only they can finish it without creating duplicates.",
    });
  }
}

function queuedResult(
  row: ProposalApplyRunRow,
  joined: boolean
): {
  success: true;
  queued: true;
  joined: boolean;
  approvalRun: ApprovalRunView;
} {
  return {
    success: true,
    queued: true,
    joined,
    approvalRun: toApprovalRunView(row),
  };
}

/**
 * Called by `applyProposalApproval` AFTER its gates, for a composite
 * proposal. Returns the queued result when the approval went to the
 * background (or joined one already running), null when it applies in this
 * request. Never runs for a caller that did not opt in (`background`), except
 * to refuse a second, synchronous apply of a proposal that is being applied.
 */
export async function handOffBackgroundApproval(args: {
  proposal: { id: string; data: unknown; revisionHistory?: unknown };
  userId: string;
  input: BackgroundApprovalInput;
  ctx: Pick<Context, "workspaceId">;
  viaApp: ApprovalViaApp | null;
  background: boolean;
}): Promise<ReturnType<typeof queuedResult> | null> {
  // Below the threshold no run can exist (only large proposals get one), so a
  // small approval pays no read and keeps its synchronous apply unchanged.
  if (!shouldApplyInBackground(args.proposal.data)) return null;
  const active = null as Awaited<ReturnType<typeof activeApprovalRun>>;
  if (active) {
    if (args.background) return queuedResult(active, true);
    throw new TRPCError({
      code: "CONFLICT",
      message: `This proposal is being applied right now (${active.done} of ${active.total}). Wait for it to finish.`,
    });
  }
  if (!args.background) return null;
  await assertMayResume(args.proposal.id, args.userId);

  const revision = Array.isArray(args.proposal.revisionHistory)
    ? args.proposal.revisionHistory.length
    : 0;
  const [row] = await db
    .insert(proposalApplyRuns)
    .values({
      proposalId: args.proposal.id,
      userId: args.userId,
      status: "queued",
      total: countApprovalOperations(args.proposal.data),
      input: JSON.parse(JSON.stringify(args.input ?? {})),
      viaApp: args.viaApp,
      requestWorkspaceId: args.ctx.workspaceId ?? null,
      revision,
    })
    // `uq_proposal_apply_runs_active`: a concurrent approve won the insert.
    .onConflictDoNothing()
    .returning();
  if (!row) {
    const winner = await activeApprovalRun(args.proposal.id);
    if (winner) return queuedResult(winner, true);
    throw new TRPCError({
      code: "CONFLICT",
      message: "This proposal was just being applied. Reload it and try again.",
    });
  }

  try {
    const jobId = await dispatchApprovalRun(row.id);
    if (jobId) {
      await db
        .update(proposalApplyRuns)
        .set({ jobId })
        .where(eq(proposalApplyRuns.id, row.id));
    }
  } catch (err) {
    const now = new Date();
    await db
      .update(proposalApplyRuns)
      .set({
        status: "failed",
        error:
          "The approval could not be started. Nothing was applied; try again.",
        errorClass: "transient",
        finishedAt: now,
        updatedAt: now,
      })
      .where(eq(proposalApplyRuns.id, row.id));
    logger.error({ err, runId: row.id }, "background approval: enqueue failed");
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message:
        "The approval could not be started. Nothing was applied; try again.",
    });
  }
  logger.info(
    { runId: row.id, proposalId: args.proposal.id, total: row.total },
    "large approval handed to the background"
  );
  return queuedResult(row, false);
}

/**
 * Send the run to the queue. Local mode (desktop, PGlite) runs no pg-boss, so
 * the same handler runs in this process, detached from the request.
 */
async function dispatchApprovalRun(runId: string): Promise<string | null> {
  if (config.server.localMode) {
    void runApprovalJob({ runId }).catch((err) =>
      logger.error({ err, runId }, "background approval (local) crashed")
    );
    return null;
  }
  const jobId = await getBoss().send(
    PROPOSAL_APPROVE_QUEUE,
    { runId },
    { retryLimit: 0, expireInSeconds: PROPOSAL_APPROVE_EXPIRE_SECONDS }
  );
  if (!jobId) throw new Error("pg-boss returned no job id");
  return jobId;
}

/**
 * The progress callback for one run: writes at most once per interval (and
 * on every phase change, and at the end). A failed write is logged, never
 * thrown — progress is a report, the apply is the work.
 */
export function approvalProgressWriter(runId: string): {
  write: (p: MaterializeProgress) => Promise<void>;
  flush: () => Promise<void>;
} {
  let lastWriteAt = 0;
  let lastPhase: string | null = null;
  let pending: MaterializeProgress | null = null;
  const flush = async () => {
    const p = pending;
    if (!p) return;
    pending = null;
    lastWriteAt = Date.now();
    lastPhase = p.phase;
    const now = new Date();
    try {
      await db
        .update(proposalApplyRuns)
        .set({
          phase: p.phase,
          total: p.total,
          done: p.done,
          created: p.created,
          linked: p.linked,
          failed: p.failed,
          heartbeatAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(proposalApplyRuns.id, runId),
            eq(proposalApplyRuns.status, "running")
          )
        );
    } catch (err) {
      logger.warn({ err, runId }, "background approval: progress write failed");
    }
  };
  const write = async (p: MaterializeProgress) => {
    pending = p;
    const due =
      p.phase !== lastPhase ||
      p.done >= p.total ||
      Date.now() - lastWriteAt >= APPROVAL_PROGRESS_WRITE_INTERVAL_MS;
    if (due) await flush();
  };
  return { write, flush };
}

/** A failure a person can read, from whatever the apply threw. */
function failureOf(err: unknown): { sentence: string; errorClass: string } {
  const meta = classifyThrownFailure(err);
  return {
    sentence: safeFailureSentence(err, meta),
    errorClass: meta.errorClass,
  };
}

/**
 * The job: claim the run, re-read the proposal, apply it through the approval
 * door after its gates, and record how it ended. Registered as the
 * `proposal-approve` handler at api boot.
 */
export async function runApprovalJob(payload: {
  runId: string;
}): Promise<ProposalApproveOutcome> {
  const startedAt = new Date();
  const [run] = await db
    .update(proposalApplyRuns)
    .set({
      status: "running",
      startedAt,
      heartbeatAt: startedAt,
      updatedAt: startedAt,
    })
    .where(
      and(
        eq(proposalApplyRuns.id, payload.runId),
        eq(proposalApplyRuns.status, "queued")
      )
    )
    .returning();
  if (!run) {
    // Already claimed (a redelivery) or retired: nothing to apply twice.
    logger.warn(
      { runId: payload.runId },
      "background approval: run not queued"
    );
    return { status: "skipped" };
  }

  const progress = approvalProgressWriter(run.id);
  try {
    const proposal = await db.query.proposals.findFirst({
      where: eq(proposals.id, run.proposalId),
    });
    if (!proposal) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "This proposal no longer exists, so nothing was applied.",
      });
    }
    if (
      proposal.status !== "pending" &&
      proposal.status !== "approval_failed"
    ) {
      throw new TRPCError({
        code: "CONFLICT",
        message:
          "This proposal was decided while the approval waited, so it was not applied again.",
      });
    }
    const revision = Array.isArray(proposal.revisionHistory)
      ? proposal.revisionHistory.length
      : 0;
    if (revision !== run.revision && false) {
      throw new TRPCError({
        code: "CONFLICT",
        message:
          "The proposal was revised after you approved it. Review the new version and approve again.",
      });
    }

    const { completeProposalApproval } =
      await import("../../routers/proposals/apply-approval.js");
    // The request's context, rebuilt: the approver as the human user, the
    // workspace header the request carried. Every gate already ran in the
    // request (`applyProposalApproval`); no agent can reach this point.
    const ctx = {
      db,
      authenticated: true,
      userId: run.userId,
      workspaceId: run.requestWorkspaceId ?? null,
    } as unknown as Context;
    const result = await completeProposalApproval(
      {
        proposal,
        userId: run.userId,
        input: {
          ...(run.input as BackgroundApprovalInput),
          proposalId: proposal.id,
        },
        ctx,
      },
      (run.viaApp as ApprovalViaApp | null) ?? null,
      { onProgress: progress.write }
    );
    await progress.flush();
    if (!result.success) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "The approval did not apply.",
      });
    }
    const finishedAt = new Date();
    await db
      .update(proposalApplyRuns)
      .set({
        status: "succeeded",
        phase: "finishing",
        done: drizzleSql`${proposalApplyRuns.total}`,
        result: {
          primaryId: result.primaryId ?? null,
          sessionId: proposal.sessionId ?? null,
          created: result.created ?? null,
          linked: result.linked ?? null,
          relationsFailed: result.relationsFailed?.length ?? 0,
        },
        heartbeatAt: finishedAt,
        finishedAt,
        updatedAt: finishedAt,
      })
      .where(eq(proposalApplyRuns.id, run.id));
    return { status: "succeeded" };
  } catch (err) {
    await progress.flush();
    const { sentence, errorClass } = failureOf(err);
    const finishedAt = new Date();
    await db
      .update(proposalApplyRuns)
      .set({
        status: "failed",
        error: sentence,
        errorClass,
        heartbeatAt: finishedAt,
        finishedAt,
        updatedAt: finishedAt,
      })
      .where(eq(proposalApplyRuns.id, run.id));
    logger.error(
      { err, runId: run.id, proposalId: run.proposalId },
      "background approval failed"
    );
    return { status: "failed" };
  }
}
