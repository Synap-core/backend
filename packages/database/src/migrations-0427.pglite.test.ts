/**
 * REAL-POSTGRES (PGlite) test for migration 0427 — one live run per object:
 *   - on a pod that ALREADY holds duplicate live runs of one playbook on one
 *     object, the migration applies (twice: idempotent) and every existing row
 *     is unstamped (`one_live_per_subject` false), so the index cannot fail;
 *   - two live SLOT-HOLDERS of one (playbook, subject, owner) cannot coexist;
 *     an unstamped run ("start another", a fan-out child), another person's
 *     run, another object, and a subjectless run never collide;
 *   - "live" is exactly LIVE_RUN_SESSION_STATUSES (@synap-core/types),
 *     checked behaviourally for EVERY stored status, so the SQL list and the
 *     typed list cannot drift; ending a run frees the object;
 *   - the baseline carries the same column and index; the boot coherence
 *     lists carry them; the boot index check sees the index, and sees it
 *     missing without the migration's index statement;
 *   - every index declared on focus_sessions has a CREATE statement in some
 *     migration, since 0427 puts the whole table under the boot index check
 *     (a declared index no migration creates would stop every pod booting).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
  LIVE_RUN_SESSION_STATUSES,
  SESSION_STATUSES,
} from "@synap-core/types/focus-sessions";
import { focusSessions, ONE_LIVE_RUN_INDEX } from "./schema/focus-sessions.js";
import {
  findMissingIndexes,
  REQUIRED_COLUMNS,
} from "./utils/schema-coherence.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = resolve(HERE, "../migrations");
const read = (f: string) => readFileSync(resolve(MIGRATIONS, f), "utf8");
const FILE = "0427_one_live_run_per_subject.sql";
const M0427 = read(FILE);
const BASELINE = read("0000_baseline_schema.sql");

/** focus_sessions as a pod holds it before 0427 (the columns the index reads). */
const PRE_0427 = `CREATE TABLE focus_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  playbook_id uuid,
  subject_entity_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);`;

const PLAYBOOK = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SUBJECT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OTHER_SUBJECT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

let pg: PGlite;
beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(PRE_0427);
  // A pod today: two live runs of one playbook on one object (each click
  // started one). The migration must apply over them.
  await pg.query(
    `INSERT INTO focus_sessions (user_id, status, playbook_id, subject_entity_id)
     VALUES ('u1', 'active', $1, $2), ('u1', 'active', $1, $2)`,
    [PLAYBOOK, SUBJECT]
  );
  await pg.exec(M0427);
  await pg.exec(M0427);
}, 60_000);
afterAll(async () => {
  await pg.close();
});
beforeEach(async () => {
  await pg.exec(`DELETE FROM focus_sessions WHERE one_live_per_subject`);
});

const insert = (opts: {
  stamped: boolean;
  status?: string;
  user?: string;
  subject?: string | null;
}) =>
  pg.query(
    `INSERT INTO focus_sessions (user_id, status, playbook_id, subject_entity_id, one_live_per_subject)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [
      opts.user ?? "u1",
      opts.status ?? "active",
      PLAYBOOK,
      opts.subject === undefined ? SUBJECT : opts.subject,
      opts.stamped,
    ]
  );

describe("migration 0427 — one live run per object", () => {
  it("applies over existing duplicate live runs, leaving every old row unstamped", async () => {
    const { rows } = await pg.query<{ n: number; stamped: number }>(
      `SELECT count(*)::int AS n, count(*) FILTER (WHERE one_live_per_subject)::int AS stamped
         FROM focus_sessions`
    );
    expect(rows[0]).toEqual({ n: 2, stamped: 0 });
  });

  it("refuses a second live slot-holder of the same playbook, object and owner", async () => {
    await insert({ stamped: true });
    await expect(insert({ stamped: true })).rejects.toThrow(
      new RegExp(ONE_LIVE_RUN_INDEX)
    );
  });

  it("never collides for an unstamped run, another person, another object, or no object", async () => {
    await insert({ stamped: true });
    await insert({ stamped: false }); // "start another", a fan-out child
    await insert({ stamped: true, user: "u2" }); // another person
    await insert({ stamped: true, subject: OTHER_SUBJECT });
    // A subjectless run: NULLs are distinct, so it never holds a slot.
    await insert({ stamped: true, subject: null });
    await insert({ stamped: true, subject: null });
  });

  it("'live' is exactly LIVE_RUN_SESSION_STATUSES, for every stored status", async () => {
    // Non-vacuity: the typed lists are the ones this test reasons about.
    expect(SESSION_STATUSES.length).toBeGreaterThanOrEqual(8);
    expect([...LIVE_RUN_SESSION_STATUSES].sort()).toEqual(
      ["active", "forming", "paused", "stale"].sort()
    );
    const liveInDb: string[] = [];
    for (const status of SESSION_STATUSES) {
      await pg.exec(`DELETE FROM focus_sessions WHERE one_live_per_subject`);
      await insert({ stamped: true, status });
      const second = await insert({ stamped: true }).then(
        () => "started",
        () => "refused"
      );
      if (second === "refused") liveInDb.push(status);
    }
    expect(liveInDb.sort()).toEqual([...LIVE_RUN_SESSION_STATUSES].sort());
  });

  it("ending the run frees the object", async () => {
    const { rows } = await insert({ stamped: true });
    const id = (rows[0] as { id: string }).id;
    await pg.query(
      `UPDATE focus_sessions SET status = 'cancelled' WHERE id = $1`,
      [id]
    );
    await insert({ stamped: true });
    // …and the ended one cannot come back live while the new one is.
    await expect(
      pg.query(`UPDATE focus_sessions SET status = 'active' WHERE id = $1`, [
        id,
      ])
    ).rejects.toThrow(new RegExp(ONE_LIVE_RUN_INDEX));
  });

  it("the baseline carries the same column and index; the boot lists carry them", async () => {
    const column =
      'ALTER TABLE "focus_sessions" ADD COLUMN IF NOT EXISTS "one_live_per_subject" boolean NOT NULL DEFAULT false;';
    expect(M0427).toContain(column);
    expect(BASELINE).toContain(column);
    const index = M0427.slice(M0427.indexOf("CREATE UNIQUE INDEX")).trim();
    expect(index).toContain(ONE_LIVE_RUN_INDEX);
    expect(BASELINE).toContain(index);
    expect(REQUIRED_COLUMNS).toContainEqual(
      expect.objectContaining({
        table: "focus_sessions",
        column: "one_live_per_subject",
        addedBy: FILE,
      })
    );
  });

  it("the boot index check sees the index, and sees it missing without it", async () => {
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
        (m) => m.table === "focus_sessions"
      )?.missing ?? [];
    expect(await missingOn(pg)).not.toContain(ONE_LIVE_RUN_INDEX);
    const bare = new PGlite();
    await bare.exec(PRE_0427);
    await bare.exec(M0427.slice(0, M0427.indexOf("CREATE UNIQUE INDEX")));
    expect(await missingOn(bare)).toContain(ONE_LIVE_RUN_INDEX);
    await bare.close();
  });

  it("every index declared on focus_sessions is created by some migration", () => {
    const declared = getTableConfig(focusSessions)
      .indexes.map((i) => i.config.name)
      .filter((n): n is string => typeof n === "string");
    // Non-vacuity: the table declares its indexes, this one among them.
    expect(declared.length).toBeGreaterThanOrEqual(14);
    expect(declared).toContain(ONE_LIVE_RUN_INDEX);
    const sql = readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith(".sql"))
      .map(read)
      .join("\n");
    const uncreated = declared.filter(
      (name) =>
        !new RegExp(
          `CREATE (UNIQUE )?INDEX (IF NOT EXISTS )?"?${name}"?\\s`,
          "i"
        ).test(sql)
    );
    expect(uncreated).toEqual([]);
  });
});
