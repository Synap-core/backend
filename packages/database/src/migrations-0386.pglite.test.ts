/**
 * REAL-POSTGRES (PGlite) test for migration 0386 — wait episodes (status-first
 * PR-H):
 *   - the migration (twice: idempotent) and the baseline create the table with
 *     every column the drizzle schema declares, and the indexes it names (the
 *     boot check `findMissingIndexes` sees them, and sees them missing without
 *     the migration's index statements);
 *   - the boot coherence list carries it;
 *   - the writer opens an episode once across ticks (and once in one batch),
 *     closes it when its wait is gone, opens a NEW one when the wait recurs,
 *     never closes the episode of a subject it was not asked about, keeps a
 *     kind's own wait (no facet) single too (NULLS NOT DISTINCT);
 *   - the reader returns them oldest first, `since` leaving out the ones that
 *     closed before it.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { getTableConfig } from "drizzle-orm/pg-core";
import { statusWaitEpisode } from "./schema/status-wait-episode.js";
import {
  findMissingIndexes,
  REQUIRED_COLUMNS,
} from "./utils/schema-coherence.js";
import {
  listOpenWaitEpisodeSubjects,
  readWaitEpisodes,
  syncWaitEpisodes,
  type WaitEpisodeSeen,
} from "./services/lifecycle/wait-episodes.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (f: string) =>
  readFileSync(resolve(HERE, "../migrations", f), "utf8");
const FILE = "0386_status_wait_episode.sql";
const M0386 = read(FILE);
const BASELINE = read("0000_baseline_schema.sql");

let pg: PGlite;
beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(M0386);
  await pg.exec(M0386);
}, 60_000);
afterAll(async () => {
  await pg.close();
});

const columns = async (client: PGlite) =>
  (
    await client.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'status_wait_episode'`
    )
  ).rows.map((r) => r.column_name);

/** `findMissingIndexes`' tagged-template query, on a PGlite client. */
const queryOn =
  (client: PGlite) =>
  async (strings: TemplateStringsArray, ...values: unknown[]) =>
    (
      await client.query(
        strings.reduce((sql, s, i) => `${sql}$${i}${s}`),
        values
      )
    ).rows;

const missingOn = async (client: PGlite) =>
  (await findMissingIndexes(queryOn(client) as never)).find(
    (m) => m.table === "status_wait_episode"
  )?.missing ?? [];

describe("migration 0386 — wait episodes", () => {
  it("creates every column the schema declares, and so does the baseline", async () => {
    const declared = getTableConfig(statusWaitEpisode).columns.map(
      (c) => c.name
    );
    // Non-vacuity: the columns the plan names are declared.
    for (const c of [
      "subject_type",
      "subject_id",
      "facet_id",
      "wait_kind",
      "on",
      "reason",
      "ref",
      "opened_at",
      "closed_at",
    ])
      expect(declared).toContain(c);
    expect((await columns(pg)).sort()).toEqual([...declared].sort());
    const base = new PGlite();
    await base.exec(BASELINE.slice(BASELINE.indexOf("-- 0386")));
    expect((await columns(base)).sort()).toEqual([...declared].sort());
    expect(await missingOn(base)).toEqual([]);
    await base.close();
  });

  it("the boot check sees both indexes, and sees them missing without them", async () => {
    expect(await missingOn(pg)).toEqual([]);
    const bare = new PGlite();
    await bare.exec(M0386.slice(0, M0386.indexOf("CREATE UNIQUE INDEX")));
    expect((await missingOn(bare)).sort()).toEqual(
      ["idx_status_wait_episode_subject", "uq_status_wait_episode_open"].sort()
    );
    await bare.close();
    expect(REQUIRED_COLUMNS).toContainEqual(
      expect.objectContaining({
        table: "status_wait_episode",
        column: "ref_key",
        addedBy: FILE,
      })
    );
  });
});

const S = "11111111-1111-4111-8111-111111111111";
const T = "22222222-2222-4222-8222-222222222222";
const subject = { subjectType: "focus_session", subjectId: S, facetId: null };
const other = { subjectType: "entity", subjectId: T, facetId: null };
const wait = (
  over: Partial<WaitEpisodeSeen> = {},
  on: typeof subject | typeof other = subject
): WaitEpisodeSeen => ({
  ...on,
  waitKind: "ci",
  on: null,
  reason: "machine",
  ref: { kind: "pull_request", url: "https://x/pull/1", label: "x#1" },
  refKey: "pull_request:https://x/pull/1",
  ...over,
});
const at = (h: number) => new Date(Date.UTC(2026, 9, 31, h));

describe("wait episodes — the writer and the reader", () => {
  it("opens once, closes when gone, reopens as a new episode", async () => {
    const db = drizzle(pg) as never;
    await pg.exec(`DELETE FROM status_wait_episode`);
    // Twice in one batch, then a second tick: one open episode.
    expect(
      await syncWaitEpisodes(db, {
        subjects: [subject],
        seen: [wait(), wait()],
        now: at(1),
      })
    ).toEqual({ opened: 1, closed: 0 });
    expect(
      await syncWaitEpisodes(db, {
        subjects: [subject],
        seen: [wait()],
        now: at(2),
      })
    ).toEqual({ opened: 0, closed: 0 });
    // A wait on a subject NOT asked is ignored: it neither opens nor closes.
    await syncWaitEpisodes(db, {
      subjects: [other],
      seen: [wait({ waitKind: "answer", refKey: "" }, other)],
      now: at(2),
    });
    expect(
      await syncWaitEpisodes(db, {
        subjects: [subject],
        seen: [],
        now: at(3),
      })
    ).toEqual({ opened: 0, closed: 1 });
    // The other subject was not asked: its episode stays open.
    expect(await listOpenWaitEpisodeSubjects(db)).toEqual([other]);
    // The wait recurs: a NEW episode; the closed one is kept.
    expect(
      await syncWaitEpisodes(db, {
        subjects: [subject],
        seen: [wait()],
        now: at(4),
      })
    ).toEqual({ opened: 1, closed: 0 });

    const all = await readWaitEpisodes(db, [
      { subjectType: "focus_session", subjectId: S },
    ]);
    expect(
      all.map((e) => [e.waitKind, e.openedAt, e.closedAt, e.ref?.label])
    ).toEqual([
      ["ci", at(1).toISOString(), at(3).toISOString(), "x#1"],
      ["ci", at(4).toISOString(), null, "x#1"],
    ]);
    // `since` leaves out what closed before it; the type must match too.
    const since = new Date(at(3).getTime() + 1_800_000);
    const recent = await readWaitEpisodes(
      db,
      [{ subjectType: "focus_session", subjectId: S }],
      { since }
    );
    expect(recent.map((e) => e.openedAt)).toEqual([at(4).toISOString()]);
    expect(
      await readWaitEpisodes(db, [{ subjectType: "track", subjectId: S }])
    ).toEqual([]);
  });

  it("a kind's own wait (no facet) stays single: NULLS NOT DISTINCT", async () => {
    await pg.exec(`DELETE FROM status_wait_episode`);
    const insert = () =>
      pg.query(
        `INSERT INTO status_wait_episode (subject_type, subject_id, wait_kind, ref_key)
         VALUES ('entity', $1, 'answer', '') ON CONFLICT DO NOTHING RETURNING id`,
        [T]
      );
    expect((await insert()).rows).toHaveLength(1);
    expect((await insert()).rows).toHaveLength(0);
  });
});
