/**
 * Events Router - Event Logging API
 *
 * V0.6: Refactored to use direct event publishing instead of deprecated eventService
 *
 * This is the PRIMARY entry point for modifying system state.
 * All state changes MUST go through the event log.
 */

import { z } from "zod";
import { router, protectedProcedure } from "../trpc.js";
import { TRPCError } from "@trpc/server";
import { requireUserId } from "../utils/user-scoped.js";
// REMOVED: Domain package - using simple string schemas instead
// import { subjectTypeSchema, EventSourceSchema } from '@synap/domain';
import { createSynapEvent } from "@synap-core/core";
import { EVENT_ACTIONS } from "@synap-core/types/events";
import { db, getEventRepository } from "@synap/database";
import { resolveSubjectNames, subjectKey } from "./subscriptions.js";
import { and, inArray } from "drizzle-orm";
import { focusSessions } from "@synap/database/schema";
import {
  rosterReadFor,
  sessionReadableWhere,
  type SessionReader,
} from "../access/session-visibility.js";
import { eventVisibleWhereFor } from "../access/event-visibility.js";
import type { EventType } from "@synap/events";
import { randomUUID } from "crypto";

/**
 * The lifecycle families a lens page's Happened reads as data lines — the
 * subjects `parseConnectionEvent` (`@synap-core/types/events`) turns into a
 * line, as the SQL prefilter sees them (the parser stays the authority).
 * Every `case` of that parser is CLASSIFIED here or in
 * `LIFECYCLE_SUBJECTS_LEFT_TO_THEIR_OWN_READ`, and a tripwire
 * (`events.lifecycle-subjects.tripwire.test.ts`) fails on one that is in
 * neither — a family the parser learns can never be silently dropped.
 */
export const LIFECYCLE_LINE_SUBJECTS = [
  "app",
  "apiKey",
  "api_key",
  "apikey",
  "messaging_account",
  "connector",
  "connector_sync",
  "webhooks",
  "webhook",
] as const;

/**
 * Parser families deliberately NOT prefiltered in, each with why. They are
 * not lost: each is read through its own door.
 */
export const LIFECYCLE_SUBJECTS_LEFT_TO_THEIR_OWN_READ = {
  // One row per message — it would spend the page on chatter; a room is its door.
  channel_message: "per-message volume; the room is the door",
  external_message: "per-message volume; the room is the door",
  external_channel: "created alongside its messaging account line",
  // Its progress ticks share one type; only `data.phase` tells a terminal row
  // from a tick, which SQL here cannot see — `connector_sync.complete` is the
  // run's fact.
  connection_sync: "ticks share the type; connector_sync.complete is the fact",
  // Session/track lifecycles are the ledger's (`activity.list`) rows already.
  focus_session: "the activity ledger carries session lifecycles",
  track: "the activity ledger carries track lifecycles",
} as const;

// Temporary schemas until we refactor
/**
 * A session's events ARE its story (decision D1: a session's goal, status and
 * summary are CONTENT). An event whose subject is a focus session, or that was
 * recorded inside one (`events.session_id`), is returned only when the caller
 * may read that session — `sessionReadableWhere`, the one session read rule.
 *
 * OMIT, not strip: the event's TYPE and TIMESTAMP already tell a non-reader
 * what happened in a colleague's session and when ("closed", "stage advanced"),
 * so a payload-less row would still be a leak — and a row with its payload
 * gutted renders as an unexplained blank. The cost is honest: a page can come
 * back shorter than `limit`; paging by `offset` still reaches every row.
 */
async function omitUnreadableSessionEvents<
  E extends {
    subjectType?: string | null;
    subjectId?: string | null;
    sessionId?: string | null;
  },
>(events: E[], reader: SessionReader): Promise<E[]> {
  const sessionOf = (e: E): string[] =>
    [
      e.subjectType === "focus_session" ? e.subjectId : null,
      e.sessionId,
    ].filter((id): id is string => !!id);
  const ids = [...new Set(events.flatMap(sessionOf))];
  if (ids.length === 0) return events;
  const readable = new Set(
    (
      await db
        .select({ id: focusSessions.id })
        .from(focusSessions)
        .where(
          and(inArray(focusSessions.id, ids), sessionReadableWhere(reader))
        )
    ).map((r) => r.id)
  );
  return events.filter((e) => sessionOf(e).every((id) => readable.has(id)));
}

const subjectTypeSchema = z.enum([
  "entity",
  "relation",
  "user",
  "system",
  "workspace",
  "project",
  "task",
  "document",
  "chat",
  "message",
  "apiKey",
  "member",
]);
const EventSourceSchema = z.enum([
  "api",
  "automation",
  "sync",
  "migration",
  "system",
]);

/**
 * Lifecycle phases a CLIENT may never assert about its own event.
 *
 * `.validated` is load-bearing for security (it drives materialization — see
 * the `log` procedure's note); the others are included because a client
 * declaring an outcome phase for its own request is meaningless in every case,
 * and leaving them open would invite the same class of confusion.
 */
const RESERVED_EVENT_PHASES = [".validated", ".completed", ".failed"] as const;
const TimeSeriesPeriodSchema = z.enum(["day", "week", "month"]);

type TimeSeriesPeriod = z.infer<typeof TimeSeriesPeriodSchema>;

function getBucketStart(date: Date, period: TimeSeriesPeriod): Date {
  const next = new Date(date);
  if (period === "day") {
    next.setHours(0, 0, 0, 0);
    return next;
  }
  if (period === "month") {
    next.setDate(1);
    next.setHours(0, 0, 0, 0);
    return next;
  }
  const day = next.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  next.setDate(next.getDate() + diff);
  next.setHours(0, 0, 0, 0);
  return next;
}

function addPeriod(date: Date, period: TimeSeriesPeriod, amount: number): Date {
  const next = new Date(date);
  if (period === "day") next.setDate(next.getDate() + amount);
  else if (period === "week") next.setDate(next.getDate() + amount * 7);
  else next.setMonth(next.getMonth() + amount);
  return getBucketStart(next, period);
}

function defaultRange(period: TimeSeriesPeriod): { from: Date; to: Date } {
  const bucketCount = period === "day" ? 14 : 12;
  const end = addPeriod(getBucketStart(new Date(), period), period, 1);
  const from = addPeriod(end, period, -bucketCount);
  return { from, to: end };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function recordProfileSlug(value: unknown): string | undefined {
  const record = asRecord(value);
  const direct = record.profileSlug ?? record.profile_slug ?? record.type;
  if (typeof direct === "string") return direct;
  const entity = asRecord(record.entity);
  const nested = entity.profileSlug ?? entity.profile_slug ?? entity.type;
  return typeof nested === "string" ? nested : undefined;
}

export const eventsRouter = router({
  /**
   * Log a new event.
   *
   * A caller may only ever assert INTENT (`.requested`) or a plain domain fact.
   * It may NOT assert a lifecycle-completion phase about itself.
   *
   * SECURITY — why `RESERVED_EVENT_PHASES` exists:
   * `.validated` is not a log line, it is a COMMAND. The materialization hook
   * (`setup-event-broadcasting.ts`) matches on that suffix alone and enqueues a
   * `materialize` job, which the worker executes — including a
   * `command.execute.validated` branch that runs `/bin/sh -c <data.command>` on
   * the pod host. Because this procedure accepted a free-form `eventType`, any
   * authenticated session could reach that branch, grant itself `owner` via
   * `workspace.join.validated`, or delete through the DESTRUCTIVE floor.
   * A client asserting a completion phase about its own request is a category
   * error, so rejecting these costs nothing legitimate: the real emitters are
   * the proposal approve-executors, which call `auditLog()` server-side and
   * never route through here.
   *
   * This is defence in depth, NOT the primary fix — the worker independently
   * verifies an approved proposal (see `handleMaterialize`), so any other way
   * of enqueueing a materialize job is closed too.
   */
  log: protectedProcedure
    .input(
      z.object({
        subjectId: z.string().uuid(),
        subjectType: subjectTypeSchema,
        eventType: z
          .string()
          .min(1)
          .refine((t) => !RESERVED_EVENT_PHASES.some((p) => t.endsWith(p)), {
            message:
              "eventType may not end in a reserved lifecycle phase " +
              `(${RESERVED_EVENT_PHASES.join(", ")}) — these are emitted ` +
              "server-side by the approval pipeline, not by clients.",
          }),
        data: z.record(z.string(), z.unknown()),
        metadata: z.record(z.string(), z.unknown()).optional(),
        version: z.number().int().positive(),
        source: EventSourceSchema.optional(),
        causationId: z.string().uuid().optional(),
        correlationId: z.string().uuid().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const requestId = randomUUID();
      const correlationId = input.correlationId || randomUUID();

      // Create SynapEvent
      const event = createSynapEvent({
        type: input.eventType as EventType,
        userId,
        subjectId: input.subjectId,
        data: input.data,
        source: input.source || "api",
        requestId,
        correlationId,
        causationId: input.causationId,
        metadata: input.metadata,
      });

      // Append to Event Store (events are audit trail, no need to forward to job queue)
      const eventRepo = getEventRepository();
      const eventRecord = await eventRepo.append(event);

      return eventRecord;
    }),

  /**
   * Read events for the current user — the canonical query endpoint.
   *
   * Replaces the legacy `list` + `since` procedures (2026-05-11). One
   * shape, one wire field name (`type`), one set of filters.
   *
   * Scoping: USER-scoped — `userId = ctx.userId`. Matches the
   * `workspace_as_lens` principle: a user wants "everything that affected
   * me", not "everything that affected workspace X". Admins who need
   * cross-user search use `events.search` (gated).
   *
   * Two output shapes selected via `lean`:
   *   • `lean: false` (default) — full record: id, timestamp, type,
   *     subjectType, subjectId, data, metadata, source, correlationId,
   *     userId. Use for human-readable activity streams.
   *   • `lean: true`            — { id, timestamp, type, subjectType,
   *     subjectId }. Use for high-frequency polling where you only need
   *     to know "what changed" to invalidate caches.
   *
   * Date inputs use `z.coerce.date()` so callers using either the typed
   * tRPC client (Date via superjson) or raw `fetch` (ISO string in the
   * `?input=` envelope) both work without a serialization helper.
   *
   * Polling pattern:
   *   every 30s:
   *     const events = await trpc.events.read.query({
   *       since: lastSyncAt, lean: true,
   *     })
   *     for each event: queryClient.invalidateQueries({ queryKey: [...] })
   *     lastSyncAt = now
   */
  read: protectedProcedure
    .input(
      z.object({
        since: z.coerce.date().optional(),
        until: z.coerce.date().optional(),
        type: z.string().optional(),
        subjectType: subjectTypeSchema.optional(),
        /**
         * Narrow the stream to ONE workspace. The floor is unchanged — the read
         * is already scoped to `userId` — so this only ever narrows.
         *
         * It exists because the activity feed (`signals.list` history lens)
         * scopes its proposals half by workspace and had no way to scope its
         * events half: a user viewing one workspace saw that workspace's
         * decisions beside every workspace's events. Omitted = every workspace,
         * exactly as before.
         *
         * Lens semantics match the notification centre: the named workspace's
         * rows PLUS pod-wide rows (`workspace_id IS NULL`), which belong to
         * every workspace. Another workspace's rows are excluded.
         */
        workspaceId: z.string().optional(),
        /**
         * Narrow the stream to ONE focus session — every event that happened
         * inside that unit of work.
         *
         * `events.session_id` (migration 0241) had no reader outside the graph
         * service: the spine was written and never queried, so a session could
         * not show its own history. This is the reader, and it only ever
         * narrows the existing `userId` floor.
         *
         * There is no `projectId` twin here: `events` carries no `project_id`
         * column. A project lens on the history feed is served by the
         * proposals half alone — see `signals.list`.
         */
        sessionId: z.string().uuid().optional(),
        /**
         * Narrow the stream to ONE application — every event a write made with
         * that app's key produced (`events.app_id`, the app's `public_id`).
         *
         * `events.app_id` has carried the attribution since 0310 with no
         * reader; this is the reader, and like `sessionId` it only ever narrows
         * the existing `userId` floor. It is what lets an app's own page answer
         * "what has this app done?" rather than only "what may it touch?".
         */
        appId: z.string().min(1).max(200).optional(),
        limit: z.number().min(1).max(500).default(50),
        /**
         * Skip this many rows of the SAME ordered read — the "Load more" door
         * for a full stream (an app's own activity page). The repository has
         * always ordered `timestamp DESC`; this exposes its existing `offset`.
         *
         * Deliberately NOT timestamp paging via `until`: that bound is
         * INCLUSIVE, so a client walking backwards would re-fetch its boundary
         * row and stall, and retreating by a millisecond would SKIP rows a
         * batch write landed in the same millisecond as. Offset is exact; a
         * caller still dedupes by `id`, because a new event arriving between
         * two pages shifts everything down by one.
         */
        offset: z.number().int().min(0).optional(),
        lean: z.boolean().default(false),
        /**
         * Only rows that become a Happened DATA line (`happenedItemOfEvent`):
         * record changes — `{subject}.{create|update|delete|archive|restore}
         * .completed` — and the connection LIFECYCLE families
         * (`LIFECYCLE_LINE_SUBJECTS`), filtered in SQL BEFORE the limit. The
         * lens page's Happened reads this way, so governance phases never use
         * up its page.
         */
        dataLines: z.boolean().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const eventRepo = getEventRepository();

      const events = await eventRepo.searchEvents({
        userId,
        eventType: input.type,
        subjectType: input.subjectType,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        appId: input.appId,
        // The notif-center lens: a workspace narrowing still shows the
        // pod-wide rows that belong to every workspace. An `eq` never matches
        // NULL, so without this the feed drops them silently.
        includePodWide: true,
        fromDate: input.since,
        toDate: input.until,
        limit: input.limit,
        offset: input.offset,
        ...(input.dataLines
          ? {
              dataLines: {
                recordActions: EVENT_ACTIONS,
                lifecycleSubjects: LIFECYCLE_LINE_SUBJECTS,
              },
            }
          : {}),
      });

      return events.map((e) => {
        const base = {
          id: e.id,
          timestamp: e.timestamp,
          type: e.eventType,
          subjectType: e.subjectType,
          subjectId: e.subjectId,
        };
        if (input.lean) return base;
        return {
          ...base,
          data: e.data,
          metadata: e.metadata,
          source: e.source,
          correlationId: e.correlationId,
          userId: e.userId,
        };
      });
    }),

  /**
   * Search the events the caller may see.
   *
   * The floor is the `events` VisibilityRule (`eventVisibleWhere`): events in
   * a workspace the caller can see, their own personal (NULL-workspace)
   * events, and a session's events only when they may read the session. Every
   * input is a filter ANDed onto that floor — `workspaceId` and `userId`
   * narrow, they never grant.
   *
   * There used to be a "system admin" branch here: anyone who owned ANY
   * workspace searched every user's events pod-wide, and `workspaceId` was
   * checked but never applied to the query. Both are gone (2026-09-27).
   */
  search: protectedProcedure
    .input(
      z.object({
        /** Narrow to one actor's events — within the caller's floor. */
        userId: z.string().optional(),
        eventType: z.string().optional(),
        subjectType: subjectTypeSchema.optional(),
        subjectId: z.string().optional(),
        // Multi-subject filter: union of these subjects' events (e.g. a
        // campaign timeline showing all its members' activity). Unioned with
        // `subjectId` if both are given. Capped at 200 to bound the IN clause.
        subjectIds: z.array(z.string()).max(200).optional(),
        correlationId: z.string().optional(),
        /** Same session lens as `read` — `events.session_id`, narrowing only. */
        sessionId: z.string().uuid().optional(),
        fromDate: z.date().optional(),
        toDate: z.date().optional(),
        limit: z.number().min(1).max(100).default(50),
        offset: z.number().min(0).default(0),
        /** Narrow to ONE workspace (strictly: no pod-wide rows). */
        workspaceId: z.string().uuid().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const eventRepo = getEventRepository();

      const found = await eventRepo.searchEvents({
        visibleWhere: eventVisibleWhereFor(ctx),
        userId: input.userId,
        workspaceId: input.workspaceId,
        eventType: input.eventType,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        subjectIds: input.subjectIds,
        correlationId: input.correlationId,
        sessionId: input.sessionId,
        fromDate: input.fromDate,
        toDate: input.toDate,
        limit: input.limit,
        offset: input.offset,
      });
      const events = await omitUnreadableSessionEvents(found, {
        userId,
        roster: rosterReadFor(ctx),
      });

      // ── NAME THE SUBJECT ────────────────────────────────────────────────
      // This is the door relay's activity feed reads, and it returned only the
      // raw `subjectType`/`subjectId`. Relay could do nothing but guess a name
      // out of `data.name ?? data.title` — which most event payloads do not
      // carry — so a row rendered as a bare "Created" with nothing to say WHAT
      // was created.
      //
      // `resolveSubjectNames` is the SAME resolver `subscriptions.ts` already
      // uses for its own feed (imported, never copied): one batched, visibility-
      // floored query per DISTINCT subject type present. That makes the cost a
      // function of the number of subject types (≤8), not of the page — and
      // this page is hard-capped at `limit.max(100)`, a quarter of the 500-event
      // window the resolver already serves in `subscriptions`.
      //
      // FAIL-OPEN by construction: an id whose row the CALLER cannot see is
      // simply absent from the map, so `subjectName` is omitted rather than
      // fabricated. The resolver floors on `ctx.userId` on its own.
      const subjectNameByKey = await resolveSubjectNames(events, ctx.userId);
      return events.map((event) => {
        const name =
          event.subjectType && event.subjectId
            ? subjectNameByKey.get(
                subjectKey(event.subjectType, event.subjectId)
              )
            : undefined;
        return name ? { ...event, subjectName: name } : event;
      });
    }),

  /**
   * Return the event timeline for a focus session's IS correlationId,
   * ordered chronologically. The correlationId on focus_sessions is a text
   * column but events.correlation_id is uuid — the repository casts via
   * ::uuid[] so a non-uuid value is rejected at the DB level.
   *
   * SECURITY: tenancy-clamped to ctx.userId — another user's events that
   * happen to share the same correlationId are never returned.
   */
  listByCorrelationId: protectedProcedure
    .input(z.object({ correlationId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const eventRepo = getEventRepository();
      const events = await eventRepo.getCorrelatedEvents(
        input.correlationId,
        userId
      );
      return events.map((e) => ({
        id: e.id,
        timestamp: e.timestamp,
        type: e.eventType,
        subjectType: e.subjectType,
        subjectId: e.subjectId,
        data: e.data,
        metadata: e.metadata,
        source: e.source,
        correlationId: e.correlationId,
        userId: e.userId,
      }));
    }),

  /**
   * Scoped event activity buckets for charts.
   *
   * This intentionally returns aggregate points instead of raw event rows so
   * entity-detail/chart widgets can show time dimension without broad event-log
   * reads. Results are always clamped to the current user; workspace filtering
   * additionally verifies workspace membership.
   */
  aggregateTimeSeries: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string().uuid().optional(),
        subjectId: z.string().optional(),
        subjectType: subjectTypeSchema.optional(),
        profileSlug: z.string().optional(),
        eventTypes: z.array(z.string().min(1)).optional(),
        period: TimeSeriesPeriodSchema.default("week"),
        range: z
          .object({
            from: z.coerce.date(),
            to: z.coerce.date(),
          })
          .optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const eventRepo = getEventRepository();

      if (input.workspaceId) {
        const membership = await db.query.workspaceMembers.findFirst({
          where: (members, { and, eq }) =>
            and(
              eq(members.workspaceId, input.workspaceId!),
              eq(members.userId, userId)
            ),
        });
        if (!membership) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Cannot aggregate events for this workspace",
          });
        }
      }

      const fallbackRange = defaultRange(input.period);
      const fromDate = input.range?.from ?? fallbackRange.from;
      const toDate = input.range?.to ?? fallbackRange.to;
      const bucketStarts: Date[] = [];
      for (
        let cursor = getBucketStart(fromDate, input.period);
        cursor.getTime() < toDate.getTime();
        cursor = addPeriod(cursor, input.period, 1)
      ) {
        bucketStarts.push(cursor);
      }

      const buckets = new Map(
        bucketStarts.map((start) => [start.toISOString(), 0])
      );
      const events = await eventRepo.searchEvents({
        userId,
        workspaceId: input.workspaceId,
        subjectId: input.subjectId,
        subjectType: input.subjectType,
        fromDate,
        toDate,
        limit: 5000,
      });
      const eventTypeSet = input.eventTypes?.length
        ? new Set(input.eventTypes)
        : null;

      for (const event of events) {
        if (eventTypeSet && !eventTypeSet.has(event.eventType)) continue;
        if (input.profileSlug) {
          const dataSlug = recordProfileSlug(event.data);
          const metadataSlug = recordProfileSlug(event.metadata);
          if (
            dataSlug !== input.profileSlug &&
            metadataSlug !== input.profileSlug
          ) {
            continue;
          }
        }
        const timestamp = new Date(event.timestamp).getTime();
        if (Number.isNaN(timestamp)) continue;
        const bucketKey = getBucketStart(
          new Date(timestamp),
          input.period
        ).toISOString();
        if (!buckets.has(bucketKey)) continue;
        buckets.set(bucketKey, (buckets.get(bucketKey) ?? 0) + 1);
      }

      return {
        points: bucketStarts.map((start) => ({
          x: start.toISOString(),
          y: buckets.get(start.toISOString()) ?? 0,
        })),
      };
    }),

  /**
   * Count events (for pagination/analytics) — the same floor as `search`,
   * with `userId` and `workspaceId` as narrowing filters.
   */
  count: protectedProcedure
    .input(
      z.object({
        userId: z.string().optional(),
        eventType: z.string().optional(),
        subjectType: subjectTypeSchema.optional(),
        fromDate: z.date().optional(),
        toDate: z.date().optional(),
        workspaceId: z.string().uuid().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const eventRepo = getEventRepository();
      const count = await eventRepo.countEvents({
        visibleWhere: eventVisibleWhereFor(ctx),
        userId: input.userId,
        workspaceId: input.workspaceId,
        eventType: input.eventType,
        subjectType: input.subjectType,
        fromDate: input.fromDate,
        toDate: input.toDate,
      });

      return { count };
    }),
});
