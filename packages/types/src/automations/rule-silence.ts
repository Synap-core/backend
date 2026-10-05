/**
 * "SILENT TOO LONG" — a rule that normally fires, and has not, for far longer
 * than it usually waits between runs. Derived from the rule's own run history;
 * no configuration, no new column.
 *
 * WHY. A rule that breaks LOUDLY is caught by the breakers (`status = error`
 * ⇒ `automation.broken`). A rule whose SOURCE stopped — the Gmail connector
 * expired, the cron was edited away, the event stopped being produced — never
 * runs, so it never fails, and nothing anywhere says so. The only evidence is
 * the gap itself.
 *
 * THE RULE. With at least {@link SILENCE_MIN_RUNS} runs on record, the usual
 * interval is the MEDIAN gap between consecutive runs (robust to one burst or
 * one long weekend). The rule is silent when the time since its newest run is
 * more than {@link SILENCE_FACTOR}× that interval AND more than
 * {@link SILENCE_FLOOR_MS} — a rule that fires every two minutes is not
 * "silent" after seven. Only an ACTIVE rule can be silent: a paused or draft
 * one is quiet on purpose.
 *
 * Pure + zero-dep — safe in browser, relay, Node.
 */

/** Runs needed before a rhythm is trusted (≥ this many gaps − 1). */
export const SILENCE_MIN_RUNS = 5;
/** How many usual intervals of quiet make a rule "silent too long". */
export const SILENCE_FACTOR = 3;
/** Never call a rule silent before this much quiet, whatever its rhythm. */
export const SILENCE_FLOOR_MS = 60 * 60 * 1000;

export interface RuleSilence {
  /** The rule is silent too long. */
  silent: boolean;
  /** The median gap between runs, or null when there is not enough history. */
  usualIntervalMs: number | null;
  /** Time since the newest run, or null when it never ran. */
  quietForMs: number | null;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

export function ruleSilence(input: {
  /** The rule's lifecycle status (`automations.status`). */
  status: string | null | undefined;
  /** Start instants of its recent runs, any order. */
  runStartedAt: ReadonlyArray<Date | string>;
  now: Date;
}): RuleSilence {
  const times = input.runStartedAt
    .map((t) => (t instanceof Date ? t.getTime() : Date.parse(t)))
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => b - a);
  const newest = times[0];
  const quietForMs = newest === undefined ? null : input.now.getTime() - newest;
  if (times.length < SILENCE_MIN_RUNS) {
    return { silent: false, usualIntervalMs: null, quietForMs };
  }
  const gaps: number[] = [];
  for (let i = 0; i < times.length - 1; i += 1) {
    gaps.push(times[i]! - times[i + 1]!);
  }
  const usualIntervalMs = median(gaps);
  const silent =
    input.status === "active" &&
    quietForMs !== null &&
    usualIntervalMs > 0 &&
    quietForMs > SILENCE_FACTOR * usualIntervalMs &&
    quietForMs > SILENCE_FLOOR_MS;
  return { silent, usualIntervalMs, quietForMs };
}
