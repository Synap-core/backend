/**
 * REAL-POSTGRES (PGlite) test for migration 0408 — a wait episode records the
 * status its subject waited in and the blocker's name (plan e7f753db §9):
 *   - the migration adds both columns over 0386, idempotently; the baseline
 *     carries them; the boot coherence list names them;
 *   - the writer stores `status` and `blockerKey` when it opens an episode,
 *     and the reader returns them.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { REQUIRED_COLUMNS } from "./utils/schema-coherence.js";
import {
  readWaitEpisodes,
  syncWaitEpisodes,
} from "./services/lifecycle/wait-episodes.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (f: string) =>
  readFileSync(resolve(HERE, "../migrations", f), "utf8");
const FILE = "0408_wait_episode_blocker.sql";
const M0408 = read(FILE);
const BASELINE = read("0000_baseline_schema.sql");

const columns = async (client: PGlite) =>
  (
    await client.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'status_wait_episode'`
    )
  ).rows.map((r) => r.column_name);

let pg: PGlite;
beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(read("0386_status_wait_episode.sql"));
  await pg.exec(M0408);
  await pg.exec(M0408);
}, 60_000);
afterAll(async () => {
  await pg.close();
});

describe("migration 0408 — the status and blocker of a wait", () => {
  it("adds both columns, idempotently; the baseline and the boot check carry them", async () => {
    const cols = await columns(pg);
    expect(cols).toContain("status");
    expect(cols).toContain("blocker_key");
    const base = new PGlite();
    await base.exec(BASELINE.slice(BASELINE.indexOf("-- 0386")));
    const baseCols = await columns(base);
    expect(baseCols).toContain("status");
    expect(baseCols).toContain("blocker_key");
    await base.close();
    for (const column of ["status", "blocker_key"]) {
      expect(REQUIRED_COLUMNS).toContainEqual(
        expect.objectContaining({
          table: "status_wait_episode",
          column,
          addedBy: FILE,
        })
      );
    }
  });

  it("the writer stores the status and the blocker; the reader returns them", async () => {
    const db = drizzle(pg) as never;
    const S = "33333333-3333-4333-8333-333333333333";
    const subject = { subjectType: "entity", subjectId: S, facetId: null };
    const now = new Date(Date.UTC(2026, 10, 7, 10));
    const { opened } = await syncWaitEpisodes(db, {
      subjects: [subject],
      seen: [
        {
          ...subject,
          waitKind: "agent_work",
          on: null,
          reason: "another_work",
          ref: { kind: "slot", id: "s1", label: "Invite" },
          refKey: "slot:s1",
          status: "researching",
          blockerKey: "not_connected",
        },
      ],
      now,
    });
    expect(opened).toBe(1);
    const [episode] = await readWaitEpisodes(db, [
      { subjectType: "entity", subjectId: S },
    ]);
    expect(episode).toMatchObject({
      status: "researching",
      blockerKey: "not_connected",
    });
  });
});
