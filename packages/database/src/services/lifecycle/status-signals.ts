/**
 * The status watcher's episode claims (0376, status-flow W6): claim before
 * raising, release when the raise failed so the next tick can retry it.
 */
import { and, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type * as schema from "../../schema/index.js";
import { statusSignalRaised } from "../../schema/status-signal-raised.js";

type Db = PostgresJsDatabase<typeof schema>;

export interface StatusSignalEpisode {
  subjectType: string;
  subjectId: string;
  signal: string;
  episodeKey: string;
}

const keyOf = (e: StatusSignalEpisode) =>
  `${e.subjectType}\u0000${e.subjectId}\u0000${e.signal}\u0000${e.episodeKey}`;

/** The episodes THIS call claimed; one already claimed is left out. */
export async function claimStatusSignals<E extends StatusSignalEpisode>(
  db: Db,
  episodes: readonly E[],
  batch = 500
): Promise<E[]> {
  const byKey = new Map(episodes.map((e) => [keyOf(e), e]));
  const claimed: E[] = [];
  const all = [...byKey.values()];
  for (let i = 0; i < all.length; i += batch) {
    const rows = await db
      .insert(statusSignalRaised)
      .values(
        all.slice(i, i + batch).map((e) => ({
          subjectType: e.subjectType,
          subjectId: e.subjectId,
          signal: e.signal,
          episodeKey: e.episodeKey,
        }))
      )
      .onConflictDoNothing()
      .returning();
    for (const r of rows) {
      const e = byKey.get(keyOf(r));
      if (e) claimed.push(e);
    }
  }
  return claimed;
}

/** Give a claim back (its raise failed): the next tick may raise it. */
export async function releaseStatusSignal(
  db: Db,
  e: StatusSignalEpisode
): Promise<void> {
  await db
    .delete(statusSignalRaised)
    .where(
      and(
        eq(statusSignalRaised.subjectType, e.subjectType),
        eq(statusSignalRaised.subjectId, e.subjectId),
        eq(statusSignalRaised.signal, e.signal),
        eq(statusSignalRaised.episodeKey, e.episodeKey)
      )
    );
}
