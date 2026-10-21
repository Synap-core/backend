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
 * NOW the IS says how the turn ended (`outcome`). `completed` is unchanged. A
 * `stopped` + `turn_budget` turn leaves the run LIVE and:
 *   1. continues on its own with a fresh budget — a pod notice in the room,
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
 * If neither lands, the run is simply left `running`: the stall flag and the
 * reaper see it — never a false `completed` — and the count is NOT reset, so
 * the next stop asks again instead of continuing on its own.
 *
 * WHAT IS RECORDED (`focus_sessions.metadata.runTurns`, server-owned): each
 * turn's end as the IS measured it — the budget ceiling, the input tokens
 * spent, and the FIRST provider call's size by part (system prompt, tools,
 * history, message). `firstTurn` keeps the run's first turn (the 11-second
 * stop's cause); `turns` the last {@link TURN_HISTORY_MAX}. Keyed by run id: a
 * later run on the same session starts from zero.
 *
 * Caller-gated: the route has already authorized the caller on the session
 * row (`resolveRowActingContext`). No new status: the run statuses are
 * `PlaybookRunStatus`, written through `applyRunCapture`.
 */

import { z } from "zod";
import { db, eq, focusSessions } from "@synap/database";
import type { PlaybookRun } from "@synap/database/schema";
import type { ExpectedOutput, SlotAsk } from "@synap/playbooks";
import { createLogger } from "@synap-core/core";
import { applyRunCapture } from "./apply-run-capture.js";
import { postChannelMessage } from "../messaging/post-message.js";
import { triggerAutoRespond } from "../../utils/trigger-auto-respond.js";
import {
  mergeSessionMetadata,
  RUN_TURNS_META_KEY,
} from "../focus-sessions/session-metadata.js";
import { normalizeExpectedLabel } from "../focus-sessions/expected-label.js";
import { updateExpectedOutputsLocked } from "../focus-sessions/delegate-output.js";
import { blockExpectedOutput } from "../focus-sessions/block-output.js";

const logger = createLogger({ module: "run-turn-end" });

/** Founder decision B8 (2026-10-21): N = 2 automatic continuations, then ask. */
export const MAX_AUTO_CONTINUATIONS = 2;

export { RUN_TURNS_META_KEY };

/** How many recent turn records are kept (the first turn is kept apart). */
export const TURN_HISTORY_MAX = 10;

/** The slot the person is asked on, once the continuations are spent. */
export const RUN_CONTINUE_SLOT_LABEL = "Keep the run going";

const count = z.number().int().nonnegative();

/**
 * The complete-run body. Every field optional: an IS that predates it sends
 * nothing, which means `completed` — exactly the old behaviour. MIRRORED by
 * the IS (`CompleteRunReport`, synap-intelligence-service
 * `clients/is-hub-client.ts`); this schema is the authority.
 */
export const completeRunBodySchema = z
  .object({
    outcome: z.enum(["completed", "stopped"]).default("completed"),
    reason: z.literal("turn_budget").optional(),
    /**
     * The agent type that ran the turn — the continuation wakes the same one.
     * A FREE string (root CLAUDE.md "agentType = free string"), so no pattern;
     * and lenient: a value this door cannot use reads as absent (the default
     * agent) instead of refusing the whole report. A 400 here would drop the
     * turn's outcome and leave a finished run `running` for the 24-h reaper.
     */
    agentType: z.string().trim().min(1).max(200).optional().catch(undefined),
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
          })
          .optional(),
      })
      .optional(),
  })
  .refine((b) => b.outcome !== "stopped" || b.reason === "turn_budget", {
    message: "outcome 'stopped' needs a reason ('turn_budget')",
    path: ["reason"],
  });

export type CompleteRunBody = z.infer<typeof completeRunBodySchema>;

/** What complete-run did with the run (the response `status`). */
export type CompleteRunStatus =
  | "completed"
  | "no-running-run"
  | "continued"
  | "waiting_on_you"
  | "left_running";

/** One turn's end, as stored. */
export interface RunTurnRecord {
  at: string;
  outcome: "completed" | "stopped";
  reason?: "turn_budget";
  agentType?: string;
  budgetAction?: "final" | "stop";
  ceiling?: number;
  spentInputTokens?: number;
  firstCall?: NonNullable<CompleteRunBody["turn"]>["firstCall"];
  /** What the pod decided for a stopped turn. */
  next?: "continue" | "ask";
}

/** `metadata.runTurns` — one run's turn ledger. */
export interface RunTurnsState {
  runId: string;
  /** Budget stops over the whole run (the continuation idempotency key). */
  stops: number;
  /** Automatic continuations since an ask last LANDED with the person. */
  autoContinues: number;
  firstTurn?: RunTurnRecord;
  turns: RunTurnRecord[];
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
} | null> {
  return db.transaction(async (tx) => {
    const [locked] = await tx
      .select({ metadata: focusSessions.metadata })
      .from(focusSessions)
      .where(eq(focusSessions.id, sessionId))
      .for("update");
    if (!locked) return null;
    const state = readRunTurns(locked.metadata, runId);
    const stopped = body.outcome === "stopped";
    const decision = stopped ? nextAfterStop(state) : null;
    const record: RunTurnRecord = {
      at: new Date().toISOString(),
      outcome: body.outcome,
      ...(body.reason ? { reason: body.reason } : {}),
      ...(body.agentType ? { agentType: body.agentType } : {}),
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
      ...(decision ? { next: decision.next } : {}),
    };
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
    };
    await tx
      .update(focusSessions)
      .set({ metadata: mergeSessionMetadata({ [RUN_TURNS_META_KEY]: next }) })
      .where(eq(focusSessions.id, sessionId));
    return { decision, state: next };
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
>;

interface SessionRoom {
  id: string;
  userId: string;
  channelId: string | null;
}

/** The continuation: a pod notice in the room, dispatched as the next turn. */
async function continueRun(p: {
  run: RunRow;
  session: SessionRoom;
  agentType: string;
  continuation: number;
  stops: number;
}): Promise<boolean> {
  if (!p.session.channelId) return false;
  const content =
    `Automatic continuation ${p.continuation} of ${MAX_AUTO_CONTINUATIONS}: ` +
    "the last turn stopped at its token budget before this run was finished. " +
    "Pick up from where it stopped; do not start over.";
  try {
    // A POD notice (role system), not the person speaking: nobody typed this.
    const posted = await postChannelMessage({
      channelId: p.session.channelId,
      content,
      userId: p.session.userId,
      role: "system",
      idempotencyKey: `run-continue:${p.run.id}:${p.stops}`,
    });
    if (posted.ackState === "duplicate-ignored") return true;
    return await triggerAutoRespond({
      channelId: p.session.channelId,
      userMessageId: posted.messageId,
      content,
      sourceUserId: p.session.userId,
      focusSessionId: p.session.id,
      agentType: p.agentType,
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
}): Promise<boolean> {
  const question =
    `This run stopped at its token budget ${p.stops} times ` +
    `(it continued on its own ${MAX_AUTO_CONTINUATIONS} times). Keep it going?`;
  const ask: SlotAsk = { mode: "confirm", prompt: question };
  const wanted = normalizeExpectedLabel(RUN_CONTINUE_SLOT_LABEL);
  try {
    const declared = await updateExpectedOutputsLocked(
      p.session.id,
      (current) => [
        ...current.filter((o) => normalizeExpectedLabel(o?.label) !== wanted),
        {
          kind: "decision",
          label: RUN_CONTINUE_SLOT_LABEL,
          status: "pending",
        } satisfies ExpectedOutput,
      ]
    );
    if (!declared) return false;

    if (p.askingAgentUserId && p.session.channelId) {
      const posted = await postChannelMessage({
        channelId: p.session.channelId,
        content: question,
        userId: p.session.userId,
        role: "assistant",
        agentUserId: p.askingAgentUserId,
        kind: "question",
        slotLabel: RUN_CONTINUE_SLOT_LABEL,
        ask,
        idempotencyKey: `run-ask:${p.run.id}:${p.stops}`,
      });
      if (posted.slot?.status === "blocked") return true;
      logger.warn(
        { runId: p.run.id, slot: posted.slot?.status ?? null },
        "run-turn-end: the question did not file on the slot; handing it over directly"
      );
    }
    const blocked = await blockExpectedOutput({
      sessionId: p.session.id,
      userId: p.session.userId,
      expectedLabel: RUN_CONTINUE_SLOT_LABEL,
      blockedReason: "decision",
      why: question,
      ask,
      agentUserId: p.askingAgentUserId,
    });
    return blocked.status === "blocked";
  } catch (err) {
    logger.error(
      { err, runId: p.run.id, sessionId: p.session.id },
      "run-turn-end: could not ask the person whether to keep the run going"
    );
    return false;
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
  const { run, session, body } = p;
  const recorded = await recordTurnEnd(session.id, run.id, body);

  if (body.outcome === "completed") {
    const updated = await applyRunCapture({ run, status: "completed" });
    return updated ? "completed" : "no-running-run";
  }

  // Stopped on its budget: the run stays LIVE whatever happens below — even
  // when the turn could not be recorded (session row gone mid-call).
  if (!recorded?.decision) return "left_running";
  const { decision, state } = recorded;
  if (decision.next === "continue") {
    if (run.status !== "running") {
      await applyRunCapture({ run, status: "running" });
    }
    const continued = await continueRun({
      run,
      session,
      agentType: body.agentType ?? "meta",
      continuation: decision.continuation,
      stops: state.stops,
    });
    if (continued) return "continued";
  }

  const asked = await askToKeepGoing({
    run,
    session,
    askingAgentUserId: p.askingAgentUserId,
    stops: state.stops,
  });
  if (asked) {
    await resetAfterAsk(session.id, run.id);
    const parked = await applyRunCapture({ run, status: "waiting_on_you" });
    if (parked) return "waiting_on_you";
  }
  if (run.status !== "running") {
    await applyRunCapture({ run, status: "running" });
  }
  return "left_running";
}
