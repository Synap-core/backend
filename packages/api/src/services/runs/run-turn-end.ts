/**
 * THE end of an IS turn on a live playbook run — what
 * `POST /api/hub/focus-sessions/:id/complete-run` does with the IS's report
 * (B8, founder-approved 2026-10-21).
 *
 * THE DEFECT. complete-run marked the run `completed` after EVERY turn. A turn
 * the IS's token budget cut short (`turn-input-budget.ts`: "I stopped here
 * because this turn reached its input budget") therefore finished the run 11 s
 * after it started: the run read `completed`, its work was not done, and the
 * 45-minute idle flag (`diagnose/stall.ts`) and the 24-hour reaper
 * (`playbook-run-reaper.ts`) never saw it, because both only look at LIVE runs.
 *
 * NOW the IS says how the turn ended (`outcome`). `completed` completes the
 * run; a run with NO stages is then done, and its session is closed at once
 * through the one close door unless something in it waits on the person
 * (`closeStagelessRunSessionAtTurnEnd`, founder 9 Nov 2026). A
 * `stopped` turn — its token budget (`turn_budget`) or its step limit
 * (`max_steps`: the agent still had tool calls to make when the SDK's
 * `maxSteps` ended the turn) — leaves the run LIVE and:
 *   1. continues on its own with a fresh turn — a pod notice in the room,
 *      dispatched through the ONE turn door `triggerAutoRespond` to the same
 *      agent type — up to {@link MAX_AUTO_CONTINUATIONS} times in a row;
 *   2. then ASKS the person, through the existing ask/slot door: a `decision`
 *      slot handed to them by an agent question in the room
 *      (`postChannelMessage kind:'question' slotLabel` → `fileRoomQuestionOnSlot`
 *      → `blockExpectedOutput`, which notifies). The run is marked
 *      `waiting_on_you`; the reaper un-parks it once the slot is answered, and
 *      the answer wakes the asking agent (`session-answer.ts`). The counter
 *      resets once the ask has LANDED, so after an answer the run again gets
 *      N continuations.
 * If neither lands, nothing will move the run again: it ends `failed`
 * (`could_not_continue`) and its session closes `failed`, instead of waiting
 * a day for the reaper.
 *
 * A turn that FAILED (`outcome: failed`: every pod read failed, the turn
 * threw, or its first call did not fit its budget) ends the run the same way,
 * with the IS's reason (`endFailedRun`).
 *
 * NO PERSON IN THE LOOP (founder decision E3, 2026-10-27). A run an automation
 * started (its schedule included) has nobody watching it, so step 2 never
 * happens there: once its continuations are spent it ENDS, `failed` with the
 * reason and `stop_reason = 'budget'` (so its automation's breakers skip it,
 * founder F3), and a pod notice in the room says why. Asking would put "Keep
 * the run going" in a person's Needs you for a run they never started.
 *
 * WHAT IS RECORDED (`focus_sessions.metadata.runTurns`, server-owned): each
 * turn's end as the IS measured it — the budget ceiling, the input tokens
 * spent, the FIRST provider call's size by part (system prompt, tools,
 * history, message), the model that served the turn's last call, and the
 * prompt-cache tokens the provider reported (read, written). `firstTurn` keeps the run's first turn (the 11-second
 * stop's cause); `turns` the last {@link TURN_HISTORY_MAX}. Keyed by run id: a
 * later run on the same session starts from zero.
 *
 * Caller-gated: the route has already authorized the caller on the session
 * row (`resolveRowActingContext`). No new status: the run statuses are
 * `PlaybookRunStatus`, written through `applyRunCapture`.
 */

import { z } from "zod";
import {
  and,
  db,
  desc,
  eq,
  focusSessions,
  liveRunStatusWhere,
  owedSlotWhere,
  playbookRuns,
} from "@synap/database";
import type { PlaybookRun } from "@synap/database/schema";
import type {
  ExpectedOutput,
  SlotAnswerValue,
  SlotAsk,
} from "@synap/playbooks";
import { createLogger } from "@synap-core/core";
import { isUuid } from "@synap-core/types/property-render";
import type { RunToolProfile } from "@synap/intelligence-client";
import { applyRunCapture } from "./apply-run-capture.js";
import { postChannelMessage } from "../messaging/post-message.js";
import { triggerAutoRespond } from "../../utils/trigger-auto-respond.js";
import {
  mergeSessionMetadata,
  RUN_TURNS_META_KEY,
} from "../focus-sessions/session-metadata.js";
import { normalizeExpectedLabel } from "../focus-sessions/expected-label.js";
import { raiseRunAsk } from "./run-ask.js";
import { settleStageEndAsk, stageAskTurnEntries } from "./stage-end-ask.js";
import { startedByAutomation } from "../focus-sessions/session-kind.js";
import { closeStagelessRunSessionAtTurnEnd } from "../focus-sessions/session-lifecycle-sweep.js";
import { completeFocusSession } from "../focus-sessions/complete-session.js";
import { resolveRunToolProfile } from "../playbooks/run-tool-profile.js";
import { stampedGuidanceOf } from "../playbooks/playbook-guidance.js";
import {
  TURN_CONTEXT_MAX_ARRAY_ITEMS,
  TURN_CONTEXT_MAX_STRING_LENGTH,
  type TurnContext,
} from "../../routers/channels/helpers.js";

type TurnContextEntry = NonNullable<TurnContext["entries"]>[number];

const logger = createLogger({ module: "run-turn-end" });

/** Founder decision B8 (2026-10-21): N = 2 automatic continuations, then ask. */
export const MAX_AUTO_CONTINUATIONS = 2;

export { RUN_TURNS_META_KEY };

/** How many recent turn records are kept (the first turn is kept apart). */
export const TURN_HISTORY_MAX = 10;

/** The slot the person is asked on, once the continuations are spent. */
export const RUN_CONTINUE_SLOT_LABEL = "Keep the run going";

const count = z.number().int().nonnegative();

/** Why a `stopped` turn stopped: the run stays live. */
const RUN_STOP_REASONS = ["turn_budget", "max_steps"] as const;

/**
 * Why a `failed` turn failed, as the IS reports it: every pod call of the
 * turn failed (`read_failed`), the turn threw after its provider fallbacks
 * (`turn_error`), or its first call did not fit its token budget
 * (`budget_exceeded`, a continuation would hit the same wall).
 */
export const RUN_TURN_FAILURE_REASONS = [
  "read_failed",
  "turn_error",
  "budget_exceeded",
] as const;
export type RunTurnFailureReason = (typeof RUN_TURN_FAILURE_REASONS)[number];

/**
 * Why a run ended `failed` at a turn's end: the IS's reasons, or the pod's own
 * `could_not_continue` (a stopped run it could neither continue nor ask about).
 */
export type RunFailureReason = RunTurnFailureReason | "could_not_continue";

/** Bounds of the first call's inventory (`firstCall.sections|tools|guidance`). */
export const FIRST_CALL_SECTIONS_MAX = 24;
export const FIRST_CALL_TOOLS_MAX = 200;
export const FIRST_CALL_GUIDANCE_MAX = 12;

/** Bounds of a run checkpoint, the IS's own (`run-profile.ts`). */
export const CHECKPOINT_MAX_RECORDS = 60;
export const CHECKPOINT_MAX_LEFT_CHARS = 4_000;

/**
 * One checkpoint record. The id is any 8-4-4-4-12 hex id (`isUuid`, the IS's
 * own shape): an RFC-only check refused real pod ids that carry no version
 * nibble, and with them the whole checkpoint.
 */
const checkpointRecordSchema = z.object({
  id: z.string().refine(isUuid, "not a uuid"),
  tool: z.string().min(1).max(200),
});

/**
 * The complete-run body. Every field optional: an IS that predates it sends
 * nothing, which means `completed` — exactly the old behaviour. MIRRORED by
 * the IS (`CompleteRunReport`, synap-intelligence-service
 * `clients/is-hub-client.ts`); this schema is the authority.
 */
export const completeRunBodySchema = z
  .object({
    outcome: z.enum(["completed", "stopped", "failed"]).default("completed"),
    /**
     * Why a `stopped` turn stopped: its token budget, or its step limit (the
     * founder default 2026-10-21: a step-limit stop is wired exactly like the
     * budget stop, never marked completed). Why a `failed` turn failed: one of
     * {@link RUN_TURN_FAILURE_REASONS}.
     */
    reason: z
      .enum([...RUN_STOP_REASONS, ...RUN_TURN_FAILURE_REASONS])
      .optional(),
    /**
     * The agent type that ran the turn — the continuation wakes the same one.
     * A FREE string (root CLAUDE.md "agentType = free string"), so no pattern;
     * and lenient: a value this door cannot use reads as absent (the default
     * agent) instead of refusing the whole report. A 400 here would drop the
     * turn's outcome and leave a finished run `running` for the 24-h reaper.
     */
    agentType: z.string().trim().min(1).max(200).optional().catch(undefined),
    /**
     * The IS's id for THIS turn, the same on every retry of its report: the
     * message that triggered the turn when the pod dispatched it, else an id
     * the IS minted once for the turn. A report whose key the ledger already
     * holds is a RETRY — recorded once, continued once. Lenient like
     * `agentType`: an unusable key reads as absent (the old, stop-count key).
     */
    turnKey: z.string().trim().min(1).max(256).optional().catch(undefined),
    turn: z
      .object({
        budgetAction: z.enum(["final", "stop"]).optional(),
        ceiling: count,
        spentInputTokens: count,
        firstCall: z
          .object({
            promptTokens: count,
            reported: z.boolean(),
            toolCount: count,
            chars: z.object({
              system: count,
              tools: count,
              history: count,
              message: count,
            }),
            /**
             * The inventory of what the agent was given (optional, added after
             * the counts): the system prompt's sections by name and size, the
             * tool names, and the guidance refs. Each one lenient: a bad value
             * reads as absent, never a 400 that would drop the turn's outcome.
             */
            sections: z
              .array(
                z.object({
                  name: z.string().trim().min(1).max(64),
                  chars: count,
                })
              )
              .max(FIRST_CALL_SECTIONS_MAX)
              .optional()
              .catch(undefined),
            tools: z
              .array(z.string().trim().min(1).max(128))
              .max(FIRST_CALL_TOOLS_MAX)
              .optional()
              .catch(undefined),
            guidance: z
              .array(z.string().trim().min(1).max(160))
              .max(FIRST_CALL_GUIDANCE_MAX)
              .optional()
              .catch(undefined),
          })
          .optional(),
        /**
         * The model id of the turn's last provider call (a fallback can serve
         * a turn on another model than it started on). Lenient like
         * `agentType`: an unusable value reads as absent, never a 400 that
         * would drop the turn's outcome.
         */
        model: z.string().trim().min(1).max(200).optional().catch(undefined),
        /**
         * Prompt-cache tokens the provider REPORTED over the turn, both part
         * of `spentInputTokens`: read from the cache, and written to it
         * (Anthropic). Absent = not reported, never 0. Lenient like `model`.
         */
        cacheReadInputTokens: count.optional().catch(undefined),
        cacheWriteInputTokens: count.optional().catch(undefined),
        /**
         * What the turn's input COUNTED against `ceiling`: its FRESH input,
         * `spentInputTokens` minus the cache reads the provider reported
         * (founder, 10 Nov 2026: cache reads count zero), so it can be lower
         * than `spentInputTokens`. Absent from an IS that counts every token
         * in full. Lenient like `model`.
         */
        chargedInputTokens: count.optional().catch(undefined),
      })
      .optional(),
    /**
     * A STOPPED run turn's checkpoint (IS `buildRunCheckpoint`): the records
     * it touched, by FULL id, and its last answer (done / plan / left). The
     * continuation notice carries it, so the next turn reads full ids instead
     * of re-resolving prefixes (run 9d57a207, finding 7726269d). Lenient like
     * `agentType`: a bad RECORD is dropped on its own, an over-long list or
     * answer is cut, and a checkpoint that is not an object, or keeps nothing,
     * reads as absent — never a 400 that would drop the turn's outcome.
     */
    checkpoint: z
      .object({
        records: z.array(z.unknown()).transform((records) =>
          records
            .flatMap((r) => {
              const one = checkpointRecordSchema.safeParse(r);
              return one.success ? [one.data] : [];
            })
            .slice(0, CHECKPOINT_MAX_RECORDS)
        ),
        left: z
          .string()
          .transform((left) => left.slice(0, CHECKPOINT_MAX_LEFT_CHARS)),
      })
      // Nothing usable left (no record, no answer) reads as absent.
      .transform((c) => (c.records.length > 0 || c.left !== "" ? c : undefined))
      .optional()
      .catch(undefined),
  })
  .refine((b) => b.outcome !== "stopped" || isRunStopReason(b.reason), {
    message: "outcome 'stopped' needs a reason ('turn_budget' | 'max_steps')",
    path: ["reason"],
  })
  .refine((b) => b.outcome !== "failed" || isRunTurnFailureReason(b.reason), {
    message: `outcome 'failed' needs a reason (${RUN_TURN_FAILURE_REASONS.map((r) => `'${r}'`).join(" | ")})`,
    path: ["reason"],
  });

export type CompleteRunBody = z.infer<typeof completeRunBodySchema>;

/** Why a turn stopped before the run was finished. */
export type RunStopReason = (typeof RUN_STOP_REASONS)[number];

function isRunStopReason(r: string | undefined): r is RunStopReason {
  return (RUN_STOP_REASONS as readonly string[]).includes(r ?? "");
}

function isRunTurnFailureReason(
  r: string | undefined
): r is RunTurnFailureReason {
  return (RUN_TURN_FAILURE_REASONS as readonly string[]).includes(r ?? "");
}

/** The limit a stopped turn hit, in the words the room reads. */
function stopLimitWords(reason: RunStopReason | undefined): string {
  return reason === "max_steps" ? "step limit" : "token budget";
}

/** What complete-run did with the run (the response `status`). */
export type CompleteRunStatus =
  | "completed"
  | "no-running-run"
  | "continued"
  | "waiting_on_you"
  | "left_running"
  /** No person in the loop: the run ended at its limit, with a notice. */
  | "stopped"
  /** The run could not read, its turn broke, or it could not continue. */
  | "failed"
  /** A retried report of a turn already settled: nothing done again. */
  | "duplicate";

/** One turn's end, as stored. */
export interface RunTurnRecord {
  at: string;
  outcome: CompleteRunBody["outcome"];
  reason?: RunStopReason | RunTurnFailureReason;
  agentType?: string;
  /** The IS's id for the turn (`CompleteRunBody.turnKey`). */
  turnKey?: string;
  budgetAction?: "final" | "stop";
  ceiling?: number;
  spentInputTokens?: number;
  firstCall?: NonNullable<CompleteRunBody["turn"]>["firstCall"];
  /** The model id of the turn's last provider call. */
  model?: string;
  /** Prompt-cache tokens the provider reported over the turn. */
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
  /** What counted against the ceiling: the fresh input (cache reads at 0). */
  chargedInputTokens?: number;
  /** What the pod decided for a stopped turn. */
  next?: "continue" | "ask";
  /** How many records the turn's checkpoint named (the ids ride in the room). */
  checkpointRecords?: number;
}

/** `metadata.runTurns` — one run's turn ledger. */
export interface RunTurnsState {
  runId: string;
  /** Stops over the whole run (the idempotency key when no `turnKey`). */
  stops: number;
  /** Automatic continuations since an ask last LANDED with the person. */
  autoContinues: number;
  firstTurn?: RunTurnRecord;
  turns: RunTurnRecord[];
  /**
   * The last STOPPED turn's checkpoint (a stop that reports none clears it):
   * what an approved continuation (the person's yes to "Keep the run going")
   * hands the next turn, as the automatic continuation's notice does.
   */
  lastCheckpoint?: NonNullable<CompleteRunBody["checkpoint"]>;
  /**
   * The stages whose stage-end ask the pod already raised in THIS run
   * (`stage-end-ask.ts`), by stage key: each is asked once per run.
   */
  stageAsks?: string[];
}

/**
 * The ONE reader of `metadata.runTurns`. A ledger of another run (or none, or
 * a malformed one) reads as a fresh ledger for `runId` — never as this run's.
 */
export function readRunTurns(metadata: unknown, runId: string): RunTurnsState {
  const raw =
    metadata && typeof metadata === "object"
      ? (metadata as Record<string, unknown>)[RUN_TURNS_META_KEY]
      : undefined;
  const fresh: RunTurnsState = {
    runId,
    stops: 0,
    autoContinues: 0,
    turns: [],
  };
  if (!raw || typeof raw !== "object") return fresh;
  const s = raw as Partial<RunTurnsState>;
  if (s.runId !== runId) return fresh;
  const n = (v: unknown) =>
    typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : 0;
  return {
    runId,
    stops: n(s.stops),
    autoContinues: n(s.autoContinues),
    ...(s.firstTurn && typeof s.firstTurn === "object"
      ? { firstTurn: s.firstTurn }
      : {}),
    turns: Array.isArray(s.turns) ? s.turns.slice(-TURN_HISTORY_MAX) : [],
    ...(s.lastCheckpoint && typeof s.lastCheckpoint === "object"
      ? { lastCheckpoint: s.lastCheckpoint }
      : {}),
    ...(Array.isArray(s.stageAsks)
      ? {
          stageAsks: s.stageAsks.filter(
            (k): k is string => typeof k === "string"
          ),
        }
      : {}),
  };
}

/**
 * The decision rule, pure: a stop continues while fewer than N automatic
 * continuations ran since the person was last asked; every later stop asks.
 * The count resets only once an ask has landed (`resetAfterAsk`), so an ask
 * that fails is retried on the next stop — never a fresh continuation.
 */
export function nextAfterStop(
  state: Pick<RunTurnsState, "autoContinues">
): { next: "continue"; continuation: number } | { next: "ask" } {
  return state.autoContinues < MAX_AUTO_CONTINUATIONS
    ? { next: "continue", continuation: state.autoContinues + 1 }
    : { next: "ask" };
}

/**
 * Record the turn and decide, under the session row lock (two turn ends of
 * one run cannot both take the same continuation). Metadata only: no
 * `updatedAt` bump — recording a turn is not progress, and the idle flag reads
 * the session's last real activity.
 */
async function recordTurnEnd(
  sessionId: string,
  runId: string,
  body: CompleteRunBody
): Promise<{
  decision: ReturnType<typeof nextAfterStop> | null;
  state: RunTurnsState;
  /** This turn's report was already recorded (a retry): nothing written. */
  duplicate: boolean;
  /** {@link hasNoPersonInTheLoop}, read on the locked row. */
  unattended: boolean;
} | null> {
  return db.transaction(async (tx) => {
    const [locked] = await tx
      .select({
        metadata: focusSessions.metadata,
        origin: focusSessions.origin,
      })
      .from(focusSessions)
      .where(eq(focusSessions.id, sessionId))
      .for("update");
    if (!locked) return null;
    const unattended = hasNoPersonInTheLoop(locked);
    const state = readRunTurns(locked.metadata, runId);
    if (
      body.turnKey &&
      [state.firstTurn, ...state.turns].some((t) => t?.turnKey === body.turnKey)
    ) {
      return { decision: null, state, duplicate: true, unattended };
    }
    const stopped = body.outcome === "stopped";
    const decision = stopped ? nextAfterStop(state) : null;
    const record: RunTurnRecord = {
      at: new Date().toISOString(),
      outcome: body.outcome,
      ...(body.reason ? { reason: body.reason } : {}),
      ...(body.agentType ? { agentType: body.agentType } : {}),
      ...(body.turnKey ? { turnKey: body.turnKey } : {}),
      ...(body.turn?.budgetAction
        ? { budgetAction: body.turn.budgetAction }
        : {}),
      ...(body.turn
        ? {
            ceiling: body.turn.ceiling,
            spentInputTokens: body.turn.spentInputTokens,
          }
        : {}),
      ...(body.turn?.firstCall ? { firstCall: body.turn.firstCall } : {}),
      ...(body.turn?.model ? { model: body.turn.model } : {}),
      ...(body.turn?.cacheReadInputTokens !== undefined
        ? { cacheReadInputTokens: body.turn.cacheReadInputTokens }
        : {}),
      ...(body.turn?.cacheWriteInputTokens !== undefined
        ? { cacheWriteInputTokens: body.turn.cacheWriteInputTokens }
        : {}),
      ...(body.turn?.chargedInputTokens !== undefined
        ? { chargedInputTokens: body.turn.chargedInputTokens }
        : {}),
      ...(decision ? { next: decision.next } : {}),
      ...(body.checkpoint
        ? { checkpointRecords: body.checkpoint.records.length }
        : {}),
    };
    // The LAST stopped turn's checkpoint: a stop that reports none clears it
    // (an older one names records the run may have moved past).
    const lastCheckpoint = stopped ? body.checkpoint : state.lastCheckpoint;
    const next: RunTurnsState = {
      runId,
      stops: state.stops + (stopped ? 1 : 0),
      // An ask does NOT reset the count here: it resets only once the ask has
      // LANDED (`resetAfterAsk`). Resetting before it lands meant a failed ask
      // handed the run two more fresh-budget continuations, then another failed
      // ask, and so on — unbounded spend with no person in the loop.
      autoContinues:
        decision?.next === "continue"
          ? decision.continuation
          : state.autoContinues,
      firstTurn: state.firstTurn ?? record,
      turns: [...state.turns, record].slice(-TURN_HISTORY_MAX),
      ...(lastCheckpoint ? { lastCheckpoint } : {}),
      ...(state.stageAsks ? { stageAsks: state.stageAsks } : {}),
    };
    await tx
      .update(focusSessions)
      .set({ metadata: mergeSessionMetadata({ [RUN_TURNS_META_KEY]: next }) })
      .where(eq(focusSessions.id, sessionId));
    return { decision, state: next, duplicate: false, unattended };
  });
}

/**
 * The person has been asked (the slot is theirs): the next stops get fresh
 * automatic continuations again. A second locked write, made only after the
 * ask landed; a ledger that moved on to another run is left alone.
 */
async function resetAfterAsk(sessionId: string, runId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [locked] = await tx
      .select({ metadata: focusSessions.metadata })
      .from(focusSessions)
      .where(eq(focusSessions.id, sessionId))
      .for("update");
    if (!locked) return;
    const raw =
      locked.metadata && typeof locked.metadata === "object"
        ? (locked.metadata as Record<string, unknown>)[RUN_TURNS_META_KEY]
        : undefined;
    if ((raw as Partial<RunTurnsState> | undefined)?.runId !== runId) return;
    const state = readRunTurns(locked.metadata, runId);
    await tx
      .update(focusSessions)
      .set({
        metadata: mergeSessionMetadata({
          [RUN_TURNS_META_KEY]: { ...state, autoContinues: 0 },
        }),
      })
      .where(eq(focusSessions.id, sessionId));
  });
}

type RunRow = Pick<
  PlaybookRun,
  | "id"
  | "status"
  | "summary"
  | "error"
  | "completedAt"
  | "sessionId"
  | "workspaceId"
> & {
  /** The run's playbook: the continuation resolves its declared tools. */
  playbookId?: string;
};

interface SessionRoom {
  id: string;
  userId: string;
  channelId: string | null;
}

/**
 * Is nobody in this run's loop? True when an automation opened the session
 * (`origin: "automation"`, or the automation keys `openRunSession` and the
 * scheduled `playbook_run` step stamp, read by the ONE predicate
 * `startedByAutomation`), unless a person took it on from triage
 * (`triage.acceptedAt`, the same receipt `projectSessionKind` reads).
 */
export function hasNoPersonInTheLoop(row: {
  origin: string | null;
  metadata: unknown;
}): boolean {
  const triage = (row.metadata as { triage?: { acceptedAt?: unknown } } | null)
    ?.triage;
  if (triage?.acceptedAt != null) return false;
  return row.origin === "automation" || startedByAutomation(row.metadata);
}

/**
 * The end of an unattended run whose continuations are spent: `failed` with
 * the reason (the run did not finish, and nobody can be asked), then a pod
 * notice in the room. The notice is posted only once the run really ended, so
 * it never says so of a run another writer had already settled.
 */
async function endUnattendedRun(p: {
  run: RunRow;
  session: SessionRoom;
  stops: number;
  turnRef: string;
  reason: RunStopReason | undefined;
}): Promise<CompleteRunStatus> {
  const limit = stopLimitWords(p.reason);
  const why =
    `Stopped at its ${limit}: the run stopped before it was finished ${p.stops} times ` +
    `and continued on its own ${MAX_AUTO_CONTINUATIONS} times. ` +
    "An automation started it, so nobody was asked to keep it going.";
  const ended = await applyRunCapture({
    run: p.run,
    status: "failed",
    error: why,
    // Not a fault: the parent automation run and its breakers read this
    // (`automation-parent-settle.ts`), so a budget stop never turns a rule off.
    stopReason: "budget",
  });
  if (!ended) return "no-running-run";
  if (p.session.channelId) {
    try {
      await postChannelMessage({
        channelId: p.session.channelId,
        content: `${why} The run ends here; what it did so far stays in this session.`,
        userId: p.session.userId,
        role: "system",
        idempotencyKey: `run-stopped:${p.run.id}:${p.turnRef}`,
      });
    } catch (err) {
      logger.error(
        { err, runId: p.run.id, sessionId: p.session.id },
        "run-turn-end: the run ended, but its notice could not be posted"
      );
    }
  }
  return "stopped";
}

/** Why the run failed, in the words the room reads. */
function failureWords(reason: RunFailureReason): string {
  switch (reason) {
    case "read_failed":
      return "This run could not reach the pod: every read of its turn failed.";
    case "turn_error":
      return "This run's turn broke before it finished (the AI provider failed, or the turn itself did).";
    case "budget_exceeded":
      return "This run's turn could not start within its token budget.";
    case "could_not_continue":
      return "This run stopped before it was finished, and it could neither go on by itself nor ask you to keep it going.";
  }
}

/**
 * The end of a run that cannot go on (findings db27cac2, a00f5eb6, 15835191):
 * the run ends `failed` with the reason, one pod notice in the room says what
 * failed and how to retry, and the session closes `failed` through the ONE
 * close door.
 *
 * The close is automatic, so like every automatic close it never closes a
 * session that still owes the person a slot (W2 calm, `closeSessionViaDoor`):
 * the ask stays live where they will answer it. A close the door refuses or
 * proposes is logged; the hourly ended-run sweep closes the session then.
 */
async function endFailedRun(p: {
  run: RunRow;
  session: SessionRoom;
  reason: RunFailureReason;
  turnRef: string;
}): Promise<CompleteRunStatus> {
  const why = failureWords(p.reason);
  const ended = await applyRunCapture({
    run: p.run,
    status: "failed",
    error: why,
    // A budget wall is not a fault: the automation's breakers skip it (F3).
    stopReason: p.reason === "budget_exceeded" ? "budget" : undefined,
  });
  if (!ended) return "no-running-run";
  logger.info(
    { runId: p.run.id, sessionId: p.session.id, reason: p.reason },
    "run-turn-end: the run ended failed"
  );
  if (p.session.channelId) {
    try {
      await postChannelMessage({
        channelId: p.session.channelId,
        content: `${why} The run ends here as failed; what it did so far stays in this session. You can run it again from here.`,
        userId: p.session.userId,
        role: "system",
        idempotencyKey: `run-failed:${p.run.id}:${p.turnRef}`,
      });
    } catch (err) {
      logger.error(
        { err, runId: p.run.id, sessionId: p.session.id },
        "run-turn-end: the run failed, but its notice could not be posted"
      );
    }
  }
  try {
    const [owes] = await db
      .select({ id: focusSessions.id })
      .from(focusSessions)
      .where(and(eq(focusSessions.id, p.session.id), owedSlotWhere()))
      .limit(1);
    if (!owes) {
      await completeFocusSession({
        sessionId: p.session.id,
        userId: p.session.userId,
        terminalStatus: "failed",
        summary: why,
        actor: { kind: "system", userId: p.session.userId },
      });
    }
  } catch (err) {
    logger.warn(
      { err, runId: p.run.id, sessionId: p.session.id },
      "run-turn-end: closing the failed run's session failed (the hourly sweep closes it)"
    );
  }
  return "failed";
}

/**
 * The words of the continuation notice: why the run goes on, and the stopped
 * turn's checkpoint as a fenced `run-checkpoint` JSON block — the records it
 * touched by FULL id and what it said was left. The next turn reads this
 * message, not the last turn's tool results.
 */
export function continuationNotice(p: {
  continuation: number;
  reason: RunStopReason | undefined;
  checkpoint: CompleteRunBody["checkpoint"];
}): string {
  const head =
    `Automatic continuation ${p.continuation} of ${MAX_AUTO_CONTINUATIONS}: ` +
    `the last turn stopped at its ${stopLimitWords(p.reason)} before this run was finished. ` +
    "Pick up from where it stopped; do not start over.";
  if (!p.checkpoint) return head;
  return (
    `${head} Its checkpoint follows: the records it already touched, by full ` +
    "id (use these ids as they are; never search for them again), and what it " +
    "said was left.\n\n```run-checkpoint\n" +
    JSON.stringify(p.checkpoint, null, 2) +
    "\n```"
  );
}

/**
 * The checkpoint as TURN CONTEXT entries (the bounded bag the IS shows the
 * agent as reference data, never as anyone's words): the records' full ids,
 * 12 per entry, and what was left, cut to one entry. PURE. Bounded by
 * construction: at most `CHECKPOINT_MAX_RECORDS` uuids (5 entries) and one
 * 400-char string, inside `TurnContextSchema`'s 20 entries and 8,000 chars.
 */
export function checkpointTurnEntries(
  checkpoint: NonNullable<CompleteRunBody["checkpoint"]>
): TurnContextEntry[] {
  const entries: TurnContextEntry[] = [
    {
      key: "run.continue",
      value:
        "The person approved continuing this run. Pick up where the stopped " +
        "turn left off: the records it already touched are listed by full id " +
        "(use them as they are; never search for them again).",
    },
  ];
  const ids = checkpoint.records.map((r) => r.id);
  for (let i = 0; i < ids.length; i += TURN_CONTEXT_MAX_ARRAY_ITEMS) {
    entries.push({
      key: `run.checkpoint.ids.${i / TURN_CONTEXT_MAX_ARRAY_ITEMS + 1}`,
      value: ids.slice(i, i + TURN_CONTEXT_MAX_ARRAY_ITEMS),
    });
  }
  if (checkpoint.left) {
    entries.push({
      key: "run.checkpoint.left",
      value: checkpoint.left.slice(0, TURN_CONTEXT_MAX_STRING_LENGTH),
    });
    if (checkpoint.left.length > TURN_CONTEXT_MAX_STRING_LENGTH) {
      entries.push({ key: "run.checkpoint.leftTruncated", value: true });
    }
  }
  return entries;
}

/**
 * What a person's answer in a session room wakes. `none`: no live run, the
 * normal agent. `failed`: the live-run lookup failed (logged); the wake still
 * happens, with no run profile. `found`: a run turn, with the run's declared
 * tools and, for a YES to "Keep the run going", the checkpoint as turn context.
 */
export type RunTurnForAnswer =
  | { liveRun: "none" | "failed" }
  | {
      liveRun: "found";
      run: RunToolProfile;
      turnContext?: { entries: TurnContextEntry[] };
    };

/**
 * The run turn a person's answer starts in a LIVE run's room
 * (`session-answer.ts` wake): the run's declared tools, from the same resolver
 * as the kickoff and the automatic continuation, and, when the answer is YES to
 * "Keep the run going", the last stopped turn's checkpoint. The checkpoint is
 * model-written text: it travels as turn context, never inside the person's
 * message.
 */
export async function runTurnForAnswer(p: {
  sessionId: string;
  userId: string;
  slotLabel?: string | null;
  /** The answer was a confirmed YES (a `confirm` value with `confirmed: true`). */
  approved: boolean;
  /** The answer's typed value: a stage-end ask's chosen option rides on. */
  value?: SlotAnswerValue;
}): Promise<RunTurnForAnswer> {
  let live: { id: string; playbookId: string; workspaceId: string | null };
  try {
    const [row] = await db
      .select({
        id: playbookRuns.id,
        playbookId: playbookRuns.playbookId,
        workspaceId: playbookRuns.workspaceId,
      })
      .from(playbookRuns)
      .where(
        and(
          eq(playbookRuns.sessionId, p.sessionId),
          liveRunStatusWhere(playbookRuns.status)
        )
      )
      .orderBy(desc(playbookRuns.startedAt))
      .limit(1);
    if (!row) return { liveRun: "none" };
    live = row;
  } catch (err) {
    logger.error(
      { err, sessionId: p.sessionId },
      "run-turn-end: the session's live run could not be read — the answer wakes the agent with no run profile"
    );
    return { liveRun: "failed" };
  }
  const run = await resolveRunToolProfile({
    playbookId: live.playbookId,
    workspaceId: live.workspaceId ?? null,
    userId: p.userId,
    sessionId: p.sessionId,
  });
  const continues =
    p.approved &&
    normalizeExpectedLabel(p.slotLabel) ===
      normalizeExpectedLabel(RUN_CONTINUE_SLOT_LABEL);
  if (!continues) {
    // An answer to a stage-end ask the pod raised: the run goes on from the
    // next stage (`stage-end-ask.ts`). Best effort: a failed read wakes the
    // run turn without it, and says so.
    try {
      const session = await db.query.focusSessions.findFirst({
        where: eq(focusSessions.id, p.sessionId),
        columns: { metadata: true, stages: true },
      });
      const entries = await stageAskTurnEntries({
        runId: live.id,
        sessionStages: session?.stages,
        raised: readRunTurns(session?.metadata, live.id).stageAsks ?? [],
        slotLabel: p.slotLabel,
        ...(p.value ? { value: p.value } : {}),
      });
      if (entries.length > 0) {
        return { liveRun: "found", run, turnContext: { entries } };
      }
    } catch (err) {
      logger.error(
        { err, sessionId: p.sessionId, runId: live.id },
        "run-turn-end: the stage-end ask's next stage could not be read — the run turn goes on without it"
      );
      return {
        liveRun: "found",
        run,
        turnContext: {
          entries: [{ key: "run.stageAsk.read", value: "failed" }],
        },
      };
    }
    return { liveRun: "found", run };
  }
  try {
    const session = await db.query.focusSessions.findFirst({
      where: eq(focusSessions.id, p.sessionId),
      columns: { metadata: true },
    });
    const checkpoint = readRunTurns(session?.metadata, live.id).lastCheckpoint;
    return {
      liveRun: "found",
      run,
      ...(checkpoint
        ? { turnContext: { entries: checkpointTurnEntries(checkpoint) } }
        : {}),
    };
  } catch (err) {
    logger.error(
      { err, sessionId: p.sessionId, runId: live.id },
      "run-turn-end: the run's checkpoint could not be read — the run turn goes on without it, and the agent is told"
    );
    return {
      liveRun: "found",
      run,
      turnContext: {
        entries: [{ key: "run.checkpoint.read", value: "failed" }],
      },
    };
  }
}

/** The continuation: a pod notice in the room, dispatched as the next turn. */
async function continueRun(p: {
  run: RunRow;
  session: SessionRoom;
  agentType: string;
  continuation: number;
  /** The turn's id for idempotency (see `settleRunTurnEnd`). */
  turnRef: string;
  reason: RunStopReason | undefined;
  checkpoint: CompleteRunBody["checkpoint"];
}): Promise<boolean> {
  if (!p.session.channelId) return false;
  const content = continuationNotice(p);
  // The continuation is a run turn too: the same declared tools as the
  // kickoff (founder, 2026-11-05). Never throws (a failed read says so).
  const run = p.run.playbookId
    ? await resolveRunToolProfile({
        playbookId: p.run.playbookId,
        workspaceId: p.run.workspaceId ?? null,
        userId: p.session.userId,
        sessionId: p.session.id,
      })
    : undefined;
  try {
    // A POD notice (role system), not the person speaking: nobody typed this.
    const posted = await postChannelMessage({
      channelId: p.session.channelId,
      content,
      userId: p.session.userId,
      role: "system",
      idempotencyKey: `run-continue:${p.run.id}:${p.turnRef}`,
    });
    if (posted.ackState === "duplicate-ignored") return true;
    return await triggerAutoRespond({
      channelId: p.session.channelId,
      userMessageId: posted.messageId,
      content,
      sourceUserId: p.session.userId,
      focusSessionId: p.session.id,
      agentType: p.agentType,
      run,
    });
  } catch (err) {
    logger.error(
      { err, runId: p.run.id, sessionId: p.session.id },
      "run-turn-end: the automatic continuation could not be dispatched"
    );
    return false;
  }
}

/**
 * The ask: declare the decision slot (fresh — an earlier round's slot is
 * replaced, as the agent-approval card does), then hand it to the person
 * through the ONE hand-over door. With the turn's agent known, as an agent
 * QUESTION in the room (the answer then wakes that agent); without one,
 * directly through `blockExpectedOutput`. `true` iff the slot is now the
 * person's.
 */
async function askToKeepGoing(p: {
  run: RunRow;
  session: SessionRoom;
  askingAgentUserId: string | null;
  stops: number;
  turnRef: string;
  reason: RunStopReason | undefined;
}): Promise<boolean> {
  // Said once: the facts are the slot's `why`, the question is the prompt.
  // The room post carries both, as a message reads.
  const facts =
    `This run stopped before it was finished ${p.stops} times ` +
    `(the last turn hit its ${stopLimitWords(p.reason)}; ` +
    `it continued on its own ${MAX_AUTO_CONTINUATIONS} times).`;
  const prompt = "Keep it going?";
  const question = `${facts} ${prompt}`;
  const ask: SlotAsk = {
    mode: "confirm",
    prompt,
    // The answer wakes the asking agent (`session-answer.ts`): it is the one
    // that goes on or stops.
    yes: { description: "The agent picks up where it stopped" },
    no: { description: "The agent is told to stop" },
  };
  return raiseRunAsk({
    runId: p.run.id,
    session: p.session,
    askingAgentUserId: p.askingAgentUserId,
    slot: {
      kind: "decision",
      label: RUN_CONTINUE_SLOT_LABEL,
      status: "pending",
      // What the answer unblocks (decision E): the room question is refused
      // for a slot that does not say it.
      unblocks: "The run goes on",
    } satisfies ExpectedOutput,
    blockedReason: "decision",
    why: facts,
    question,
    ask,
    idempotencyKey: `run-ask:${p.run.id}:${p.turnRef}`,
  });
}

/**
 * The turn's `firstCall.guidance`, filled by the POD from what the run
 * stamped on its definition snapshot (`recordRunGuidance`): the refs of the
 * rules it used. The IS never has to report them, and the pod's stamp wins
 * over anything it sent. Best effort: an unreadable or absent stamp leaves
 * the body as it came, never failing the turn's report.
 */
async function withStampedGuidance(
  runId: string,
  body: CompleteRunBody
): Promise<CompleteRunBody> {
  const firstCall = body.turn?.firstCall;
  if (!body.turn || !firstCall) return body;
  try {
    const [row] = await db
      .select({ snapshot: playbookRuns.definitionSnapshot })
      .from(playbookRuns)
      .where(eq(playbookRuns.id, runId))
      .limit(1);
    const stamp = stampedGuidanceOf(row?.snapshot);
    if (stamp?.status !== "ok" || stamp.used.length === 0) return body;
    const refs = stamp.used
      .map((u) => (typeof u.ref === "string" ? u.ref.slice(0, 160) : ""))
      .filter(Boolean)
      .slice(0, FIRST_CALL_GUIDANCE_MAX);
    if (refs.length === 0) return body;
    return {
      ...body,
      turn: { ...body.turn, firstCall: { ...firstCall, guidance: refs } },
    };
  } catch (err) {
    logger.warn(
      { err, runId },
      "run-turn-end: reading the run's guidance stamp failed (non-fatal)"
    );
    return body;
  }
}

/**
 * A run with no stages whose turn completed is done: close its session now,
 * through the ONE close door, unless something in it waits on the person
 * (`closeStagelessRunSessionAtTurnEnd`, founder 9 Nov 2026). Best effort: the
 * run is already completed and the hourly sweep closes the session anyway, so
 * a failed close is logged, never a failed turn report.
 */
async function closeOneTurnRun(sessionId: string): Promise<void> {
  try {
    await closeStagelessRunSessionAtTurnEnd(sessionId);
  } catch (err) {
    logger.warn(
      { err, sessionId },
      "run-turn-end: closing the one-turn run's session failed (the hourly sweep retries)"
    );
  }
}

/** Settle one IS turn's end on the session's live run. */
export async function settleRunTurnEnd(p: {
  run: RunRow;
  session: SessionRoom;
  body: CompleteRunBody;
  /** The agent from the request's VERIFIED auth context, if any. */
  askingAgentUserId: string | null;
}): Promise<CompleteRunStatus> {
  const { run, session } = p;
  const body = await withStampedGuidance(run.id, p.body);
  const recorded = await recordTurnEnd(session.id, run.id, body);

  // Completing is idempotent (only a LIVE run completes), so a retried
  // `completed` report still settles a run its first attempt failed to.
  if (body.outcome === "completed") {
    // A retried report of a turn whose end already parked the run on the
    // person (a stage-end ask) never completes it under them.
    if (recorded?.duplicate && run.status === "waiting_on_you") {
      return "duplicate";
    }
    // A staged run whose stage declares an ask: the POD raises it and the
    // run waits for the answer instead of completing (`stage-end-ask.ts`).
    const staged = await settleStageEndAsk({
      run,
      session,
      askingAgentUserId: p.askingAgentUserId,
      raised: recorded?.state.stageAsks ?? [],
    });
    if (staged === "waiting_on_you") return "waiting_on_you";
    if (staged === "left_running") {
      if (run.status !== "running") {
        await applyRunCapture({ run, status: "running" });
      }
      return "left_running";
    }
    const updated = await applyRunCapture({ run, status: "completed" });
    if (!updated) return "no-running-run";
    await closeOneTurnRun(session.id);
    return "completed";
  }

  // Failing is idempotent like completing (only a LIVE run fails, and the
  // notice is keyed by the turn), so a retried report settles what its first
  // attempt could not.
  if (body.outcome === "failed") {
    return endFailedRun({
      run,
      session,
      reason: isRunTurnFailureReason(body.reason) ? body.reason : "turn_error",
      turnRef: body.turnKey ?? String(recorded?.state.turns.length ?? 0),
    });
  }

  // Stopped (budget or step limit): the run stays LIVE whatever happens
  // below — even when the turn could not be recorded (row gone mid-call).
  if (recorded?.duplicate) return "duplicate";
  if (!recorded?.decision) return "left_running";
  const { decision, state, unattended } = recorded;
  const reason = isRunStopReason(body.reason) ? body.reason : undefined;
  // Idempotency for the room posts: the IS's turn id, else (an older IS) the
  // stop count — which a retried report re-increments, so only `turnKey`
  // makes a retry recognisable.
  const turnRef = body.turnKey ?? String(state.stops);
  if (decision.next === "continue") {
    if (run.status !== "running") {
      await applyRunCapture({ run, status: "running" });
    }
    const continued = await continueRun({
      run,
      session,
      agentType: body.agentType ?? "meta",
      continuation: decision.continuation,
      turnRef,
      reason,
      checkpoint: body.checkpoint,
    });
    if (continued) return "continued";
    // No person to ask: a continuation that could not be dispatched ends the
    // run now, instead of leaving it live for the reaper.
    if (unattended) {
      return endFailedRun({
        run,
        session,
        reason: "could_not_continue",
        turnRef,
      });
    }
  }
  if (unattended) {
    return endUnattendedRun({
      run,
      session,
      stops: state.stops,
      turnRef,
      reason,
    });
  }

  const asked = await askToKeepGoing({
    run,
    session,
    askingAgentUserId: p.askingAgentUserId,
    stops: state.stops,
    turnRef,
    reason,
  });
  if (asked) {
    await resetAfterAsk(session.id, run.id);
    const parked = await applyRunCapture({ run, status: "waiting_on_you" });
    if (parked) return "waiting_on_you";
  }
  // Neither continued nor asked: nothing will move this run again, so it
  // ends now instead of waiting for the reaper.
  return endFailedRun({ run, session, reason: "could_not_continue", turnRef });
}
