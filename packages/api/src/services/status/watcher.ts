/**
 * THE STATUS WATCHER (status-flow plan W6) — the proactive layer. Every hour
 * (`@synap/jobs` `status-watcher` cron, this runner filled at boot) it notices
 * what is late, close to its date, stuck in its step, or paused past its
 * review date, and says so ONCE per episode:
 *
 *   1. the derived event `<subjectType>.signal.completed` — only signals, the
 *      thing an automation triggers on (plan Q6.2) — with the goal and project
 *      resolved now (Q6.3). Automations react under the existing governance;
 *      nothing here acts on a thing (Q4.3);
 *   2. a notification to the thing's owner, else its goal's owner (Q4.2),
 *      through the ONE notification door: an item in needs-you while unread,
 *      a push under `late-or-stuck` inside the daily cap (Q4.1).
 *
 * Every rule comes from an existing reader, never re-derived: stuck = the
 * step's `stuckAfterDays` (`stuckAfterDaysOf` + `stuckForDays`) over the
 * board's own time-in-column read (`pageThingsInColumn`, since = the latest
 * move's `occurredAt`); late / approaching = the step's `dateBinding`
 * (`dateBindingsOf` + `dateSignalOf`, calendar time); hold review = `listHolds`.
 *
 * EPISODE. The event's id is derived from (signal, subject, anchor), and the
 * anchor is what changes when an episode ends: when the thing entered its step
 * (a move out and back is a new stay), the bound date (a new date is a new
 * deadline), the pause's own transition and review date. The event is dated
 * when its condition BEGAN (`beganAt`: the date fell due, the stuck threshold
 * passed…), so the events table's primary key (id, timestamp) is the episode
 * store: an hour later the same episode derives the same row and is skipped
 * (refused by the key even if two ticks race); after it clears and recurs the
 * anchor differs and it is raised again. No table of its own. Residual,
 * stated: a crash between the log row and the fan-out loses that episode's
 * fan-out and notification (the log row stands, so it is not raised twice).
 */
import {
  and,
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
  inArray,
  isNotNull,
  isUniqueViolation,
  listableEntityWhere,
  listHolds,
  profiles,
  ProfileResolutionService,
  projectTracks,
  relations,
  sql,
  users,
  type CurrentHold,
} from "@synap/database";
import { emitSideEffects } from "@synap/events";
import { createLogger } from "@synap-core/core";
import {
  dateSignalOf,
  findLifecycleOption,
  lifecycleOptionLabel,
  type LifecycleCategory,
  type StatusSignal,
  type TransitionSubjectType,
} from "@synap-core/types/lifecycle";
import {
  humanizeToken,
  resolveObjectNoun,
  resolveStatusLabel,
  resolveTrackStatusLabel,
} from "@synap-core/types/vocabulary";
import { resolveSessionTitle } from "@synap-core/types/focus-sessions";
import { NotificationService } from "../../notifications/NotificationService.js";
import { deterministicUuidFromKey } from "../../utils/write-door-idempotency.js";
import { goalOwnerToAsk } from "../tracks/goal-content.js";
import { BELONGS_TO_PROJECT } from "../../utils/project-scope.js";
import {
  dateBindingsOf,
  pageThingsInColumn,
  stuckAfterDaysOf,
  stuckForDays,
  type StatusGroupSubject,
} from "../lifecycle/status-groups.js";

const logger = createLogger({ module: "status-watcher" });

/** Things read per page, and at most per lifecycle per tick (logged when hit). */
const PAGE = 500;
const MAX_PER_LIFECYCLE = 5_000;
/** Episode ids checked against the log per query. */
const ID_BATCH = 500;

/** One thing the watcher noticed, before it is resolved and raised. */
export interface SignalCandidate {
  signal: StatusSignal;
  subjectType: TransitionSubjectType;
  subjectId: string;
  /** A role's lifecycle lives on its facet. */
  facetId: string | null;
  /** The role whose lifecycle it is; null for the kind's own (or a goal / session). */
  role: string | null;
  status: string;
  /** The status's words. */
  statusLabel: string;
  category: LifecycleCategory | null;
  /** What ends the episode when it changes (see the header). */
  anchor: string;
  /** When the condition began (ISO) — the event's time; derived, so stable. */
  beganAt: string;
  /** The facts of this signal, carried on the event. */
  facts: Record<string, unknown>;
  /** The thing's name, when the read already had it. */
  name?: string | null;
  /** The lens of a hold's move: a goal has no lens of its own. */
  workspaceId?: string | null;
}

/** The event id of a candidate's episode: same episode, same id. */
export function signalEpisodeId(c: SignalCandidate): string {
  return deterministicUuidFromKey(
    `status-signal:${c.signal}:${c.subjectType}:${c.facetId ?? c.subjectId}:${c.anchor}`
  );
}

// ── Noticing ────────────────────────────────────────────────────────────────

/** Stuck, late and approaching things of every declared lifecycle. */
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
    const lifecycle = await resolver.getEffectiveLifecycle(p.id, null);
    if (!lifecycle) continue;
    const stuck = stuckAfterDaysOf(lifecycle.options);
    const dated = dateBindingsOf(lifecycle.options);
    if (stuck.size === 0 && dated.size === 0) continue;
    const isRole = p.profileKind === "role";
    const subject: StatusGroupSubject = isRole
      ? { kind: "role", profileIds: [p.id], roleSlug: p.slug }
      : { kind: "kind", profileIds: [p.id] };
    const items = await thingsIn(subject, [
      ...new Set([...stuck.keys(), ...dated.keys()]),
    ]);
    const dates = await boundDates(
      isRole,
      items.filter((i) => i.status && dated.has(i.status)),
      dated
    );
    for (const i of items) {
      if (!i.status) continue;
      const option = findLifecycleOption(lifecycle, i.status);
      const base = {
        subjectType: "entity" as const,
        subjectId: i.id,
        facetId: i.facetId,
        role: isRole ? p.slug : null,
        status: i.status,
        statusLabel: option ? lifecycleOptionLabel(option) : i.status,
        category: option?.category ?? null,
        name: i.name,
      };
      const afterDays = stuck.get(i.status);
      const forDays = stuckForDays(i.since, afterDays, now.getTime());
      if (afterDays !== undefined && forDays !== null) {
        out.push({
          ...base,
          signal: "stuck",
          anchor: i.since,
          beganAt: new Date(
            Date.parse(i.since) + afterDays * 86_400_000
          ).toISOString(),
          facts: { since: i.since, afterDays, forDays },
        });
      }
      const property = dated.get(i.status);
      const value = dates.get(i.facetId ?? i.id);
      const date = property ? dateSignalOf(value, now.getTime()) : null;
      if (property && date) {
        out.push({
          ...base,
          signal: date.signal,
          anchor: `${i.since}:${String(value)}`,
          beganAt: date.beganAt,
          facts: { property, date: value, dueAt: date.dueAt, since: i.since },
        });
      }
    }
  }
  return out;
}

/** The things of `subject` in `statuses`, longest in their step first. */
async function thingsIn(subject: StatusGroupSubject, statuses: string[]) {
  const items: Awaited<ReturnType<typeof pageThingsInColumn>>["items"] = [];
  for (let offset = 0; offset < MAX_PER_LIFECYCLE; offset += PAGE) {
    const page = await pageThingsInColumn({
      subject,
      // No viewer: the owner is told about their own thing. THE listing rule
      // still holds (no probe, no demo rows).
      conditions: [listableEntityWhere({})],
      order: "time_in_column",
      column: { statuses },
      offset,
      limit: PAGE,
    });
    items.push(...page.items);
    if (!page.hasMore) return items;
  }
  logger.warn(
    { subject, statuses, read: items.length },
    "status watcher: lifecycle has more things than one tick reads — the rest wait for the next"
  );
  return items;
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

/** Things still paused past their hold's `reviewBy` (plan Q2.2). */
async function holdCandidates(now: Date): Promise<SignalCandidate[]> {
  const holds = await listHolds(db, { reviewDueBy: now }, now);
  return holds.map((h: CurrentHold) => ({
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
    anchor: `${h.transitionId}:${h.hold.reviewBy}`,
    beganAt: new Date(h.hold.reviewBy as string).toISOString(),
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

// ── Resolving: where it sits, who owns it, its name ────────────────────────

interface Place {
  name: string;
  workspaceId: string | null;
  /** The thing's kind (an entity's), for the event's `profileSlug`. */
  profileSlug: string | null;
  projectId: string | null;
  trackId: string | null;
  /** Who the thing belongs to, before the person check. */
  holderId: string;
}

/** Name, lens, goal, project and holder of each candidate's subject. Batched. */
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
      .where(inArray(entities.id, entityIds));
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
 * WHO IS TOLD (plan Q4.2): the thing's owner when that is a person, else its
 * goal's owner (`goalOwnerToAsk`, the one answer to "who is asked about a
 * goal"). A goal's own signal goes to its owner. `null` = nobody to tell (the
 * event is still raised).
 */
async function ownersOf(
  cs: readonly SignalCandidate[],
  places: Map<string, Place>
): Promise<Map<string, string | null>> {
  const holders = [...new Set([...places.values()].map((p) => p.holderId))];
  const people = new Set(
    holders.length
      ? (
          await db
            .select({ id: users.id })
            .from(users)
            .where(and(inArray(users.id, holders), eq(users.userType, "human")))
        ).map((u) => u.id)
      : []
  );
  const goalOwner = new Map<string, Promise<string>>();
  const ownerOfGoal = async (trackId: string) => {
    if (!goalOwner.has(trackId)) {
      goalOwner.set(
        trackId,
        db
          .select({ id: projectTracks.id, userId: projectTracks.userId })
          .from(projectTracks)
          .where(eq(projectTracks.id, trackId))
          .limit(1)
          .then(([t]) => (t ? goalOwnerToAsk(t) : ""))
      );
    }
    return (await goalOwner.get(trackId)!) || null;
  };
  const out = new Map<string, string | null>();
  for (const c of cs) {
    const key = `${c.subjectType}:${c.subjectId}`;
    if (out.has(key)) continue;
    const place = places.get(key);
    if (!place) continue;
    if (c.subjectType === "track") {
      out.set(key, await ownerOfGoal(c.subjectId));
    } else if (people.has(place.holderId)) {
      out.set(key, place.holderId);
    } else {
      out.set(key, place.trackId ? await ownerOfGoal(place.trackId) : null);
    }
  }
  return out;
}

// ── The words ───────────────────────────────────────────────────────────────

/** The notification's two lines for a signal — sentences, built here. */
export function signalWords(
  c: Pick<SignalCandidate, "signal" | "statusLabel" | "facts">,
  name: string,
  now: Date = new Date()
): { headline: string; detail: string } {
  const f = c.facts;
  const status = c.statusLabel.toLowerCase();
  const day = (v: unknown) => String(v ?? "").slice(0, 10);
  switch (c.signal) {
    case "late":
      return {
        headline: `${name} is late`,
        detail: `Its ${humanizeToken(String(f.property)).toLowerCase()} (${day(f.date)}) has passed and it is still ${status}.`,
      };
    case "approaching": {
      const days = Math.max(
        0,
        Math.ceil((Date.parse(String(f.dueAt)) - now.getTime()) / 86_400_000) -
          1
      );
      return {
        headline:
          days === 0
            ? `${name} is due today`
            : `${name} is due in ${days === 1 ? "1 day" : `${days} days`}`,
        detail: `Its ${humanizeToken(String(f.property)).toLowerCase()} is ${day(f.date)} and it is still ${status}.`,
      };
    }
    case "stuck":
      return {
        headline: `${name} has been ${status} for ${f.forDays} days`,
        detail: `Longer than the ${f.afterDays} days this step allows.`,
      };
    case "hold_review_due":
      return {
        headline: `${name} is due for review`,
        detail: `Paused since ${day(f.pausedSince)}${f.holdReason ? ` (${String(f.holdReason)})` : ""}. Resume it, or say what it still waits on.`,
      };
  }
}

// ── Raising ─────────────────────────────────────────────────────────────────

/**
 * The registry type and source of a subject's signal notification — each
 * `type:` written out, so the producer scan sees it (notification registry).
 */
const SIGNAL_NOTIFICATION = {
  entity: { type: "entity.signal", sourceType: "entity" },
  track: { type: "track.signal", sourceType: "track" },
  focus_session: { type: "session.signal", sourceType: "session" },
} as const satisfies Record<
  TransitionSubjectType,
  { type: string; sourceType: string }
>;

export interface StatusWatcherResult {
  /** Signals noticed this tick (open episodes, new or not). */
  noticed: number;
  /** Episodes raised this tick (new events). */
  raised: number;
  /** Raised with nobody to tell (no person owns it or its goal). */
  unowned: number;
}

/** One tick of the watcher. A failed read THROWS (the cron logs it). */
export async function runStatusWatcher(
  now: Date = new Date()
): Promise<StatusWatcherResult> {
  const noticed = [
    ...(await lifecycleCandidates(now)),
    ...(await holdCandidates(now)),
  ];
  const fresh = await notYetRaised(noticed);
  const result: StatusWatcherResult = {
    noticed: noticed.length,
    raised: 0,
    unowned: 0,
  };
  if (fresh.length === 0) return result;

  const places = await resolvePlaces(fresh);
  const owners = await ownersOf(fresh, places);
  for (const c of fresh) {
    const key = `${c.subjectType}:${c.subjectId}`;
    const place = places.get(key);
    if (!place) continue; // deleted since it was read
    const ownerId = owners.get(key) ?? null;
    try {
      if (await raise(c, place, ownerId, now)) {
        result.raised++;
        if (!ownerId) result.unowned++;
      }
    } catch (err) {
      logger.warn(
        {
          err,
          signal: c.signal,
          subjectType: c.subjectType,
          subjectId: c.subjectId,
        },
        "status signal not raised — retried on the next tick"
      );
    }
  }
  if (result.raised > 0) logger.info(result, "Status signals raised");
  return result;
}

/** The candidates whose episode has no log row yet. */
async function notYetRaised(
  cs: readonly SignalCandidate[]
): Promise<SignalCandidate[]> {
  const byId = new Map(cs.map((c) => [signalEpisodeId(c), c]));
  const ids = [...byId.keys()];
  for (let i = 0; i < ids.length; i += ID_BATCH) {
    for (const r of await db
      .select({ id: events.id })
      .from(events)
      .where(inArray(events.id, ids.slice(i, i + ID_BATCH)))) {
      byId.delete(r.id);
    }
  }
  return [...byId.values()];
}

/** Log the episode (once), fan it out, tell the owner. False = already raised. */
async function raise(
  c: SignalCandidate,
  place: Place,
  ownerId: string | null,
  now: Date
): Promise<boolean> {
  const eventId = signalEpisodeId(c);
  // The thing's own lens; a goal has none, so its hold's move lens.
  const workspaceId = place.workspaceId ?? c.workspaceId ?? null;
  // The person the event is about; the system raised it.
  const userId = ownerId ?? place.holderId;
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
    noticedAt: now.toISOString(),
    ...c.facts,
  };
  try {
    await new EventRepository(sql).append({
      // The episode IS the row's id: at most one, ever.
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
      // Dated when it began: the same episode is the same (id, timestamp) row.
      timestamp: new Date(c.beganAt),
    } as Parameters<EventRepository["append"]>[0]);
  } catch (err) {
    if (isUniqueViolation(err)) return false;
    throw err;
  }
  await emitSideEffects({
    subjectType: c.subjectType,
    action: "signal",
    subjectId: c.subjectId,
    userId,
    workspaceId,
    eventId,
    data: { ...data, profileSlug: place.profileSlug },
  });
  if (ownerId) {
    const { type, sourceType } = SIGNAL_NOTIFICATION[c.subjectType];
    await NotificationService.create({
      type,
      userId: ownerId,
      workspaceId,
      sourceType,
      sourceId: c.subjectId,
      // One needs-you row per signal and kind of thing ("and 4 more like it").
      groupKey: `status-signal:${c.signal}:${c.role ?? place.profileSlug ?? c.subjectType}`,
      data: signalWords(c, c.name?.trim() || place.name, now),
    });
  }
  return true;
}
