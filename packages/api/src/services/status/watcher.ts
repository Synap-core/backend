/**
 * THE STATUS WATCHER — every hour it notices what is late, nearly due, stuck
 * in its step, or paused past its review date, and raises each ONCE per
 * episode: the derived event `<subjectType>.signal.completed` (automations
 * trigger on it; nothing here moves a thing), a notification to the
 * thing's owner, else its goal's owner, and the realtime event
 * `status:signal:raised` to each user who may read that status
 * (`status-realtime.ts`, under statusOf's floor).
 *
 * EPISODE = (subject, signal, anchor); the anchor is what changes when an
 * episode ends: the step and when it was entered, the bound date, the pause
 * and its review date. The episode is claimed in `status_signal_raised`
 * before it is raised, so two racing ticks raise it once; a raise that fails
 * gives its claim back. Residual: a crash between claim and raise loses it.
 *
 * DEV WORK (plan 5513a09a P4.1): a PR left green and unmerged, a PR left red
 * with no push, a red main nobody owns — each a signal for the session that
 * owns it, read off the newest `dev.repo_snapshot` of each repo (the rules:
 * `dev-signals.ts`). Its first raise is in-app only; it escalates once.
 *
 * WAIT EPISODES (status-first PR-H, `./wait-episodes.ts`): the same tick opens
 * an episode for each wait THE waiting-on collector finds and closes the ones
 * it no longer finds. History only: an episode notifies nobody.
 */
import {
  and,
  claimStatusSignals,
  db,
  declaredLifecycleProfilesStatement,
  desc,
  drizzleSql,
  entities,
  entityFacets,
  eq,
  events,
  EventRepository,
  focusSessions,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  notInArray,
  listableEntityWhere,
  listHolds,
  profiles,
  ProfileResolutionService,
  projectTracks,
  relations,
  releaseStatusSignal,
  sql,
  trackParticipants,
  users,
  type CurrentHold,
  type StatusSignalEpisode,
} from "@synap/database";
import type { ProjectTrack } from "@synap/database/schema";
import type { SQL } from "drizzle-orm";
import { emitSideEffects } from "@synap/events";
import { pushStatusSignal } from "./status-realtime.js";
import { createLogger } from "@synap-core/core";
import {
  DATE_APPROACHING_DAYS,
  dateSignalOf,
  findLifecycleOption,
  lifecycleOptionLabel,
  type LifecycleCategory,
  type StatusSignal,
  type TransitionSubjectType,
} from "@synap-core/types/lifecycle";
import { shortDate } from "@synap-core/types/lens";
import { goalOwner } from "@synap-core/types/units";
import {
  humanizeToken,
  resolveObjectNoun,
  resolveStatusLabel,
  resolveTrackStatusLabel,
} from "@synap-core/types/vocabulary";
import {
  resolveSessionTitle,
  TERMINAL_SESSION_STATUSES,
} from "@synap-core/types/focus-sessions";
import {
  DEV_LOOP_EVENT_TYPES,
  repoSnapshotEventSchema,
} from "@synap-core/types";
import { formatElapsed } from "@synap-core/types/value-format";
import { randomUUID } from "node:crypto";
import { NotificationService } from "../../notifications/NotificationService.js";
import { AccessContext, scopedDb } from "../../access/index.js";
import { entityReadVisibleWhere } from "../../access/entity-read-floor.js";
import { sessionReadableWhere } from "../../access/session-visibility.js";
import { BELONGS_TO_PROJECT } from "../../utils/project-scope.js";
import { SNAPSHOT_LOOKBACK_MS } from "../dev-loop/work-release.js";
import {
  devSignalsOf,
  mainRedOwnedRepos,
  type DevSignalCandidate,
} from "./dev-signals.js";
import { syncWaitEpisodesTick } from "./wait-episodes.js";
import {
  dateBindingsOf,
  pageThingsInColumn,
  stuckAfterDaysOf,
  stuckForDays,
  type StatusGroupSubject,
} from "../lifecycle/status-groups.js";

const logger = createLogger({ module: "status-watcher" });

const DAY_MS = 86_400_000;
const PAGE = 500;
/** Ids per `IN (…)` list: far under Postgres's 65,535 bind parameters. */
const CHUNK = 1_000;

const chunks = <T>(xs: readonly T[]): T[][] =>
  Array.from({ length: Math.ceil(xs.length / CHUNK) }, (_, i) =>
    xs.slice(i * CHUNK, (i + 1) * CHUNK)
  );

/**
 * A signal whose episode began longer ago than this is raised in-app and in
 * needs-you only, never pushed: the first tick after an upgrade finds the
 * whole backlog, which must not spend the day's pushes.
 */
export const SIGNAL_BACKLOG_AFTER_MS = 24 * 3_600_000;

export interface SignalCandidate {
  signal: StatusSignal;
  subjectType: TransitionSubjectType;
  subjectId: string;
  facetId: string | null;
  /** The role whose lifecycle it is; null for a kind's own, a goal or a session. */
  role: string | null;
  status: string;
  statusLabel: string;
  category: LifecycleCategory | null;
  episodeKey: string;
  /** When the condition began (ISO). */
  beganAt: string;
  /** A hold's move lens: a goal has no lens of its own. */
  workspaceId?: string | null;
  /** Never pushed, whatever its age: a dev signal's first raise. */
  inAppOnly?: boolean;
  facts: Record<string, unknown>;
}

// ── Noticing ────────────────────────────────────────────────────────────────

/** Stuck, late and nearly-due things of every declared lifecycle. */
async function lifecycleCandidates(now: Date): Promise<SignalCandidate[]> {
  const res = (await db.execute(declaredLifecycleProfilesStatement())) as
    Array<{ profile_id: string }> | { rows: Array<{ profile_id: string }> };
  const declaredIds = (Array.isArray(res) ? res : res.rows).map(
    (r) => r.profile_id
  );
  if (declaredIds.length === 0) return [];
  const declared = await db
    .select({
      id: profiles.id,
      slug: profiles.slug,
      profileKind: profiles.profileKind,
    })
    .from(profiles)
    .where(inArray(profiles.id, declaredIds));
  const resolver = new ProfileResolutionService(db);
  const out: SignalCandidate[] = [];
  for (const p of declared) {
    // One lifecycle that cannot be read must not silence every other one.
    try {
      out.push(...(await profileCandidates(p, resolver, now)));
    } catch (err) {
      logger.error(
        { err, profile: p.slug },
        "status watcher: a lifecycle could not be read — its signals wait for the next tick"
      );
    }
  }
  return out;
}

async function profileCandidates(
  p: { id: string; slug: string; profileKind: string },
  resolver: ProfileResolutionService,
  now: Date
): Promise<SignalCandidate[]> {
  const lifecycle = await resolver.getEffectiveLifecycle(p.id, null);
  if (!lifecycle) return [];
  const stuck = stuckAfterDaysOf(lifecycle.options);
  const dated = dateBindingsOf(lifecycle.options);
  if (stuck.size === 0 && dated.size === 0) return [];
  const isRole = p.profileKind === "role";
  const subject: StatusGroupSubject = isRole
    ? { kind: "role", profileIds: [p.id], roleSlug: p.slug }
    : { kind: "kind", profileIds: [p.id] };
  const base = (i: { id: string; facetId: string | null; status: string }) => {
    const option = findLifecycleOption(lifecycle, i.status);
    return {
      subjectType: "entity" as const,
      subjectId: i.id,
      facetId: i.facetId,
      role: isRole ? p.slug : null,
      status: i.status,
      statusLabel: option ? lifecycleOptionLabel(option) : i.status,
      category: option?.category ?? null,
    };
  };
  const out: SignalCandidate[] = [];

  if (stuck.size > 0) {
    const rules = [...stuck].map(([status, days]) => ({ status, days }));
    // Only the things stuck by a rule, filtered in SQL (the board's own
    // time-in-step read and the same predicate its stuck count uses).
    for (const i of await allThings(subject, [...stuck.keys()], [], rules)) {
      const afterDays = i.status ? stuck.get(i.status) : undefined;
      const forDays = stuckForDays(i.since, afterDays, now.getTime());
      if (!i.status || afterDays === undefined || forDays === null) continue;
      out.push({
        ...base({ ...i, status: i.status }),
        signal: "stuck",
        episodeKey: `${i.status}:${i.since}`,
        beganAt: new Date(
          Date.parse(i.since) + afterDays * DAY_MS
        ).toISOString(),
        facts: { since: i.since, afterDays, forDays },
      });
    }
  }

  if (dated.size > 0) {
    // A superset in SQL (the date's day is not after the approaching
    // horizon), compared as text so a bad value is skipped, never cast; the
    // exact rule is `dateSignalOf` below.
    // +1 day: a timestamp with a positive offset carries a later local date
    // than the UTC day it falls due on.
    const horizon = new Date(
      now.getTime() + (DATE_APPROACHING_DAYS + 1) * DAY_MS
    )
      .toISOString()
      .slice(0, 10);
    const statusCol = isRole ? entityFacets.status : entities.status;
    const valueOf = (prop: string) =>
      isRole
        ? drizzleSql`coalesce(${entityFacets.properties}->>${prop}::text, ${entities.properties}->>${prop}::text)`
        : drizzleSql`(${entities.properties}->>${prop}::text)`;
    const dueSoon = drizzleSql`(${drizzleSql.join(
      [...dated].map(
        ([status, prop]) =>
          drizzleSql`(${statusCol} = ${status} AND left(${valueOf(prop)}, 10) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' AND left(${valueOf(prop)}, 10) <= ${horizon})`
      ),
      drizzleSql` OR `
    )})`;
    const items = await allThings(subject, [...dated.keys()], [dueSoon]);
    const dates = await boundDates(isRole, items, dated);
    for (const i of items) {
      const property = i.status ? dated.get(i.status) : undefined;
      const value = dates.get(i.facetId ?? i.id);
      const date = property ? dateSignalOf(value, now.getTime()) : null;
      if (!i.status || !property || !date) continue;
      out.push({
        ...base({ ...i, status: i.status }),
        signal: date.signal,
        episodeKey: `${i.status}:${i.since}:${String(value)}`,
        // A thing that entered the step after its date came due began then.
        beganAt:
          Date.parse(i.since) > Date.parse(date.beganAt)
            ? i.since
            : date.beganAt,
        facts: { property, date: value, dueAt: date.dueAt, since: i.since },
      });
    }
  }
  return out;
}

/** Every thing of `subject` in `statuses` that passes the filters, paged. */
async function allThings(
  subject: StatusGroupSubject,
  statuses: string[],
  conditions: SQL[],
  stuckRules?: Array<{ status: string; days: number }>
) {
  const items: Awaited<ReturnType<typeof pageThingsInColumn>>["items"] = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await pageThingsInColumn({
      subject,
      // No viewer: the owner is told about their own thing. THE listing rule
      // still holds (no probe, no demo rows).
      conditions: [listableEntityWhere({}), ...conditions],
      order: "time_in_column",
      column: { statuses },
      stuckRules,
      offset,
      limit: PAGE,
    });
    items.push(...page.items);
    if (!page.hasMore) return items;
  }
}

/** The bound date of each thing (its facet's property for a role, else its own). */
async function boundDates(
  isRole: boolean,
  items: ReadonlyArray<{
    id: string;
    facetId: string | null;
    status: string | null;
  }>,
  dated: Map<string, string>
): Promise<Map<string, unknown>> {
  const out = new Map<string, unknown>();
  for (const part of chunks(items)) {
    for (const [k, v] of await boundDatesOf(isRole, part, dated)) out.set(k, v);
  }
  return out;
}

async function boundDatesOf(
  isRole: boolean,
  items: ReadonlyArray<{
    id: string;
    facetId: string | null;
    status: string | null;
  }>,
  dated: Map<string, string>
): Promise<Map<string, unknown>> {
  const out = new Map<string, unknown>();
  if (items.length === 0) return out;
  const props = [...new Set(dated.values())];
  const pick = (col: unknown) =>
    drizzleSql`jsonb_build_object(${drizzleSql.join(
      props.map((k) => drizzleSql`${k}::text, ${col}->(${k}::text)`),
      drizzleSql`, `
    )})`;
  const rows = isRole
    ? await db
        .select({
          key: entityFacets.id,
          own: drizzleSql<
            Record<string, unknown>
          >`${pick(entityFacets.properties)}`,
          parent: drizzleSql<
            Record<string, unknown>
          >`${pick(entities.properties)}`,
        })
        .from(entityFacets)
        .innerJoin(entities, eq(entities.id, entityFacets.entityId))
        .where(
          inArray(
            entityFacets.id,
            items.map((i) => i.facetId).filter((v): v is string => !!v)
          )
        )
    : await db
        .select({
          key: entities.id,
          own: drizzleSql<
            Record<string, unknown>
          >`${pick(entities.properties)}`,
          parent: drizzleSql<Record<string, unknown>>`'{}'::jsonb`,
        })
        .from(entities)
        .where(
          inArray(
            entities.id,
            items.map((i) => i.id)
          )
        );
  const statusOf = new Map(items.map((i) => [i.facetId ?? i.id, i.status]));
  for (const r of rows) {
    const property = dated.get(statusOf.get(r.key) ?? "");
    if (!property) continue;
    out.set(r.key, r.own?.[property] ?? r.parent?.[property] ?? null);
  }
  return out;
}

/** Things still paused past their hold's review date. */
async function holdCandidates(now: Date): Promise<SignalCandidate[]> {
  const holds = await listHolds(db, { reviewDueBy: now }, now);
  // An entity's hold obeys THE listing rule, like every other signal.
  const entityIds = holds
    .filter((h) => h.subjectType === "entity")
    .map((h) => h.subjectId);
  const listed = new Set<string>();
  for (const part of chunks(entityIds)) {
    for (const r of await db
      .select({ id: entities.id })
      .from(entities)
      .where(
        and(
          inArray(entities.id, part),
          isNull(entities.deletedAt),
          listableEntityWhere({})
        )
      ))
      listed.add(r.id);
  }
  return holds
    .filter((h) => h.subjectType !== "entity" || listed.has(h.subjectId))
    .map((h: CurrentHold) => ({
      signal: "hold_review_due" as const,
      subjectType: h.subjectType,
      subjectId: h.subjectId,
      facetId: h.facetId,
      role: h.role,
      status: h.status,
      statusLabel:
        h.subjectType === "track"
          ? resolveTrackStatusLabel(h.status)
          : resolveStatusLabel(h.status),
      category: "paused" as const,
      episodeKey: `${h.transitionId}:${h.hold.reviewBy}`,
      beganAt: h.hold.reviewBy as string,
      workspaceId: h.workspaceId,
      facts: {
        reviewBy: h.hold.reviewBy,
        pausedSince: h.hold.since,
        holdOn: h.hold.on,
        holdRef: h.hold.ref ?? null,
        holdReason: h.hold.reason ?? null,
      },
    }));
}

/**
 * Dev work standing still (`dev-signals.ts`): the newest snapshot of each
 * repo, the open `main red: …` sessions that own a red main, then each signal
 * on its session — only a session the snapshot's poster may read (a fact
 * names only work its producer can see). `unrouted` counts a red main whose
 * culprit names no session: nobody to tell, never a guess.
 */
async function devCandidates(
  now: Date,
  result: { unrouted: number }
): Promise<SignalCandidate[]> {
  const repoOf = drizzleSql`lower(${events.data}->>'repo')`;
  const rows = await db
    .selectDistinctOn([repoOf], {
      id: events.id,
      data: events.data,
      userId: events.userId,
    })
    .from(events)
    .where(
      and(
        eq(events.type, DEV_LOOP_EVENT_TYPES.repoSnapshot),
        gte(events.timestamp, new Date(now.getTime() - SNAPSHOT_LOOKBACK_MS))
      )
    )
    .orderBy(repoOf, desc(events.timestamp));
  if (rows.length === 0) return [];
  const owners = await db
    .select({ title: focusSessions.title })
    .from(focusSessions)
    .where(
      and(
        ilike(focusSessions.title, "main red:%"),
        notInArray(focusSessions.status, [...TERMINAL_SESSION_STATUSES])
      )
    );
  const ownedMains = mainRedOwnedRepos(owners.map((o) => o.title));

  const byPoster = new Map<string, DevSignalCandidate[]>();
  for (const row of rows) {
    const parsed = repoSnapshotEventSchema.safeParse(row.data);
    if (!parsed.success) {
      logger.warn(
        { eventId: row.id },
        "status watcher: a dev.repo_snapshot no longer parses — its dev signals are skipped"
      );
      continue;
    }
    for (const d of devSignalsOf(parsed.data, { now, ownedMains })) {
      if (!d.sessionId) {
        result.unrouted++;
        continue;
      }
      byPoster.set(row.userId, [...(byPoster.get(row.userId) ?? []), d]);
    }
  }

  const out: SignalCandidate[] = [];
  for (const [poster, ds] of byPoster) {
    const ids = [...new Set(ds.map((d) => d.sessionId!))];
    const sessions = new Map<string, string>();
    for (const part of chunks(ids)) {
      for (const s of await db
        .select({ id: focusSessions.id, status: focusSessions.status })
        .from(focusSessions)
        .where(
          and(
            inArray(focusSessions.id, part),
            sessionReadableWhere({ userId: poster, roster: true })
          )
        ))
        sessions.set(s.id, s.status);
    }
    for (const d of ds) {
      const status = sessions.get(d.sessionId!);
      if (status === undefined) continue;
      out.push({
        signal: d.signal,
        subjectType: "focus_session",
        subjectId: d.sessionId!,
        facetId: null,
        role: null,
        status,
        statusLabel: resolveStatusLabel(status),
        category: null,
        episodeKey: d.episodeKey,
        beganAt: d.beganAt,
        inAppOnly: !d.escalated,
        facts: { ...d.facts, escalated: d.escalated },
      });
    }
  }
  return out;
}

// ── Where it sits, who is told ──────────────────────────────────────────────

interface Place {
  name: string;
  workspaceId: string | null;
  /** The entity's kind, for the event's `profileSlug`. */
  profileSlug: string | null;
  projectId: string | null;
  trackId: string | null;
  /** Who the thing belongs to (a person or an agent). */
  holderId: string;
}

const keyOf = (c: Pick<SignalCandidate, "subjectType" | "subjectId">) =>
  `${c.subjectType}:${c.subjectId}`;

/** Name, lens, goal, project and holder of each subject. Batched. */
async function resolvePlaces(
  cs: readonly SignalCandidate[]
): Promise<Map<string, Place>> {
  const ids = (t: TransitionSubjectType) => [
    ...new Set(cs.filter((c) => c.subjectType === t).map((c) => c.subjectId)),
  ];
  const out = new Map<string, Place>();

  const entityIds = ids("entity");
  if (entityIds.length) {
    const rows = await db
      .select({
        id: entities.id,
        title: entities.title,
        userId: entities.userId,
        workspaceId: entities.workspaceId,
        kind: profiles.slug,
      })
      .from(entities)
      .leftJoin(profiles, eq(profiles.id, entities.profileId))
      .where(and(inArray(entities.id, entityIds), isNull(entities.deletedAt)));
    // Its goal: the newest goal-filed session about it (the subject spine).
    const goals = await db
      .selectDistinctOn([focusSessions.subjectEntityId], {
        entityId: focusSessions.subjectEntityId,
        trackId: focusSessions.trackId,
        projectId: focusSessions.projectId,
      })
      .from(focusSessions)
      .where(
        and(
          inArray(focusSessions.subjectEntityId, entityIds),
          isNotNull(focusSessions.trackId)
        )
      )
      .orderBy(focusSessions.subjectEntityId, desc(focusSessions.createdAt));
    // Else its project: the oldest `belongs_to_project` edge.
    const filed = await db
      .selectDistinctOn([relations.sourceEntityId], {
        entityId: relations.sourceEntityId,
        projectId: relations.targetEntityId,
      })
      .from(relations)
      .where(
        and(
          inArray(relations.sourceEntityId, entityIds),
          eq(relations.type, BELONGS_TO_PROJECT)
        )
      )
      .orderBy(relations.sourceEntityId, relations.createdAt);
    const goalOf = new Map(goals.map((g) => [g.entityId, g]));
    const projectOf = new Map(filed.map((f) => [f.entityId, f.projectId]));
    for (const r of rows) {
      const g = goalOf.get(r.id);
      out.set(`entity:${r.id}`, {
        name: r.title?.trim() || resolveObjectNoun(r.kind),
        workspaceId: r.workspaceId ?? null,
        profileSlug: r.kind ?? null,
        trackId: g?.trackId ?? null,
        projectId: g?.projectId ?? projectOf.get(r.id) ?? null,
        holderId: r.userId,
      });
    }
  }

  const trackIds = ids("track");
  if (trackIds.length) {
    for (const t of await db
      .select({
        id: projectTracks.id,
        name: projectTracks.name,
        projectId: projectTracks.projectId,
        userId: projectTracks.userId,
      })
      .from(projectTracks)
      .where(inArray(projectTracks.id, trackIds))) {
      out.set(`track:${t.id}`, {
        name: t.name,
        workspaceId: null,
        profileSlug: null,
        trackId: t.id,
        projectId: t.projectId,
        holderId: t.userId,
      });
    }
  }

  const sessionIds = ids("focus_session");
  if (sessionIds.length) {
    for (const s of await db
      .select({
        id: focusSessions.id,
        title: focusSessions.title,
        goal: focusSessions.goal,
        userId: focusSessions.userId,
        workspaceId: focusSessions.workspaceId,
        projectId: focusSessions.projectId,
        trackId: focusSessions.trackId,
      })
      .from(focusSessions)
      .where(inArray(focusSessions.id, sessionIds))) {
      out.set(`focus_session:${s.id}`, {
        name: resolveSessionTitle(s),
        workspaceId: s.workspaceId ?? null,
        profileSlug: null,
        trackId: s.trackId ?? null,
        projectId: s.projectId ?? null,
        holderId: s.userId,
      });
    }
  }
  return out;
}

/**
 * WHO IS TOLD: the thing's owner when that is a person, else its goal's owner
 * (a goal's own signal goes to its owner) — and only a PERSON who can read
 * the thing. Anyone else: `null`, nobody is told (the event is still raised).
 */
async function recipientsOf(
  cs: readonly SignalCandidate[],
  places: Map<string, Place>
): Promise<Map<string, string | null>> {
  const goalIds = [
    ...new Set(
      cs.flatMap((c) => {
        const p = places.get(keyOf(c));
        return c.subjectType === "track"
          ? [c.subjectId]
          : p?.trackId
            ? [p.trackId]
            : [];
      })
    ),
  ];
  const [tracks, owners] = goalIds.length
    ? await Promise.all([
        db
          .select({ id: projectTracks.id, userId: projectTracks.userId })
          .from(projectTracks)
          .where(inArray(projectTracks.id, goalIds)),
        db
          .select()
          .from(trackParticipants)
          .where(
            and(
              inArray(trackParticipants.trackId, goalIds),
              eq(trackParticipants.role, "owner")
            )
          ),
      ])
    : [[], []];
  const goalOwnerOf = new Map(
    tracks.map((t) => [
      t.id,
      goalOwner(
        owners.filter((o) => o.trackId === t.id),
        t
      ),
    ])
  );
  const candidates = [
    ...new Set([
      ...[...places.values()].map((p) => p.holderId),
      ...goalOwnerOf.values(),
    ]),
  ];
  const people = new Set(
    candidates.length
      ? (
          await db
            .select({ id: users.id })
            .from(users)
            .where(
              and(inArray(users.id, candidates), eq(users.userType, "human"))
            )
        ).map((u) => u.id)
      : []
  );

  // The person each subject would go to, before the read check.
  const chosen = new Map<string, string>();
  for (const c of cs) {
    const key = keyOf(c);
    const place = places.get(key);
    if (!place || chosen.has(key)) continue;
    const person =
      c.subjectType === "track"
        ? goalOwnerOf.get(c.subjectId)
        : people.has(place.holderId)
          ? place.holderId
          : place.trackId
            ? goalOwnerOf.get(place.trackId)
            : undefined;
    if (person && people.has(person)) chosen.set(key, person);
  }

  // …and only if they can read it (the same rules `statusOf` reads by).
  const readable = new Set<string>();
  const byPerson = new Map<string, string[]>();
  for (const [key, person] of chosen) {
    byPerson.set(person, [...(byPerson.get(person) ?? []), key]);
  }
  for (const [person, keys] of byPerson) {
    const of = (t: string) =>
      keys
        .filter((k) => k.startsWith(`${t}:`))
        .map((k) => k.slice(t.length + 1));
    const [es, ts, ss] = [of("entity"), of("track"), of("focus_session")];
    const [eRows, tRows, sRows] = await Promise.all([
      es.length
        ? db
            .select({ id: entities.id })
            .from(entities)
            .where(
              and(inArray(entities.id, es), entityReadVisibleWhere(person))
            )
        : [],
      ts.length
        ? scopedDb(
            AccessContext.operator({ userId: person })
          ).findMany<ProjectTrack>(projectTracks, {
            where: inArray(projectTracks.id, ts),
          })
        : [],
      ss.length
        ? db
            .select({ id: focusSessions.id })
            .from(focusSessions)
            .where(
              and(
                inArray(focusSessions.id, ss),
                sessionReadableWhere({ userId: person, roster: true })
              )
            )
        : [],
    ]);
    for (const r of eRows) readable.add(`entity:${r.id}`);
    for (const r of tRows) readable.add(`track:${r.id}`);
    for (const r of sRows) readable.add(`focus_session:${r.id}`);
  }
  return new Map(
    [...places.keys()].map((key) => [
      key,
      readable.has(key) ? (chosen.get(key) ?? null) : null,
    ])
  );
}

// ── The words ───────────────────────────────────────────────────────────────

const days = (n: number) => (n === 1 ? "1 day" : `${n} days`);
const dateWords = (v: unknown) => {
  const day = String(v ?? "").slice(0, 10);
  return shortDate(day) ?? day;
};

/** The notification's two lines; every detail ends with a next step. */
export function signalWords(
  c: Pick<SignalCandidate, "signal" | "statusLabel" | "facts">,
  name: string,
  now: Date = new Date()
): { headline: string; detail: string } {
  const f = c.facts;
  const property = humanizeToken(String(f.property ?? "")).toLowerCase();
  switch (c.signal) {
    case "late":
      return {
        headline: `${name} is late`,
        detail: `The ${property} was ${dateWords(f.date)} and the status is still ${c.statusLabel}. Update it or move it on.`,
      };
    case "approaching": {
      // Whole calendar days from today to the due day (UTC).
      const ahead = Math.round(
        (Date.parse(String(f.date).slice(0, 10)) -
          Date.parse(now.toISOString().slice(0, 10))) /
          DAY_MS
      );
      return {
        headline:
          ahead <= 0
            ? `${name} is due today`
            : ahead === 1
              ? `${name} is due tomorrow`
              : `${name} is due in ${days(ahead)}`,
        detail: `The ${property} is ${dateWords(f.date)} and the status is still ${c.statusLabel}. Move it on before then.`,
      };
    }
    case "stuck":
      return {
        headline: `${name} has been in ${c.statusLabel} for ${days(Number(f.forDays))}`,
        detail: `This step usually moves on within ${days(Number(f.afterDays))}. Move it on, or pause it with a reason.`,
      };
    case "hold_review_due":
      return {
        headline: `${name} has been paused longer than planned`,
        detail: `Paused since ${dateWords(f.pausedSince)}${f.holdReason ? `: ${String(f.holdReason)}` : ""}. Resume it, or note what it is still waiting on.`,
      };
    // Dev work (`dev-signals.ts`): `label` names the PR or main, `name` the
    // session that owns it.
    case "pr_green_unmerged":
      return {
        headline: `${String(f.label)} is green and not merged`,
        detail: `${name}: its checks passed and nothing has changed it for ${formatElapsed(String(f.since), now.getTime())}. Find what holds the merge, or pause the session with a reason.`,
      };
    case "pr_red_idle":
      return {
        headline: `${String(f.label)} has been red for ${formatElapsed(String(f.since), now.getTime())} with no push`,
        detail: `${name}: fix it and push once, or hand it over.`,
      };
    case "main_red_unowned":
      return {
        headline: `${String(f.label)} has been red for ${formatElapsed(String(f.since), now.getTime())} and nobody owns the fix`,
        detail: `${f.culpritLabel ? `It turned red with ${String(f.culpritLabel)}` : "It turned red"}${f.reason ? `: ${String(f.reason)}` : ""}. Own it with a session titled "main red: ${String(f.repo).split("/").pop()} …", or name the PR that fixes it.`,
      };
  }
}

// ── Raising ─────────────────────────────────────────────────────────────────

/** Each subject's registry type and source — `type:` written out for the producer scan. */
const SIGNAL_NOTIFICATION = {
  entity: { type: "entity.signal", sourceType: "entity" },
  track: { type: "track.signal", sourceType: "track" },
  focus_session: { type: "session.signal", sourceType: "session" },
} as const satisfies Record<
  TransitionSubjectType,
  { type: string; sourceType: string }
>;

export interface StatusWatcherResult {
  /** Open episodes seen this tick, new or not. */
  noticed: number;
  /** Episodes raised this tick. */
  raised: number;
  /** Raised with nobody to tell. */
  unowned: number;
  /** Dev signals that name no session to raise on (a red main's culprit unknown). */
  unrouted: number;
  /** Wait episodes opened and closed this tick (null: their write failed). */
  waitEpisodes: { opened: number; closed: number; unread: number } | null;
}

/** One tick. A read that fails is logged and skipped, never the whole tick. */
export async function runStatusWatcher(
  now: Date = new Date()
): Promise<StatusWatcherResult> {
  const read = (what: string, p: Promise<SignalCandidate[]>) =>
    p.catch((err) => {
      logger.error(
        { err },
        `status watcher: ${what} could not be read — their signals wait for the next tick`
      );
      return [] as SignalCandidate[];
    });
  const dev = { unrouted: 0 };
  const noticed = [
    ...(await read("lifecycles", lifecycleCandidates(now))),
    ...(await read("holds", holdCandidates(now))),
    ...(await read("dev work", devCandidates(now, dev))),
  ];
  // Wait episodes first: a failure there is logged, never the signals'.
  const waitEpisodes = await syncWaitEpisodesTick(
    now,
    noticed.map((c) => ({
      subjectType: c.subjectType,
      subjectId: c.subjectId,
      facetId: c.facetId,
    }))
  ).catch((err) => {
    logger.error(
      { err },
      "status watcher: wait episodes could not be written — they catch up on the next tick"
    );
    return null;
  });
  const claims = await claimStatusSignals(
    db,
    noticed.map((c) => ({
      subjectType: c.subjectType,
      subjectId: c.facetId ?? c.subjectId,
      signal: c.signal,
      episodeKey: c.episodeKey,
      candidate: c,
    }))
  );
  const result: StatusWatcherResult = {
    noticed: noticed.length,
    raised: 0,
    unowned: 0,
    unrouted: dev.unrouted,
    waitEpisodes,
  };
  if (claims.length === 0) return result;

  // Every claim this tick does not raise is given back — whatever throws — so
  // the next tick raises it; a claim kept for an unraised episode loses it.
  const raised = new Set<(typeof claims)[number]>();
  try {
    // In chunks, so every `IN (…)` list downstream stays bounded.
    for (const part of chunks(claims)) {
      const fresh = part.map((e) => e.candidate);
      const places = await resolvePlaces(fresh);
      const recipients = await recipientsOf(fresh, places);
      for (const claim of part) {
        const c = claim.candidate;
        const place = places.get(keyOf(c));
        if (!place) continue; // deleted since it was read
        const ownerId = recipients.get(keyOf(c)) ?? null;
        try {
          await raise(c, place, ownerId, now);
          raised.add(claim);
          result.raised++;
          if (!ownerId) result.unowned++;
        } catch (err) {
          logger.warn(
            {
              err,
              signal: c.signal,
              subjectType: c.subjectType,
              subjectId: c.subjectId,
            },
            "status signal not raised — its claim is given back, so the next tick raises it"
          );
        }
      }
    }
  } finally {
    for (const claim of claims) {
      if (raised.has(claim)) continue;
      await releaseStatusSignal(db, claim as StatusSignalEpisode).catch((err) =>
        logger.error(
          { err, signal: claim.signal, subjectId: claim.subjectId },
          "status signal claim not given back — this episode will not be raised"
        )
      );
    }
  }
  if (result.raised > 0) logger.info(result, "Status signals raised");
  return result;
}

/** Log the episode, fan it out, tell the owner. A throw means nothing was logged. */
async function raise(
  c: SignalCandidate,
  place: Place,
  ownerId: string | null,
  now: Date
): Promise<void> {
  const eventId = randomUUID();
  const workspaceId = place.workspaceId ?? c.workspaceId ?? null;
  // The person the event is about: who is told, else the thing's holder
  // (possibly an agent). `source: "system"` records that the watcher raised it.
  const userId = ownerId ?? place.holderId;
  // The words travel with the event: the session feed (`signal_raised`)
  // hands them to the agent as the person reads them.
  const words = signalWords(c, place.name, now);
  const data = {
    signal: c.signal,
    subjectType: c.subjectType,
    subjectId: c.subjectId,
    facetId: c.facetId,
    role: c.role,
    lifecycleProfile: c.role ?? place.profileSlug,
    status: c.status,
    category: c.category,
    ownerId,
    projectId: place.projectId,
    trackId: place.trackId,
    beganAt: c.beganAt,
    ...c.facts,
    headline: words.headline,
    detail: words.detail,
  };
  await new EventRepository(sql).append({
    id: eventId,
    version: "v1",
    type: `${c.subjectType}.signal.completed`,
    subjectId: c.subjectId,
    subjectType: c.subjectType,
    data,
    metadata: {},
    userId,
    workspaceId: workspaceId ?? undefined,
    source: "system",
    timestamp: now,
  } as Parameters<EventRepository["append"]>[0]);
  await emitSideEffects({
    subjectType: c.subjectType,
    action: "signal",
    subjectId: c.subjectId,
    userId,
    workspaceId,
    eventId,
    data: { ...data, profileSlug: place.profileSlug },
  });
  // Realtime: `status:signal:raised` to each user who may read this status
  // (statusOf's floor, `status-realtime.ts`). Fire-and-forget; never throws.
  void pushStatusSignal({
    signal: c.signal,
    subjectType: c.subjectType,
    subjectId: c.subjectId,
    facetId: c.facetId,
    role: c.role,
    beganAt: c.beganAt,
    raisedAt: now,
  });
  if (!ownerId) return;
  const { type, sourceType } = SIGNAL_NOTIFICATION[c.subjectType];
  // `create` logs its own failures and does not throw: a lost notification is
  // logged there, and not retried (the episode is raised).
  await NotificationService.create({
    type,
    userId: ownerId,
    workspaceId,
    sourceType,
    sourceId: c.subjectId,
    // One needs-you row per signal and kind of thing ("and 4 more like it").
    groupKey: `status-signal:${c.signal}:${c.role ?? place.profileSlug ?? c.subjectType}`,
    inAppOnly:
      c.inAppOnly === true ||
      now.getTime() - Date.parse(c.beganAt) > SIGNAL_BACKLOG_AFTER_MS,
    data: words,
  });
}
