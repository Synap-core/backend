/**
 * What a playbook run SPENT, summed over its turns (plan fbfadf54 5c): how many
 * turns, the input tokens they read fresh and in all, the cache reads, and the
 * models that served them. Kept as a running total on the run's turn ledger
 * (`metadata.runTurns.cost`, written with each turn in `run-turn-end.ts`), so it
 * stays whole after the ledger keeps only its last turns.
 *
 * ONE derivation, read by every session door that shows it: the session usage
 * read (the desktop session page) and the lean session read (agents).
 */
import { RUN_TURNS_META_KEY } from "../focus-sessions/session-metadata.js";

/** At most this many distinct model ids are kept. */
export const RUN_COST_MODELS_MAX = 10;

export interface RunCost {
  /** Turns the run reported. */
  turns: number;
  /**
   * Input tokens read fresh: each turn's input minus the cache reads the
   * provider reported (a turn whose cache reads were not reported counts in
   * full: unknown never reads as free).
   */
  freshInputTokens: number;
  /** Every input token, cache reads included. */
  rawInputTokens: number;
  /** Input tokens read from the prompt cache. */
  cacheReadInputTokens: number;
  /** The models that served the turns, first seen first. */
  models: string[];
  /** Turns that reported no token counts: their tokens are not in the sums. */
  unmeasuredTurns?: number;
  /**
   * Summed from a ledger written before the running total existed, which had
   * already dropped some turns: the sums may miss them.
   */
  partial?: true;
}

/** The token fields of one stored turn (`RunTurnRecord`). */
export interface RunCostTurn {
  spentInputTokens?: number;
  cacheReadInputTokens?: number;
  model?: string;
}

const EMPTY: RunCost = {
  turns: 0,
  freshInputTokens: 0,
  rawInputTokens: 0,
  cacheReadInputTokens: 0,
  models: [],
};

const count = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;

/** The total with one more turn added. PURE. */
export function addTurnToCost(
  cost: RunCost | undefined,
  turn: RunCostTurn
): RunCost {
  const base = cost ?? EMPTY;
  const raw = count(turn.spentInputTokens);
  const cacheRead = count(turn.cacheReadInputTokens) ?? 0;
  const model = typeof turn.model === "string" ? turn.model : undefined;
  const models =
    model &&
    !base.models.includes(model) &&
    base.models.length < RUN_COST_MODELS_MAX
      ? [...base.models, model]
      : base.models;
  const unmeasured = (base.unmeasuredTurns ?? 0) + (raw === undefined ? 1 : 0);
  return {
    turns: base.turns + 1,
    freshInputTokens:
      base.freshInputTokens +
      (raw === undefined ? 0 : Math.max(0, raw - cacheRead)),
    rawInputTokens: base.rawInputTokens + (raw ?? 0),
    cacheReadInputTokens:
      base.cacheReadInputTokens + (raw === undefined ? 0 : cacheRead),
    models,
    ...(unmeasured > 0 ? { unmeasuredTurns: unmeasured } : {}),
    ...(base.partial ? { partial: true as const } : {}),
  };
}

/** A stored running total, or undefined when it is not one. */
export function parseRunCost(raw: unknown): RunCost | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const c = raw as Record<string, unknown>;
  const turns = count(c.turns);
  const fresh = count(c.freshInputTokens);
  const rawTokens = count(c.rawInputTokens);
  const cacheRead = count(c.cacheReadInputTokens);
  if (
    turns === undefined ||
    fresh === undefined ||
    rawTokens === undefined ||
    cacheRead === undefined ||
    !Array.isArray(c.models)
  ) {
    return undefined;
  }
  const unmeasured = count(c.unmeasuredTurns);
  return {
    turns,
    freshInputTokens: fresh,
    rawInputTokens: rawTokens,
    cacheReadInputTokens: cacheRead,
    models: c.models
      .filter((m): m is string => typeof m === "string")
      .slice(0, RUN_COST_MODELS_MAX),
    ...(unmeasured ? { unmeasuredTurns: unmeasured } : {}),
    ...(c.partial === true ? { partial: true as const } : {}),
  };
}

/**
 * The cost of the run whose ledger the session's metadata holds; null = the
 * session holds no run ledger (no run turn ever reported).
 */
export function readRunCost(metadata: unknown): RunCost | null {
  return ledgerCost(
    metadata && typeof metadata === "object"
      ? (metadata as Record<string, unknown>)[RUN_TURNS_META_KEY]
      : undefined
  );
}

/**
 * The cost a run ledger (`RunTurnsState`) holds: its running total, or, on a
 * ledger written before the total existed, the sum of the turns it kept.
 * null = no ledger, or one with no turn.
 */
export function ledgerCost(ledger: unknown): RunCost | null {
  if (!ledger || typeof ledger !== "object") return null;
  const l = ledger as {
    cost?: unknown;
    firstTurn?: unknown;
    turns?: unknown;
  };
  const stored = parseRunCost(l.cost);
  if (stored) return stored;
  const turns = (Array.isArray(l.turns) ? l.turns : []).filter(
    (t): t is RunCostTurn & { at?: unknown } => !!t && typeof t === "object"
  );
  const first =
    l.firstTurn && typeof l.firstTurn === "object"
      ? (l.firstTurn as RunCostTurn & { at?: unknown })
      : undefined;
  // The ledger keeps the first turn and the last few: a first turn missing
  // from the kept window means turns after it may have been dropped.
  const firstDropped =
    first !== undefined && !turns.some((t) => t.at === first.at);
  const all = firstDropped && first ? [first, ...turns] : turns;
  if (all.length === 0) return null;
  const summed = all.reduce<RunCost | undefined>(addTurnToCost, undefined)!;
  return firstDropped ? { ...summed, partial: true } : summed;
}
