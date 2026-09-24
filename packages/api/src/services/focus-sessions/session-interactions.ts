/**
 * SESSION INTERACTIONS — the session→session relations nobody DECLARED, derived
 * from what already happened on the pod.
 *
 * `spawned_from` and `blocked_by` are the only stored session→session edges,
 * and on the live pod 48 of the last 50 sessions declare neither (measured
 * 2026-09-22). But sessions still act on each other, and the pod records it:
 *
 *   triggered — B is an automation/playbook RUN fired by a data event, and that
 *               event was written by session A. Chain: B's
 *               `metadata.automationRunId` → `automation_runs.trigger_event_id`
 *               (or B's `metadata.automationChainContext.triggerEventId`, the
 *               playbook-run stamp) → `events.session_id` = A.
 *   updated   — session B wrote to something session A PRODUCED: an `events`
 *               row with `session_id` = B whose subject is the `to` end of an
 *               `A --produced--> X` link. Type-agnostic on purpose — an edit, a
 *               relation, a status change all count as "B acted on A's output";
 *               A's own create event is excluded by A ≠ B.
 *
 * DERIVED, NEVER STORED — the same reason blocked-ness is derived
 * (`session-blocked-by.ts`): a copy of a conclusion the ledgers already imply
 * is a copy that can be wrong. Nothing here writes.
 *
 * ── SCOPE: BOTH ENDS ON THE PAGE ────────────────────────────────────────────
 * The caller's page is already owner-floored (`sessionListConditions` floors on
 * `userId`), and the only consumer — the work map — draws a line only between
 * two sessions it shows. So BOTH endpoints are constrained to the page ids:
 * that is the owner floor for free, and it bounds each query by an index
 * (`idx_events_session_id`, the `links` from/to indexes) instead of scanning
 * the event log. A relation to a session off the page is not reported — the
 * map says it is showing a window, and this read shares that window.
 *
 * ── A FAILED READ IS NOT AN EMPTY ONE ───────────────────────────────────────
 * `readSessionInteractions` throws; `attachSessionInteractions` turns a throw
 * into `{ status: "unavailable" }` on every row, never `items: []`. "No line"
 * and "could not look" must not render the same.
 */

import {
  db,
  and,
  eq,
  ne,
  count,
  max,
  inArray,
  drizzleSql,
  events,
  links,
  focusSessions,
  automationRuns,
} from "@synap/database";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "session-interactions" });

export type SessionInteractionType = "triggered" | "updated";

export interface SessionInteraction {
  type: SessionInteractionType;
  /** triggered: the session whose write fired the run. updated: the producer. */
  fromSessionId: string;
  /** triggered: the run it fired. updated: the session that wrote to the output. */
  toSessionId: string;
  /** How many events back this relation (updated can be many writes). */
  count: number;
  /** The latest of them, ISO. */
  lastAt: string | null;
}

export type SessionInteractionsSection =
  | { status: "ok"; items: SessionInteraction[] }
  | { status: "unavailable"; reason: string };

const iso = (d: Date | string | null | undefined): string | null =>
  d ? new Date(d).toISOString() : null;

/**
 * Every derived interaction whose BOTH endpoints are in `ids`. Two indexed
 * queries for the page, whatever its size. Throws on a failed read.
 */
export async function readSessionInteractions(
  ids: readonly string[],
  database: typeof db = db
): Promise<SessionInteraction[]> {
  if (ids.length < 2) return [];
  const page = [...ids];

  // TRIGGERED — run B ← its triggering event ← the session that wrote it.
  // Both run stamps are read: the automation executor's `automationRunId`
  // (→ `automation_runs.trigger_event_id`) and the playbook-run step's nested
  // `automationChainContext.triggerEventId`. Compared as TEXT so a malformed
  // metadata value is a non-match, never a uuid cast error.
  const triggerEventText = drizzleSql<string>`coalesce(${automationRuns.triggerEventId}::text, ${focusSessions.metadata}->'automationChainContext'->>'triggerEventId')`;
  const triggered = database
    .select({
      from: events.sessionId,
      to: focusSessions.id,
      n: count(),
      last: max(events.timestamp),
    })
    .from(focusSessions)
    .leftJoin(
      automationRuns,
      eq(
        drizzleSql`${automationRuns.id}::text`,
        drizzleSql`${focusSessions.metadata}->>'automationRunId'`
      )
    )
    .innerJoin(events, eq(drizzleSql`${events.id}::text`, triggerEventText))
    .where(
      and(
        inArray(focusSessions.id, page),
        inArray(events.sessionId, page),
        ne(events.sessionId, focusSessions.id)
      )
    )
    .groupBy(events.sessionId, focusSessions.id);

  // UPDATED — B's writes on the outputs A produced.
  const updated = database
    .select({
      from: links.fromId,
      to: events.sessionId,
      n: count(),
      last: max(events.timestamp),
    })
    .from(events)
    .innerJoin(
      links,
      and(
        eq(links.toId, events.subjectId),
        eq(links.toType, events.subjectType),
        eq(links.linkType, "produced"),
        eq(links.fromType, "session")
      )
    )
    .where(
      and(
        inArray(events.sessionId, page),
        inArray(links.fromId, page),
        ne(links.fromId, drizzleSql`${events.sessionId}::text`)
      )
    )
    .groupBy(links.fromId, events.sessionId);

  const [triggeredRows, updatedRows] = await Promise.all([triggered, updated]);
  const out: SessionInteraction[] = [];
  for (const r of triggeredRows) {
    if (!r.from) continue;
    out.push({
      type: "triggered",
      fromSessionId: String(r.from),
      toSessionId: String(r.to),
      count: Number(r.n),
      lastAt: iso(r.last),
    });
  }
  for (const r of updatedRows) {
    if (!r.to) continue;
    out.push({
      type: "updated",
      fromSessionId: String(r.from),
      toSessionId: String(r.to),
      count: Number(r.n),
      lastAt: iso(r.last),
    });
  }
  return out;
}

/**
 * Attach, to every row, the interactions it is an endpoint of. One read for
 * the page; a failure marks EVERY row `unavailable` (logged, fixed sentence).
 */
export async function attachSessionInteractions<T extends { id: string }>(
  rows: readonly T[],
  database: typeof db = db
): Promise<Array<T & { interactions: SessionInteractionsSection }>> {
  let all: SessionInteraction[];
  try {
    all = await readSessionInteractions(
      rows.map((r) => r.id),
      database
    );
  } catch (err) {
    logger.warn({ err }, "session interactions: read failed");
    const unavailable: SessionInteractionsSection = {
      status: "unavailable",
      reason: "Interactions between sessions could not be read.",
    };
    return rows.map((r) => ({ ...r, interactions: unavailable }));
  }
  return rows.map((r) => ({
    ...r,
    interactions: {
      status: "ok",
      items: all.filter(
        (i) => i.fromSessionId === r.id || i.toSessionId === r.id
      ),
    },
  }));
}
