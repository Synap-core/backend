/**
 * THE time window of a recall (`synap_ask` `since` / `until`, ticket a9888512).
 *
 * Recency used to be a nudge inside the ranker only (`temporal-signal.ts`, a
 * 7-day half-life, "never a partition"), applied AFTER the candidate pool was
 * drawn by words and meaning. So "what did my routines find this week" missed
 * every report of the week whose words matched weakly: it never entered the
 * pool, and the nudge cannot rank what is not there. A window is a FILTER on
 * the candidate fetch instead (both recall halves and the structured lane, on
 * `entities.updated_at`), so the pool is drawn from inside it, and the reply
 * echoes the window it applied, so "nothing in the window" reads differently
 * from "the ranker missed it".
 *
 * Only the entity lanes have it (`appliesTo`): runbooks, remembered facts, the
 * Library and the catalog are read as before.
 */
import { and, gte, lt, type Column, type SQL } from "@synap/database";

/** `[since, until)` — either end may be open. */
export interface RecallWindow {
  since?: Date;
  until?: Date;
}

/** What the reply says it applied. */
export interface RecallWindowEcho {
  since: string | null;
  until: string | null;
  field: "updatedAt";
  appliesTo: readonly ["semantic", "structured"];
}

/** A calendar date, or a date and time with an optional offset. */
const ISO_8601 =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

function readEnd(
  name: "since" | "until",
  value: unknown
): { ok: true; date?: Date } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true };
  if (typeof value !== "string" || !ISO_8601.test(value.trim())) {
    return {
      ok: false,
      error: `${name} must be an ISO-8601 date or date-time (e.g. "2026-11-16" or "2026-11-16T09:00:00Z"); got ${JSON.stringify(value)}.`,
    };
  }
  const ms = Date.parse(value.trim());
  if (!Number.isFinite(ms)) {
    return { ok: false, error: `${name} is not a real date: ${value}.` };
  }
  return { ok: true, date: new Date(ms) };
}

/**
 * The caller's `since` / `until`, checked. Neither given = `null` (no window).
 * A malformed end, or `since` not before `until`, is refused with the reason:
 * never read as "no window", which would answer a different question.
 */
export function parseRecallWindow(args: {
  since?: unknown;
  until?: unknown;
}): { ok: true; window: RecallWindow | null } | { ok: false; error: string } {
  const since = readEnd("since", args.since);
  if (!since.ok) return since;
  const until = readEnd("until", args.until);
  if (!until.ok) return until;
  if (!since.date && !until.date) return { ok: true, window: null };
  if (since.date && until.date && since.date >= until.date) {
    return {
      ok: false,
      error: `since (${since.date.toISOString()}) must be before until (${until.date.toISOString()}).`,
    };
  }
  return {
    ok: true,
    window: {
      ...(since.date ? { since: since.date } : {}),
      ...(until.date ? { until: until.date } : {}),
    },
  };
}

/** The window as SQL on one timestamp column; `undefined` when open. */
export function recallWindowWhere(
  column: Column,
  window: RecallWindow | null | undefined
): SQL | undefined {
  if (!window) return undefined;
  const parts = [
    ...(window.since ? [gte(column, window.since)] : []),
    ...(window.until ? [lt(column, window.until)] : []),
  ];
  return parts.length ? and(...parts) : undefined;
}

/** The window in the search index's unit (epoch SECONDS, `toTimestamp`). */
export function recallWindowSeconds(window: RecallWindow | null | undefined): {
  updatedSince?: number;
  updatedUntil?: number;
} {
  if (!window) return {};
  return {
    ...(window.since
      ? { updatedSince: Math.floor(window.since.getTime() / 1000) }
      : {}),
    ...(window.until
      ? { updatedUntil: Math.ceil(window.until.getTime() / 1000) }
      : {}),
  };
}

export function echoRecallWindow(window: RecallWindow): RecallWindowEcho {
  return {
    since: window.since?.toISOString() ?? null,
    until: window.until?.toISOString() ?? null,
    field: "updatedAt",
    appliesTo: ["semantic", "structured"],
  };
}
