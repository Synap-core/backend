/**
 * SESSION LIVENESS — the two facts "is an agent working on this right now?"
 * reads (founder decision D1, 2026-10-04: an IS turn in flight OR any session
 * activity in the last `SESSION_WORKING_WINDOW_MS`), for MANY sessions in one
 * batched read.
 *
 * ONE function, two doors, so they cannot disagree:
 *   - `focusSessions.activity` / `runs.get` → `live` on the activity wire
 *     (the session page's header mark + Now line);
 *   - `focusSessions.list` rows (under `nextMove: true`) → `live` on each row
 *     (the session list marks, browser and relay).
 * The RULE over these facts is `isSessionWorkingNow`
 * (`@synap-core/types/run-activity`); this file only measures.
 *
 * ── Sources (the activity read's own sources, at row grain) ────────────────
 *   turns     — `chat_turns` in the session's room: any `running` turn is the
 *               in-flight fact; `updated_at` moves on every frame a turn
 *               appends and on its finish.
 *   events    — `events.session_id` `.completed` writes through
 *               `eventVisibleWhere`, excluding session-row bookkeeping that is
 *               not a lifecycle bookend (a reaper stamping `stale` is not an
 *               agent working — same exclusion the activity read makes).
 *   proposals — filed or decided under the session, through the shared floor.
 *   asks      — owed slots handed back (`owedSince`), off the row itself.
 *   notes     — agent messages posted in the room.
 *
 * ── EMPTY vs FAILED ────────────────────────────────────────────────────────
 * A session with no activity reads `{ turnInFlight: false, lastAt: null }`. A
 * read that THROWS reads `null` for every session it covered — never a quiet
 * session — and the state mark then says "not measured".
 */

import {
  db,
  and,
  eq,
  gte,
  inArray,
  isNull,
  like,
  max,
  or,
  drizzleSql as sql,
  chatTurns,
  events,
  messages,
  MessageAuthorType,
  proposals,
} from "@synap/database";
import { createLogger } from "@synap-core/core";
import type { SessionActivityLive } from "@synap-core/types/run-activity";
import type { ExpectedOutput } from "@synap/playbooks";
import { eventVisibleWhere } from "../../access/event-visibility.js";
import { proposalUserFloor } from "../../routers/proposals/scope-conditions.js";
import { isOwedSlot } from "../focus-sessions/owed-outputs.js";

const logger = createLogger({ module: "session-liveness" });

/** The session-row fields the read needs — every list row and the activity read carry them. */
export interface LivenessSession {
  id: string;
  channelId: string | null;
  expectedOutputs?: unknown;
  startedAt?: Date | string | null;
}

export interface LivenessReader {
  userId: string;
  roster: boolean;
}

/**
 * Session lifecycle verbs that ARE activity on the session itself (mirrors
 * `LIFECYCLE_ACTIONS` in ./session-activity.ts). Any other session-subject
 * event (progress stamps, status bookkeeping) is not.
 */
export const LIVENESS_LIFECYCLE_ACTIONS = [
  "create",
  "start",
  "close",
  "complete",
  "cancel",
  "revert",
] as const;

function toTime(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const t = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
}

/** The newest owed-slot hand-back on the row — the `asks` source. */
function newestAsk(session: LivenessSession): number | null {
  const slots = Array.isArray(session.expectedOutputs)
    ? (session.expectedOutputs as ExpectedOutput[])
    : [];
  let newest: number | null = null;
  for (const slot of slots) {
    if (!slot || typeof slot !== "object" || !isOwedSlot(slot)) continue;
    if (typeof slot.label !== "string" || !slot.label.trim()) continue;
    const since = (slot as { owedSince?: unknown }).owedSince;
    const t =
      typeof since === "string" && since.trim()
        ? toTime(since)
        : toTime(session.startedAt ?? null);
    if (t !== null && (newest === null || t > newest)) newest = t;
  }
  return newest;
}

/**
 * Liveness for each session, keyed by id. Every id in `sessions` is present:
 * the facts, or `null` when the read failed.
 *
 * `since` BOUNDS the activity sources to `>= since` (index-backed range scans
 * instead of each session's whole history) — for a caller that only asks
 * "working now" (`signals` Happening, with `since = now − window`). The
 * `isSessionWorkingNow` answer is unchanged by it; `lastAt` is then null for
 * a session with no activity since then (an owed slot's hand-back, read off
 * the row, still counts). The running-turn fact is never bounded.
 */
export async function loadSessionLiveness(
  reader: LivenessReader,
  sessions: readonly LivenessSession[],
  opts: { since?: Date } = {}
): Promise<Map<string, SessionActivityLive | null>> {
  const since = opts.since;
  const out = new Map<string, SessionActivityLive | null>();
  if (sessions.length === 0) return out;

  const ids = sessions.map((s) => s.id);
  const channelIds = [
    ...new Set(
      sessions.map((s) => s.channelId).filter((c): c is string => !!c)
    ),
  ];

  try {
    const [turnRows, runningRows, eventRows, proposalRows, noteRows] =
      await Promise.all([
        channelIds.length
          ? db
              .select({
                channelId: chatTurns.channelId,
                at: max(chatTurns.updatedAt),
              })
              .from(chatTurns)
              .where(
                and(
                  inArray(chatTurns.channelId, channelIds),
                  since ? gte(chatTurns.updatedAt, since) : undefined
                )
              )
              .groupBy(chatTurns.channelId)
          : Promise.resolve([]),
        channelIds.length
          ? db
              .select({
                channelId: chatTurns.channelId,
                id: chatTurns.id,
                startedAt: chatTurns.startedAt,
              })
              .from(chatTurns)
              .where(
                and(
                  inArray(chatTurns.channelId, channelIds),
                  eq(chatTurns.status, "running")
                )
              )
          : Promise.resolve([]),
        db
          .select({ sessionId: events.sessionId, at: max(events.timestamp) })
          .from(events)
          .where(
            and(
              inArray(events.sessionId, ids),
              since ? gte(events.timestamp, since) : undefined,
              like(events.type, "%.completed"),
              // Session-row bookkeeping is not activity; its lifecycle
              // bookends are (the activity read's own exclusion).
              sql`NOT (
                ${events.subjectType} IN ('focus_session', 'session')
                AND split_part(${events.type}, '.', 2) NOT IN (${sql.join(
                  LIVENESS_LIFECYCLE_ACTIONS.map((a) => sql`${a}`),
                  sql`, `
                )})
              )`,
              eventVisibleWhere({
                userId: reader.userId,
                roster: reader.roster,
              })
            )
          )
          .groupBy(events.sessionId),
        db
          .select({
            sessionId: proposals.sessionId,
            at: sql<
              Date | string | null
            >`max(greatest(${proposals.createdAt}, coalesce(${proposals.reviewedAt}, ${proposals.createdAt})))`,
          })
          .from(proposals)
          .where(
            and(
              inArray(proposals.sessionId, ids),
              since
                ? or(
                    gte(proposals.createdAt, since),
                    gte(proposals.reviewedAt, since)
                  )
                : undefined,
              proposalUserFloor(reader.userId)
            )
          )
          .groupBy(proposals.sessionId),
        channelIds.length
          ? db
              .select({
                channelId: messages.channelId,
                at: max(messages.timestamp),
              })
              .from(messages)
              .where(
                and(
                  inArray(messages.channelId, channelIds),
                  since ? gte(messages.timestamp, since) : undefined,
                  eq(messages.authorType, MessageAuthorType.AI_AGENT),
                  isNull(messages.deletedAt)
                )
              )
              .groupBy(messages.channelId)
          : Promise.resolve([]),
      ]);

    const byChannel = (rows: Array<{ channelId: string; at: unknown }>) =>
      new Map(
        rows.map((r) => [r.channelId, toTime(r.at as Date | string | null)])
      );
    const bySession = (
      rows: Array<{ sessionId: string | null; at: unknown }>
    ) =>
      new Map(
        rows
          .filter((r): r is { sessionId: string; at: unknown } => !!r.sessionId)
          .map((r) => [r.sessionId, toTime(r.at as Date | string | null)])
      );
    const turnAt = byChannel(turnRows);
    const noteAt = byChannel(noteRows);
    const eventAt = bySession(eventRows);
    const proposalAt = bySession(proposalRows);

    for (const s of sessions) {
      const running = s.channelId
        ? runningRows
            .filter((r) => r.channelId === s.channelId)
            .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0]
        : undefined;
      const candidates = [
        s.channelId ? turnAt.get(s.channelId) : null,
        s.channelId ? noteAt.get(s.channelId) : null,
        eventAt.get(s.id),
        proposalAt.get(s.id),
        newestAsk(s),
      ].filter((t): t is number => typeof t === "number");
      const last = candidates.length ? Math.max(...candidates) : null;
      out.set(s.id, {
        turnInFlight: !!running,
        turnId: running?.id ?? null,
        since: running?.startedAt ?? null,
        lastAt: last === null ? null : new Date(last),
      });
    }
  } catch (err) {
    logger.warn({ err, sessions: ids.length }, "session liveness read failed");
    for (const id of ids) out.set(id, null);
  }
  return out;
}
