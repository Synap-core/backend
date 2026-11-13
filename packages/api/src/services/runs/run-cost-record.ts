/**
 * WHY A RUN COST WHAT IT COST (plan 08e4fba7 §3.5, slice 7): one record per
 * agent run, read by `runs.get` (tRPC `runs.get`, Hub `GET /runs/:id`) for the
 * browser's "What the agent got" fold.
 *
 * It is built only from what the pod already RECORDS, in two places:
 *   - the run's turn ledger (`focus_sessions.metadata.runTurns`, written by
 *     complete-run, read through the ONE reader `readRunTurns`): per turn, how
 *     it ended, the model of its LAST provider call, the input tokens, cache
 *     reads and writes, what counted against the ceiling; the first call's
 *     size by part, its prompt sections, tool names and guidance refs; and the
 *     running total (`ledgerCost`). The ledger keeps the first turn and the
 *     last {@link TURN_HISTORY_MAX}; the total covers every turn.
 *   - the agent-run telemetry the IS posts at each turn's end
 *     (`agentRun.create.completed` events, POST /agent-runs): output tokens and
 *     real cost in USD. Keyed by the SESSION (`data.sessionId`), not the run,
 *     so a run's events are those of its session from its start to the start
 *     of the session's next run.
 *
 * What is NOT recorded stays absent, never a 0: the model of each provider
 * call inside a turn (only the turn's last one is kept), the cost of a turn
 * whose provider gave no price, the output tokens of a turn that reported
 * none. A ONE-SHOT run (`executor: "generate"`) has no session: its record is
 * the run row's `generation` (prompt text, context reads, model, tokens, cost),
 * which `runs.get` already returns; this record is for runs that have turns.
 */

import { and, db, drizzleSql, eq, events, gte, lt } from "@synap/database";
import { readRunTurns, type RunTurnRecord } from "./run-turn-end.js";
import { ledgerCost, type RunCost } from "./run-cost.js";
import { RUN_TURNS_META_KEY } from "../focus-sessions/session-metadata.js";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "run-cost-record" });

/** The agent-run telemetry event type (POST /agent-runs). */
export const AGENT_RUN_EVENT_TYPE = "agentRun.create.completed";

/** At most this many telemetry rows are listed; the sums cover every one. */
export const RUN_SPEND_TURNS_CAP = 50;

/** One turn's end, as the ledger kept it. `null` = not recorded. */
export interface RunCostTurn {
  at: string | null;
  outcome: "completed" | "stopped" | "failed" | null;
  /** Why a stopped turn stopped, or why a failed one failed. */
  reason: string | null;
  agentType: string | null;
  /** The model of the turn's LAST provider call (no per-call model is kept). */
  model: string | null;
  /** Every input token of the turn, cache reads included. */
  inputTokens: number | null;
  /** What counted against `ceiling` (cache reads at their real price). */
  chargedInputTokens: number | null;
  cacheReadInputTokens: number | null;
  cacheWriteInputTokens: number | null;
  /** The turn's input budget. */
  ceiling: number | null;
  /** What the pod did after a stopped turn (`continue` | `ask`). */
  next: string | null;
}

/** What the run's FIRST provider call was made of. */
export interface RunCostFirstCall {
  promptTokens: number;
  /** The provider reported `promptTokens` (else it is the IS's estimate). */
  reported: boolean;
  toolCount: number;
  /** Each part's size; `null` = that part's size was not recorded. */
  chars: {
    system: number | null;
    tools: number | null;
    history: number | null;
    message: number | null;
  };
  /** The system prompt's sections by name and size; `null` = not recorded. */
  sections: { name: string; chars: number }[] | null;
  /** The tool names offered; `null` = not recorded. */
  tools: string[] | null;
  /** The guidance refs the prompt carried; `null` = not recorded. */
  guidance: string[] | null;
}

/** One agent-run telemetry row: what one turn produced and cost. */
export interface RunSpendTurn {
  at: string;
  agentType: string | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  /** Real cost in USD; `null` = the provider gave no price. */
  costUsd: number | null;
  finishReason: string | null;
  toolCount: number | null;
}

/** Output tokens and real cost, from the agent-run telemetry. */
export type RunSpend =
  /** No telemetry row in the run's window: nothing reported, not "free". */
  | { status: "none" }
  /** The telemetry read failed: unknown, never shown as none. */
  | { status: "unreadable" }
  | {
      status: "ok";
      /** Turns that reported telemetry. */
      turns: number;
      /** Summed over the turns that reported a price; `null` = none did. */
      costUsd: number | null;
      /** Turns with no price: when > 0, `costUsd` is a floor. */
      uncostedTurns: number;
      /** Summed over the turns that reported them; `null` = none did. */
      outputTokens: number | null;
      /** Turns that reported no output tokens. */
      unmeasuredOutputTurns: number;
      /** Newest first, at most {@link RUN_SPEND_TURNS_CAP}. */
      items: RunSpendTurn[];
    };

/** An agent run's cost record (`playbookDetail.cost`). */
export interface RunCostRecord {
  runId: string;
  /** Why a failed run stopped when it is not a fault (`playbook_runs.stop_reason`). */
  stopReason: string | null;
  /**
   * The input side over EVERY turn (`ledgerCost`): turns, fresh and raw input
   * tokens, cache reads, models. `null` = the run reported no turn.
   */
  total: RunCost | null;
  /** The turns the ledger kept, oldest first (the first turn and the last ones). */
  turns: RunCostTurn[];
  /** Turns the run had that the ledger no longer keeps (`total.turns - turns.length`). */
  turnsNotKept: number;
  /** The first call's inventory; `null` = not recorded (an older run, or none). */
  firstCall: RunCostFirstCall | null;
  spend: RunSpend;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const count = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
const text = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v : null;

function turnOf(t: RunTurnRecord): RunCostTurn {
  return {
    at: text(t.at),
    outcome:
      t.outcome === "completed" ||
      t.outcome === "stopped" ||
      t.outcome === "failed"
        ? t.outcome
        : null,
    reason: text(t.reason),
    agentType: text(t.agentType),
    model: text(t.model),
    inputTokens: count(t.spentInputTokens),
    chargedInputTokens: count(t.chargedInputTokens),
    cacheReadInputTokens: count(t.cacheReadInputTokens),
    cacheWriteInputTokens: count(t.cacheWriteInputTokens),
    ceiling: count(t.ceiling),
    next: text(t.next),
  };
}

function firstCallOf(t: RunTurnRecord | undefined): RunCostFirstCall | null {
  const f: unknown = t?.firstCall;
  if (!isRecord(f)) return null;
  const promptTokens = count(f.promptTokens);
  const toolCount = count(f.toolCount);
  const chars = isRecord(f.chars) ? f.chars : null;
  if (promptTokens === null || toolCount === null || !chars) return null;
  const sections = Array.isArray(f.sections)
    ? f.sections.flatMap((s) => {
        const name = isRecord(s) ? text(s.name) : null;
        const n = isRecord(s) ? count(s.chars) : null;
        return name !== null && n !== null ? [{ name, chars: n }] : [];
      })
    : null;
  const names = (v: unknown): string[] | null =>
    Array.isArray(v) ? v.flatMap((x) => text(x) ?? []) : null;
  return {
    promptTokens,
    reported: f.reported === true,
    toolCount,
    chars: {
      system: count(chars.system),
      tools: count(chars.tools),
      history: count(chars.history),
      message: count(chars.message),
    },
    sections,
    tools: names(f.tools),
    guidance: names(f.guidance),
  };
}

/**
 * The ledger half of the record, PURE: what the session's turn ledger holds
 * for `runId`. A ledger of another run (an earlier run on the same session)
 * reads as none, through `readRunTurns`, never as this run's.
 */
export function ledgerRecordOf(
  metadata: unknown,
  runId: string
): Pick<RunCostRecord, "total" | "turns" | "turnsNotKept" | "firstCall"> {
  const state = readRunTurns(metadata, runId);
  const raw = isRecord(metadata) ? metadata[RUN_TURNS_META_KEY] : undefined;
  const total = isRecord(raw) && raw.runId === runId ? ledgerCost(raw) : null;
  const first = state.firstTurn;
  const firstKept =
    !first ||
    state.turns.some((t) => t.at === first.at && t.turnKey === first.turnKey);
  const kept = first && !firstKept ? [first, ...state.turns] : state.turns;
  const turns = kept.map(turnOf);
  return {
    total,
    turns,
    turnsNotKept: total ? Math.max(0, total.turns - turns.length) : 0,
    firstCall: firstCallOf(first ?? state.turns[0]),
  };
}

/** A numeric column (postgres returns `numeric` as a string). */
const num = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * The telemetry half: the agent-run events of `sessionId` in
 * `[from, until)`. The caller has already authorized the run (its session is
 * readable to the viewer); the events are the session's own.
 */
export async function readRunSpend(input: {
  sessionId: string;
  from: Date;
  until: Date | null;
}): Promise<RunSpend> {
  const where = and(
    eq(events.type, AGENT_RUN_EVENT_TYPE),
    drizzleSql`${events.data}->>'sessionId' = ${input.sessionId}`,
    gte(events.timestamp, input.from),
    input.until ? lt(events.timestamp, input.until) : undefined
  );
  try {
    const [sums] = await db
      .select({
        turns: drizzleSql<number>`count(*)::int`,
        costUsd: drizzleSql<string | null>`sum(${events.costUsd})`,
        costed: drizzleSql<number>`count(${events.costUsd})::int`,
        outputTokens: drizzleSql<string | null>`sum(${events.tokensOut})`,
        measuredOutput: drizzleSql<number>`count(${events.tokensOut})::int`,
      })
      .from(events)
      .where(where);
    const turns = Number(sums?.turns ?? 0);
    if (turns === 0) return { status: "none" };
    const rows = await db
      .select({
        at: events.timestamp,
        agentType: events.agentType,
        model: events.model,
        tokensIn: events.tokensIn,
        tokensOut: events.tokensOut,
        costUsd: events.costUsd,
        finishReason: events.finishReason,
        toolCount: events.toolCount,
      })
      .from(events)
      .where(where)
      .orderBy(drizzleSql`${events.timestamp} desc`)
      .limit(RUN_SPEND_TURNS_CAP);
    const costed = Number(sums?.costed ?? 0);
    const measuredOutput = Number(sums?.measuredOutput ?? 0);
    return {
      status: "ok",
      turns,
      costUsd: costed > 0 ? num(sums?.costUsd) : null,
      uncostedTurns: turns - costed,
      outputTokens: measuredOutput > 0 ? num(sums?.outputTokens) : null,
      unmeasuredOutputTurns: turns - measuredOutput,
      items: rows.map((r) => ({
        at: new Date(r.at).toISOString(),
        agentType: r.agentType ?? null,
        model: r.model ?? null,
        inputTokens: r.tokensIn ?? null,
        outputTokens: r.tokensOut ?? null,
        costUsd: num(r.costUsd),
        finishReason: r.finishReason ?? null,
        toolCount: r.toolCount ?? null,
      })),
    };
  } catch (err) {
    logger.warn(
      { err, sessionId: input.sessionId },
      "run-cost-record: reading the run's agent-run telemetry failed"
    );
    return { status: "unreadable" };
  }
}

/** The whole record of an agent run whose session the viewer may read. */
export async function loadRunCostRecord(input: {
  runId: string;
  sessionId: string;
  metadata: unknown;
  startedAt: Date;
  /** When the session's NEXT run started (its events are that run's). */
  nextRunStartedAt: Date | null;
  stopReason: string | null;
}): Promise<RunCostRecord> {
  const spend = await readRunSpend({
    sessionId: input.sessionId,
    from: input.startedAt,
    until: input.nextRunStartedAt,
  });
  return {
    runId: input.runId,
    stopReason: input.stopReason,
    ...ledgerRecordOf(input.metadata, input.runId),
    spend,
  };
}
