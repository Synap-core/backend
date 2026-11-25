/**
 * The degraded-capture sweep: a text capture the AI could not structure (the
 * IS was down, refused the pod's credentials, or the account was out of budget
 * or quota) was saved raw, as a note, with a `degraded` marker on its intake
 * source. Once the AI answers again, this sweep structures it (founder answer
 * 8, 21 Nov 2026; ticket 1fed22a3).
 *
 * No second structuring path: each capture goes through `structureCaptureAgain`
 * (the "Structure again" door → `rerunSession` → `capture.structure` →
 * `submitCaptureGraph`), mode `add`, AS THE ACTOR WHO CAPTURED IT (the marker's
 * `agentUserId`), so its result takes the governance the first capture would
 * have taken: an agent's capture becomes the agent's proposal. The raw note is
 * kept (mode `add` reverts nothing); the structure call that succeeds clears the
 * marker and records `restructuredAt` (`stageIntakeSource`), so a capture is
 * never re-structured twice.
 *
 * Rules (founder defaults, named in the PR):
 *   - oldest first, a small batch per run, a per-run and a per-day cap, so a new
 *     quota is not spent at once;
 *   - each owner's AI is probed first (its IS `/health`); an owner whose AI
 *     does not answer, or whose first structure call answers "quota" or
 *     "unavailable" (`AI_DID_NOT_ANSWER`), is left for the next run, and nothing
 *     is marked failed;
 *   - any other failure counts on the source (`restructureSweep.failures`, with
 *     its reason); after `DEGRADED_SWEEP_MAX_FAILURES` the capture is left alone.
 *
 * Selection: live TEXT captures whose marker reason means the AI did not answer
 * (`AI_UNAVAILABLE_DEGRADED_REASONS`). A capture the AI read and found nothing
 * in, or one the pod is not configured to read, is not "saved because AI was
 * unavailable" and is never swept.
 */

import {
  db,
  and,
  asc,
  eq,
  inArray,
  drizzleSql,
  documents,
  focusSessions,
} from "@synap/database";
import { createLogger } from "@synap-core/core";
import type { Context } from "../../types/context.js";
import {
  classifyAiFailure,
  type AiFailureClass,
} from "../../utils/ai-failure.js";
import { AI_UNAVAILABLE_DEGRADED_REASONS } from "../capture-agent/capture-degraded-guidance.js";
import {
  INTAKE_SOURCE_METADATA_KEY,
  type IntakeSourceMetadata,
  type RestructureSweepRecord,
} from "../intake/stage-intake-source.js";
import { liveCapturesWhere } from "./capture-scope.js";
import type { CaptureStructureAgainResult } from "./structure-capture-again.js";
import type { rerunSession } from "../focus-sessions/rerun-session.js";

const logger = createLogger({ module: "restructure-degraded-captures" });

/** Captures structured per run, at most. */
export const DEGRADED_SWEEP_PER_RUN = 5;
/** Structure attempts per UTC day, pod-wide, at most. */
export const DEGRADED_SWEEP_PER_DAY = 40;
/** Failures (not "AI unavailable") after which a capture is left alone. */
export const DEGRADED_SWEEP_MAX_FAILURES = 3;

/**
 * The answers that mean the AI did not answer FOR THIS ACCOUNT right now:
 * spent quota, budget or credit, a plan without AI, refused credentials, a
 * rate limit, an open breaker, an outage. They stop the sweep for that owner
 * and mark nothing. Everything else (an unreadable answer, a timeout on a long
 * text, a refusal of this input, an unknown cause) is about the capture and
 * counts as a failure on it.
 */
export const AI_DID_NOT_ANSWER: ReadonlySet<AiFailureClass> = new Set([
  "quota",
  "plan_quota",
  "account_quota",
  "not_entitled",
  "credits_empty",
  "access_suspended",
  "account_inactive",
  "budget",
  "auth",
  "rate_limit",
  "circuit",
  "entitlement_unavailable",
  "upstream",
]);

export interface DegradedCaptureActor {
  documentId: string;
  userId: string;
  /** The agent that captured it; null for the person. */
  agentUserId: string | null;
}

/** What one structure attempt came to, for the sweep. */
export type RestructureAttempt =
  /** Structured (proposed, applied, a duplicate, or a question for the person). */
  | { kind: "done"; outcome: string }
  /** The AI did not answer for this owner: stop, mark nothing. */
  | { kind: "stop"; failureClass: AiFailureClass }
  /** Busy or already running: try again next run, mark nothing. */
  | { kind: "later"; reason: string }
  /** Failed for this capture: counts. */
  | { kind: "failed"; reason: string };

export interface DegradedSweepResult {
  status: "idle" | "ran" | "daily_cap";
  attempted: number;
  restructured: number;
  failed: number;
  /** Owners left for the next run, and why. */
  stopped: Array<{ userId: string; reason: string }>;
}

/**
 * Read a `structureCaptureAgain` answer for ONE capture. Pure: the unit and
 * pglite tests read the real door's shapes through it.
 */
export function readRestructureAttempt(
  result: CaptureStructureAgainResult,
  documentId: string
): RestructureAttempt {
  if (!result.ok) {
    if (
      result.reason === "in_flight" ||
      result.reason === "availability_unknown"
    ) {
      return { kind: "later", reason: result.reason };
    }
    return { kind: "failed", reason: `${result.reason}: ${result.message}` };
  }
  if (result.status === "dry_run" || result.status === "reused") {
    return { kind: "later", reason: result.status };
  }
  const item = result.items.find((i) =>
    i.sourceDocumentIds.includes(documentId)
  );
  if (!item) {
    return { kind: "failed", reason: "the rerun replayed nothing for it" };
  }
  if (
    item.outcome === "proposed" ||
    item.outcome === "applied" ||
    item.outcome === "deduplicated" ||
    item.outcome === "needs_input"
  ) {
    return { kind: "done", outcome: item.outcome };
  }
  if (item.failureClass && AI_DID_NOT_ANSWER.has(item.failureClass)) {
    return { kind: "stop", failureClass: item.failureClass };
  }
  return {
    kind: "failed",
    reason: [item.outcome, item.failureClass, item.reason]
      .filter(Boolean)
      .join(": "),
  };
}

const utcDay = (d: Date) => d.toISOString().slice(0, 10);

const sweepPath = (...keys: string[]) =>
  `{${[INTAKE_SOURCE_METADATA_KEY, "restructureSweep", ...keys].join(",")}}`;

/**
 * Who captured a source saved before the marker named its actor: the agent of
 * the run room it was staged in when an agent opened that room, else the
 * person. Erring toward the agent only ever makes the result a proposal.
 */
async function legacyActor(
  database: typeof db,
  userId: string,
  sessionId: string | null
): Promise<string | null> {
  if (!sessionId) return null;
  const [run] = await database
    .select({ origin: focusSessions.origin, agentIds: focusSessions.agentIds })
    .from(focusSessions)
    .where(
      and(eq(focusSessions.id, sessionId), eq(focusSessions.userId, userId))
    )
    .limit(1);
  return run?.origin === "agent" ? (run.agentIds?.[0] ?? null) : null;
}

/** The owner's AI answers its liveness door (the IS a capture would call). */
async function probeOwnerAi(userId: string): Promise<boolean> {
  try {
    const { resolveIntelligenceService } =
      await import("@synap/intelligence-client");
    const { client } = await resolveIntelligenceService({
      userId,
      capability: "default",
    });
    return await client.healthCheck();
  } catch (err) {
    // Unknown is not "answers": nothing is spent, the owner waits a run.
    logger.warn({ err, userId }, "degraded sweep: the AI could not be probed");
    return false;
  }
}

/** The one redo door, as the actor who captured it. */
async function restructureAsActor(
  actor: DegradedCaptureActor,
  rerun?: typeof rerunSession
): Promise<CaptureStructureAgainResult> {
  const { structureCaptureAgain } =
    await import("./structure-capture-again.js");
  const callerContext: Context = actor.agentUserId
    ? await (
        await import("../../routers/hub-protocol/utils.js")
      ).createHubProtocolCallerContext(
        actor.userId,
        ["mcp.read", "mcp.write"],
        null,
        null,
        null,
        actor.agentUserId
      )
    : ({ db, authenticated: true, userId: actor.userId } as Context);
  return structureCaptureAgain({
    documentId: actor.documentId,
    userId: actor.userId,
    mode: "add",
    reason: "Saved without AI; structured once the AI answered again.",
    agentUserId: actor.agentUserId,
    callerContext,
    ...(rerun ? { rerun } : {}),
  });
}

export async function sweepDegradedCaptures(
  deps: {
    database?: typeof db;
    now?: Date;
    perRun?: number;
    perDay?: number;
    probe?: (userId: string) => Promise<boolean>;
    /** Injected for tests: the rerun door the default restructure calls. */
    rerun?: typeof rerunSession;
  } = {}
): Promise<DegradedSweepResult> {
  const database = deps.database ?? db;
  const now = deps.now ?? new Date();
  const perRun = deps.perRun ?? DEGRADED_SWEEP_PER_RUN;
  const perDay = deps.perDay ?? DEGRADED_SWEEP_PER_DAY;
  const probe = deps.probe ?? probeOwnerAi;
  const restructure = (actor: DegradedCaptureActor) =>
    restructureAsActor(actor, deps.rerun);
  const today = utcDay(now);
  const result: DegradedSweepResult = {
    status: "idle",
    attempted: 0,
    restructured: 0,
    failed: 0,
    stopped: [],
  };

  const meta = documents.metadata;
  const [{ used } = { used: 0 }] = await database
    .select({
      used: drizzleSql<number>`coalesce(sum((${meta} #>> ${sweepPath("dayAttempts")}::text[])::int), 0)::int`,
    })
    .from(documents)
    .where(
      and(
        liveCapturesWhere(),
        drizzleSql`${meta} #>> ${sweepPath("day")}::text[] = ${today}`
      )
    );
  const budget = Math.min(perRun, perDay - Number(used));
  if (budget <= 0) return { ...result, status: "daily_cap" };

  // A wider window than the budget, so one owner waiting on their quota does
  // not starve another owner's captures behind it.
  const rows = await database
    .select({ id: documents.id, userId: documents.userId, metadata: meta })
    .from(documents)
    .where(
      and(
        liveCapturesWhere(),
        drizzleSql`${meta} #>> ${`{${INTAKE_SOURCE_METADATA_KEY},kind}`}::text[] = 'text'`,
        inArray(
          drizzleSql`${meta} #>> ${`{${INTAKE_SOURCE_METADATA_KEY},degraded,reason}`}::text[]`,
          [...AI_UNAVAILABLE_DEGRADED_REASONS]
        ),
        drizzleSql`coalesce((${meta} #>> ${sweepPath("failures")}::text[])::int, 0) < ${DEGRADED_SWEEP_MAX_FAILURES}`
      )
    )
    .orderBy(
      asc(
        drizzleSql`${meta} #>> ${`{${INTAKE_SOURCE_METADATA_KEY},degraded,at}`}::text[]`
      ),
      asc(documents.createdAt)
    )
    .limit(Math.min(budget * 5, 100));
  if (rows.length === 0) return result;
  result.status = "ran";

  const probed = new Map<string, boolean>();
  const stoppedOwners = new Set<string>();
  const stop = (userId: string, reason: string) => {
    stoppedOwners.add(userId);
    result.stopped.push({ userId, reason });
  };

  for (const row of rows) {
    if (result.attempted >= budget) break;
    if (stoppedOwners.has(row.userId)) continue;
    if (!probed.has(row.userId)) {
      const answers = await probe(row.userId);
      probed.set(row.userId, answers);
      if (!answers) {
        stop(row.userId, "the AI did not answer its health probe");
        continue;
      }
    }
    const source = (row.metadata as Record<string, unknown>)[
      INTAKE_SOURCE_METADATA_KEY
    ] as IntakeSourceMetadata;
    const marker = source.degraded;
    const agentUserId =
      marker?.agentUserId !== undefined
        ? marker.agentUserId
        : await legacyActor(database, row.userId, source.sessionId);

    let attempt: RestructureAttempt;
    try {
      attempt = readRestructureAttempt(
        await restructure({
          documentId: row.id,
          userId: row.userId,
          agentUserId,
        }),
        row.id
      );
    } catch (err) {
      const failureClass = classifyAiFailure(err);
      attempt = AI_DID_NOT_ANSWER.has(failureClass)
        ? { kind: "stop", failureClass }
        : {
            kind: "failed",
            reason: err instanceof Error ? err.message : String(err),
          };
    }

    if (attempt.kind === "stop") {
      stop(row.userId, attempt.failureClass);
      continue;
    }
    if (attempt.kind === "later") continue;

    const prior = source.restructureSweep;
    const record: RestructureSweepRecord = {
      failures: (prior?.failures ?? 0) + (attempt.kind === "failed" ? 1 : 0),
      lastAttemptAt: now.toISOString(),
      lastOutcome: attempt.kind === "done" ? attempt.outcome : "failed",
      ...(attempt.kind === "failed" ? { lastReason: attempt.reason } : {}),
      day: today,
      dayAttempts: prior?.day === today ? prior.dayAttempts + 1 : 1,
    };
    // One key, set in place: the structure call has just rewritten this row's
    // marker (`restructuredAt`), which a whole-metadata write would race.
    await database
      .update(documents)
      .set({
        metadata: drizzleSql`jsonb_set(${meta}, ${sweepPath()}::text[], ${JSON.stringify(record)}::jsonb, true)`,
      })
      .where(eq(documents.id, row.id));

    result.attempted += 1;
    if (attempt.kind === "done") result.restructured += 1;
    else result.failed += 1;
    logger.info(
      { documentId: row.id, userId: row.userId, agentUserId, attempt },
      "degraded sweep: capture structured again"
    );
  }
  return result;
}
