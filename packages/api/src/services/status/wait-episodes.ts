/**
 * WAIT EPISODES, the watcher's half (status-first PR-H): on each tick, ask THE
 * waiting-on collector (`readWaitingOnSourcesFor`, never a second wait read)
 * what each subject waits on, and hand the answer to the episode writer
 * (`syncWaitEpisodes`, `@synap/database`): a wait found opens an episode, a
 * wait gone closes it.
 *
 * WHICH SUBJECTS: what the tick already reads (the things it noticed a signal
 * on), every open session AND the thing it is about, every current hold, and
 * every subject that still has an open episode (so its episode can close).
 *
 * Each episode records the STATUS its subject stood on when the wait was
 * first found and, for an owed slot, the blocker's name (0408, plan e7f753db
 * §9): what the recurrence scanner groups repeats by. A thing's own episodes
 * count every slot holding it up (`owed.blocking`), so a blocker declared on
 * a session about it is a wait OF THE THING too. A subject is asked as its
 * HOLDER (the thing's owner, a goal's or a session's owner) reads it, under
 * the collector's own floors; a ref the holder may not read stays unnamed.
 *
 * A subject whose read failed keeps its episodes as they were. A session that
 * ended and a deleted thing wait on nothing: their episodes close.
 *
 * In-app history only: nothing here notifies or pushes, and there is no
 * backfill — the first tick after deploy opens what waits now.
 */
import {
  and,
  db,
  entities,
  entityFacets,
  focusSessions,
  inArray,
  isNull,
  listHolds,
  listOpenWaitEpisodeSubjects,
  projectTracks,
  syncWaitEpisodes,
  type WaitEpisodeSeen,
  type WaitEpisodeSubject,
} from "@synap/database";
import { createLogger } from "@synap-core/core";
import type { TransitionSubjectType } from "@synap-core/types/lifecycle";
import {
  OPEN_SESSION_STATUSES,
  TERMINAL_SESSION_STATUSES,
} from "@synap-core/types/focus-sessions";
import {
  waitEpisodeRefKey,
  waitingOnReasonOf,
  waitKindOf,
  type WaitingOnSource,
} from "@synap-core/types/units";
import {
  readWaitingOnSourcesFor,
  sessionWaitingOnQuestion,
  type WaitingOnQuestion,
} from "./status-facts.js";
import { isUuid } from "@synap-core/types/property-render";

const logger = createLogger({ module: "status-wait-episodes" });

/** Subjects per collector call: every `IN (…)` list downstream stays bounded. */
const PER_READ = 500;

const keyOf = (s: WaitEpisodeSubject) =>
  `${s.subjectType}:${s.subjectId}:${s.facetId ?? ""}`;

/**
 * THE question one subject asks the collector. A role's facet asks only its
 * own hold: the entity-wide sources (proposals on it, its blockers) count once,
 * on the entity's own subject.
 */
export function waitEpisodeQuestion(
  s: WaitEpisodeSubject
): WaitingOnQuestion | null {
  switch (s.subjectType as TransitionSubjectType) {
    case "focus_session":
      return sessionWaitingOnQuestion(s.subjectId);
    case "track":
      return {
        blockedNodes: [{ kind: "track", id: s.subjectId }],
        holds: [{ subjectType: "track", subjectId: s.subjectId }],
      };
    case "entity":
      return s.facetId
        ? {
            holds: [
              {
                subjectType: "entity",
                subjectId: s.subjectId,
                facetId: s.facetId,
              },
            ],
          }
        : {
            owed: { blocking: [s.subjectId] },
            proposals: { targetIds: [s.subjectId] },
            blockedNodes: [{ kind: "entity", id: s.subjectId }],
            holds: [{ subjectType: "entity", subjectId: s.subjectId }],
          };
    default:
      return null;
  }
}

/**
 * One collector source as the episode it belongs to. `status` is the status
 * the subject stands on now (written only when the episode opens).
 */
export function waitEpisodeOf(
  subject: WaitEpisodeSubject,
  source: WaitingOnSource,
  status: string | null = null
): WaitEpisodeSeen {
  return {
    ...subject,
    waitKind: waitKindOf(source),
    on: source.kind === "hold" ? source.on : null,
    reason: waitingOnReasonOf(source),
    ref: source.ref ? ({ ...source.ref } as Record<string, unknown>) : null,
    refKey: waitEpisodeRefKey(source.ref),
    status,
    blockerKey:
      source.kind === "owed_slot" ? (source.blockerKey ?? null) : null,
  };
}

/** Who holds each subject, and the status it stands on. */
interface Holder {
  userId: string;
  status: string | null;
}

/**
 * Who reads each subject's waits: its holder, with the status the subject
 * stands on (a role's facet: the facet's). Absent = gone (or ended).
 */
async function holdersOf(
  subjects: readonly WaitEpisodeSubject[]
): Promise<Map<string, Holder>> {
  const ids = (t: TransitionSubjectType) => [
    ...new Set(
      subjects.filter((s) => s.subjectType === t).map((s) => s.subjectId)
    ),
  ];
  const holderOf = new Map<string, Holder>();
  const byId = new Map<string, Holder>();
  for (const part of chunk(ids("entity"))) {
    for (const r of await db
      .select({
        id: entities.id,
        userId: entities.userId,
        status: entities.status,
      })
      .from(entities)
      .where(and(inArray(entities.id, part), isNull(entities.deletedAt))))
      byId.set(`entity:${r.id}`, { userId: r.userId, status: r.status });
  }
  // A role's facet waits in the ROLE's status, not the entity's own.
  const facetIds = [
    ...new Set(subjects.flatMap((s) => (s.facetId ? [s.facetId] : []))),
  ].filter(isUuid);
  const facetStatus = new Map<string, string | null>();
  for (const part of chunk(facetIds)) {
    for (const r of await db
      .select({ id: entityFacets.id, status: entityFacets.status })
      .from(entityFacets)
      .where(inArray(entityFacets.id, part)))
      facetStatus.set(r.id, r.status);
  }
  for (const part of chunk(ids("track"))) {
    for (const r of await db
      .select({
        id: projectTracks.id,
        userId: projectTracks.userId,
        status: projectTracks.status,
      })
      .from(projectTracks)
      .where(inArray(projectTracks.id, part)))
      byId.set(`track:${r.id}`, { userId: r.userId, status: r.status });
  }
  const ended = new Set<string>(TERMINAL_SESSION_STATUSES);
  for (const part of chunk(ids("focus_session"))) {
    for (const r of await db
      .select({
        id: focusSessions.id,
        userId: focusSessions.userId,
        status: focusSessions.status,
      })
      .from(focusSessions)
      .where(inArray(focusSessions.id, part))) {
      if (!ended.has(r.status))
        byId.set(`focus_session:${r.id}`, {
          userId: r.userId,
          status: r.status,
        });
    }
  }
  for (const s of subjects) {
    const holder = byId.get(`${s.subjectType}:${s.subjectId}`);
    if (!holder) continue;
    holderOf.set(
      keyOf(s),
      s.facetId
        ? { ...holder, status: facetStatus.get(s.facetId) ?? null }
        : holder
    );
  }
  return holderOf;
}

function chunk<T>(xs: readonly T[], n = 1_000): T[][] {
  return Array.from({ length: Math.ceil(xs.length / n) }, (_, i) =>
    xs.slice(i * n, (i + 1) * n)
  );
}

export interface WaitEpisodeTickResult {
  opened: number;
  closed: number;
  /** Subjects whose read failed this tick: their episodes were left as they were. */
  unread: number;
}

/**
 * One tick of wait episodes. `noticed`: the subjects the watcher noticed a
 * signal on this tick. THROWS only when the subject list itself cannot be read.
 */
export async function syncWaitEpisodesTick(
  now: Date,
  noticed: readonly WaitEpisodeSubject[]
): Promise<WaitEpisodeTickResult> {
  const [openSessions, holds, open] = await Promise.all([
    db
      .select({
        id: focusSessions.id,
        subjectEntityId: focusSessions.subjectEntityId,
      })
      .from(focusSessions)
      .where(inArray(focusSessions.status, [...OPEN_SESSION_STATUSES])),
    listHolds(db, { current: true }, now),
    listOpenWaitEpisodeSubjects(db),
  ]);
  const subjects = new Map<string, WaitEpisodeSubject>();
  const add = (s: WaitEpisodeSubject) => {
    // Ids only: a malformed id must not fail a whole chunk's read.
    if (isUuid(s.subjectId)) subjects.set(keyOf(s), s);
  };
  for (const s of noticed) add(s);
  for (const s of openSessions) {
    add({ subjectType: "focus_session", subjectId: s.id, facetId: null });
    // The thing the work is about waits on what blocks it (its own episodes).
    if (s.subjectEntityId)
      add({ subjectType: "entity", subjectId: s.subjectEntityId, facetId: null });
  }
  for (const h of holds)
    add({
      subjectType: h.subjectType,
      subjectId: h.subjectId,
      facetId: h.subjectType === "entity" ? h.facetId : null,
    });
  for (const s of open) add(s);

  const all = [...subjects.values()];
  const holders = await holdersOf(all);
  // A gone subject (deleted, ended) is asked and waits on nothing.
  const asked: WaitEpisodeSubject[] = all.filter((s) => !holders.has(keyOf(s)));
  const seen: WaitEpisodeSeen[] = [];
  let unread = 0;

  const byHolder = new Map<string, WaitEpisodeSubject[]>();
  for (const s of all) {
    const holder = holders.get(keyOf(s))?.userId;
    if (holder) byHolder.set(holder, [...(byHolder.get(holder) ?? []), s]);
  }
  for (const [userId, theirs] of byHolder) {
    for (const part of chunk(theirs, PER_READ)) {
      const questions = new Map<string, WaitingOnQuestion>();
      for (const s of part) {
        const q = waitEpisodeQuestion(s);
        if (q) questions.set(keyOf(s), q);
      }
      try {
        const sources = await readWaitingOnSourcesFor(
          { userId, roster: true },
          questions
        );
        for (const s of part) {
          asked.push(s);
          const status = holders.get(keyOf(s))?.status ?? null;
          for (const source of sources.get(keyOf(s)) ?? [])
            seen.push(waitEpisodeOf(s, source, status));
        }
      } catch (err) {
        unread += part.length;
        logger.error(
          { err, subjects: part.length },
          "wait episodes: a waiting-on read failed — these subjects keep their episodes until the next tick"
        );
      }
    }
  }
  const { opened, closed } = await syncWaitEpisodes(db, {
    subjects: asked,
    seen,
    now,
  });
  return { opened, closed, unread };
}
