/**
 * REAL-POSTGRES (PGlite) test for migration 0342 — session runners (who holds
 * a session's change-feed wait). The migration and the baseline create
 * `session_runners` with EVERY column and index the drizzle schema declares,
 * schema-coherence names it, re-running is a no-op, the (session, client key)
 * primary key is what the throttled upsert conflicts on, and a deleted session
 * takes its runners with it.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { getTableConfig } from "drizzle-orm/pg-core";
import { sessionRunners } from "./schema/session-runners.js";
import { REQUIRED_COLUMNS } from "./utils/schema-coherence.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const M0342 = readFileSync(
  resolve(HERE, "../migrations/0342_session_runners.sql"),
  "utf8"
);
const BASELINE = readFileSync(
  resolve(HERE, "../migrations/0000_baseline_schema.sql"),
  "utf8"
);
const cfg = getTableConfig(sessionRunners);
const declaredColumns = cfg.columns.map((c) => c.name);
const declaredIndexes = cfg.indexes.map((i) => i.config.name!);

const SESSIONS_STUB = `CREATE TABLE focus_sessions (id uuid PRIMARY KEY, user_id text NOT NULL)`;

describe("migration 0342 — session_runners", () => {
  it("creates every declared column and index, idempotently", async () => {
    const pg = new PGlite();
    await pg.exec(SESSIONS_STUB);
    await pg.exec(M0342);
    await pg.exec(M0342);
    const cols = await pg.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'session_runners'`
    );
    expect(declaredColumns.length).toBe(11);
    expect(cols.rows.map((r) => r.column_name).sort()).toEqual(
      [...declaredColumns].sort()
    );
    expect(declaredIndexes).toEqual(["idx_session_runners_session_seen"]);
    const idx = await pg.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'session_runners'`
    );
    expect(idx.rows.map((r) => r.indexname)).toContain(declaredIndexes[0]);
    await pg.close();
  }, 60_000);

  it("one row per (session, client key); a deleted session takes its runners", async () => {
    const pg = new PGlite();
    await pg.exec(SESSIONS_STUB);
    await pg.exec(M0342);
    const sid = randomUUID();
    await pg.query(`INSERT INTO focus_sessions VALUES ($1, 'u')`, [sid]);
    const ins = (key: string) =>
      pg.query(
        `INSERT INTO session_runners (session_id, client_key, user_id, harness, conversation_id) VALUES ($1, $2, 'u', 'claude-code', 'c')`,
        [sid, key]
      );
    await ins("key:a|conv:claude-code:c");
    await ins("key:b|conv:claude-code:c");
    await expect(ins("key:a|conv:claude-code:c")).rejects.toThrow(
      /duplicate key/
    );
    await pg.query(`DELETE FROM focus_sessions WHERE id = $1`, [sid]);
    const left = await pg.query(`SELECT 1 FROM session_runners`);
    expect(left.rows).toHaveLength(0);
    await pg.close();
  }, 60_000);

  it("the baseline carries the same table + index, and schema-coherence names it", () => {
    const create = M0342.slice(
      M0342.indexOf('CREATE TABLE IF NOT EXISTS "session_runners"'),
      M0342.indexOf(");", M0342.indexOf("CREATE TABLE")) + 2
    );
    expect(create.length).toBeGreaterThan(300);
    expect(BASELINE).toContain(create.trim());
    expect(BASELINE).toContain('"idx_session_runners_session_seen"');
    expect(
      REQUIRED_COLUMNS.filter((c) => c.table === "session_runners").map(
        (c) => c.column
      )
    ).toEqual(expect.arrayContaining(["last_seen_at", "machine_user_id"]));
  });
});
