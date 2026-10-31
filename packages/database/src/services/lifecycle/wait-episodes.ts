/**
 * WAIT EPISODES (0386, status-first PR-H) — the writer and the reader.
 *
 * The status watcher asks THE waiting-on collector what each subject waits on
 * and hands the answer here: {@link syncWaitEpisodes} opens an episode for a
 * wait it had no open one for (INSERT … ON CONFLICT DO NOTHING on the
 * open-episode unique index, so a second tick or a racing one opens nothing)
 * and closes every open episode of an ASKED subject whose wait it no longer
 * finds. A subject the tick could not ask about keeps its episodes open: a
 * failed read is never "the wait ended".
 *
 * Nothing here notifies anyone: an episode is history, not a signal.
 */
import { and, asc, gte, inArray, isNull, or } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { TransitionSubjectType } from "@synap-core/types/lifecycle";
import type { WaitEpisode } from "@synap-core/types/units";
import type * as schema from "../../schema/index.js";
import { statusWaitEpisode } from "../../schema/status-wait-episode.js";

type Db = PostgresJsDatabase<typeof schema>;

/** A thing that may wait: an entity (or one role's facet of it), a goal, a session. */
export interface WaitEpisodeSubject {
  subjectType: string;
  subjectId: string;
  facetId: string | null;
}

/** One wait found this tick, keyed like its episode. */
export interface WaitEpisodeSeen extends WaitEpisodeSubject {
  waitKind: string;
  on: string | null;
  reason: string | null;
  ref: Record<string, unknown> | null;
  /** `waitEpisodeRefKey(ref)` (`@synap-core/types/units`). */
  refKey: string;
}

const BATCH = 500;

const subjectKey = (s: WaitEpisodeSubject) =>
  `${s.subjectType}\u0000${s.subjectId}\u0000${s.facetId ?? ""}`;

const episodeKey = (
  e: WaitEpisodeSubject & { waitKind: string; refKey: string }
) => `${subjectKey(e)}\u0000${e.waitKind}\u0000${e.refKey}`;

/**
 * Open what is newly seen, close what the asked subjects no longer wait on.
 * `seen` outside `subjects` is ignored (it was not asked, so it cannot close).
 */
export async function syncWaitEpisodes(
  db: Db,
  input: {
    subjects: readonly WaitEpisodeSubject[];
    seen: readonly WaitEpisodeSeen[];
    now: Date;
  }
): Promise<{ opened: number; closed: number }> {
  const asked = new Map(input.subjects.map((s) => [subjectKey(s), s]));
  const seen = new Map(
    input.seen
      .filter((e) => asked.has(subjectKey(e)))
      .map((e) => [episodeKey(e), e])
  );
  let opened = 0;
  const fresh = [...seen.values()];
  for (let i = 0; i < fresh.length; i += BATCH) {
    const rows = await db
      .insert(statusWaitEpisode)
      .values(
        fresh.slice(i, i + BATCH).map((e) => ({
          subjectType: e.subjectType,
          subjectId: e.subjectId,
          facetId: e.facetId,
          waitKind: e.waitKind,
          on: e.on,
          reason: e.reason,
          ref: e.ref,
          refKey: e.refKey,
          openedAt: input.now,
        }))
      )
      .onConflictDoNothing()
      .returning({ id: statusWaitEpisode.id });
    opened += rows.length;
  }

  let closed = 0;
  const ids = [...new Set([...asked.values()].map((s) => s.subjectId))];
  for (let i = 0; i < ids.length; i += BATCH) {
    const open = await db
      .select({
        id: statusWaitEpisode.id,
        subjectType: statusWaitEpisode.subjectType,
        subjectId: statusWaitEpisode.subjectId,
        facetId: statusWaitEpisode.facetId,
        waitKind: statusWaitEpisode.waitKind,
        refKey: statusWaitEpisode.refKey,
      })
      .from(statusWaitEpisode)
      .where(
        and(
          inArray(statusWaitEpisode.subjectId, ids.slice(i, i + BATCH)),
          isNull(statusWaitEpisode.closedAt)
        )
      );
    const gone = open
      .filter((e) => asked.has(subjectKey(e)) && !seen.has(episodeKey(e)))
      .map((e) => e.id);
    if (gone.length === 0) continue;
    const rows = await db
      .update(statusWaitEpisode)
      .set({ closedAt: input.now })
      .where(
        and(
          inArray(statusWaitEpisode.id, gone),
          isNull(statusWaitEpisode.closedAt)
        )
      )
      .returning({ id: statusWaitEpisode.id });
    closed += rows.length;
  }
  return { opened, closed };
}

/** Every subject with an open episode: the tick asks about each again, so it can close. */
export async function listOpenWaitEpisodeSubjects(
  db: Db
): Promise<WaitEpisodeSubject[]> {
  return db
    .selectDistinct({
      subjectType: statusWaitEpisode.subjectType,
      subjectId: statusWaitEpisode.subjectId,
      facetId: statusWaitEpisode.facetId,
    })
    .from(statusWaitEpisode)
    .where(isNull(statusWaitEpisode.closedAt));
}

/**
 * THE wait-episode read (the timeline, "where the time went"): the episodes of
 * these subjects, oldest first, every facet of an entity included. With
 * `since`, only those still open or closed at or after it. The caller has
 * floored the subjects on its reader; a ref is as the thing's HOLDER read it.
 */
export async function readWaitEpisodes(
  db: Db,
  subjects: ReadonlyArray<{
    subjectType: TransitionSubjectType;
    subjectId: string;
  }>,
  opts: { since?: Date; limit?: number } = {}
): Promise<WaitEpisode[]> {
  if (subjects.length === 0) return [];
  const wanted = new Set(
    subjects.map((s) => `${s.subjectType}:${s.subjectId}`)
  );
  const rows = await db
    .select()
    .from(statusWaitEpisode)
    .where(
      and(
        inArray(statusWaitEpisode.subjectId, [
          ...new Set(subjects.map((s) => s.subjectId)),
        ]),
        opts.since
          ? or(
              isNull(statusWaitEpisode.closedAt),
              gte(statusWaitEpisode.closedAt, opts.since)
            )
          : undefined
      )
    )
    .orderBy(asc(statusWaitEpisode.openedAt), asc(statusWaitEpisode.id))
    .limit(opts.limit ?? 1_000);
  return rows
    .filter((r) => wanted.has(`${r.subjectType}:${r.subjectId}`))
    .map((r) => ({
      id: r.id,
      subjectType: r.subjectType as TransitionSubjectType,
      subjectId: r.subjectId,
      facetId: r.facetId,
      waitKind: r.waitKind as WaitEpisode["waitKind"],
      on: r.on as WaitEpisode["on"],
      reason: r.reason as WaitEpisode["reason"],
      ref: (r.ref ?? null) as unknown as WaitEpisode["ref"],
      openedAt: r.openedAt.toISOString(),
      closedAt: r.closedAt ? r.closedAt.toISOString() : null,
    }));
}
