/**
 * REAL-POSTGRES (PGlite) test for migration 0298 — a plain index on
 * `focus_sessions(channel_id)`.
 *
 * 0297's room triggers look sessions up by `channel_id = NEW.channel_id` with
 * no status filter. The only channel index before 0298 is 0121's PARTIAL
 * unique index (`WHERE status = 'active' AND channel_id IS NOT NULL`), which
 * the planner cannot use for that predicate — so every chat-turn / AI-message
 * write paid a sequential scan. This pins the PLAN, before and after, on the
 * exact query shape the trigger runs.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const HERE = dirname(fileURLToPath(import.meta.url));
const M0298 = readFileSync(
  resolve(HERE, "../migrations/0298_focus_sessions_channel_id_index.sql"),
  "utf8"
);

/** The trigger's own lookup (0297 `synap_notify_session_room_changed`). */
const ROOM_LOOKUP = `EXPLAIN SELECT id FROM focus_sessions WHERE channel_id = '00000000-0000-4000-8000-000000000042'`;

let pg: PGlite;

async function plan(): Promise<string> {
  const r = await pg.query<{ "QUERY PLAN": string }>(ROOM_LOOKUP);
  return r.rows.map((row) => row["QUERY PLAN"]).join("\n");
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE focus_sessions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id text NOT NULL,
      status text NOT NULL,
      channel_id uuid
    );
    -- 0121 / baseline: the partial index that existed before 0298.
    CREATE UNIQUE INDEX idx_focus_sessions_active_channel
      ON focus_sessions (channel_id)
      WHERE status = 'active' AND channel_id IS NOT NULL;
    -- A realistic pod: mostly closed sessions, each in its own room.
    INSERT INTO focus_sessions (user_id, status, channel_id)
      SELECT 'u', CASE WHEN g % 20 = 0 THEN 'active' ELSE 'completed' END,
             gen_random_uuid()
        FROM generate_series(1, 5000) g;
    ANALYZE focus_sessions;
  `);
}, 120_000);

describe("migration 0298 — focus_sessions(channel_id)", () => {
  it("before: the room lookup cannot use the partial index (sequential scan)", async () => {
    const before = await plan();
    expect(before).toMatch(/Seq Scan on focus_sessions/);
    expect(before).not.toMatch(/idx_focus_sessions_active_channel/);
  });

  it("after: the room lookup is served by idx_focus_sessions_channel_id; re-running is a no-op", async () => {
    await pg.exec(M0298);
    await pg.exec(M0298); // idempotent
    await pg.exec("ANALYZE focus_sessions;");
    const after = await plan();
    expect(after).toMatch(
      /Index (Only )?Scan using idx_focus_sessions_channel_id|Bitmap Index Scan on idx_focus_sessions_channel_id/
    );
    expect(after).not.toMatch(/Seq Scan/);
    const idx = await pg.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_focus_sessions_channel_id'`
    );
    expect(idx.rows).toHaveLength(1);
    // Plain, not partial: no WHERE clause for the planner to prove.
    expect(idx.rows[0]!.indexdef).not.toMatch(/WHERE/i);
  });
});
