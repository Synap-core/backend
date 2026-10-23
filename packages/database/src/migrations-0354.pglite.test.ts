/**
 * REAL-POSTGRES (PGlite) test for migration 0354 — agent conversations (the
 * one registry of live agent terminals). The migration and the baseline create
 * `agent_conversations` with EVERY column and index the drizzle schema
 * declares, schema-coherence names it, re-running is a no-op, the identity
 * unique index is what the heartbeat upsert conflicts on, and the CHECKs keep
 * `state` to the declared set.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
  agentConversations,
  AGENT_CONVERSATION_STATES,
} from "./schema/agent-conversations.js";
import { REQUIRED_COLUMNS } from "./utils/schema-coherence.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const M0354 = readFileSync(
  resolve(HERE, "../migrations/0354_agent_conversations.sql"),
  "utf8"
);
const BASELINE = readFileSync(
  resolve(HERE, "../migrations/0000_baseline_schema.sql"),
  "utf8"
);
const cfg = getTableConfig(agentConversations);
const declaredColumns = cfg.columns.map((c) => c.name);
const declaredIndexes = cfg.indexes.map((i) => i.config.name!);

describe("migration 0354 — agent_conversations", () => {
  it("creates every declared column and index, idempotently", async () => {
    const pg = new PGlite();
    await pg.exec(M0354);
    await pg.exec(M0354);
    const cols = await pg.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'agent_conversations'`
    );
    expect(declaredColumns.length).toBe(15);
    expect(cols.rows.map((r) => r.column_name).sort()).toEqual(
      [...declaredColumns].sort()
    );
    expect(declaredIndexes.sort()).toEqual([
      "idx_agent_conversations_user_seen",
      "uq_agent_conversations_identity",
    ]);
    const idx = await pg.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'agent_conversations'`
    );
    expect(idx.rows.map((r) => r.indexname)).toEqual(
      expect.arrayContaining(declaredIndexes)
    );
    await pg.close();
  }, 60_000);

  it("one row per (person, computer, harness, conversation); state is the declared set", async () => {
    const pg = new PGlite();
    await pg.exec(M0354);
    const ins = (user: string, computer: string, state = "working") =>
      pg.query(
        `INSERT INTO agent_conversations (user_id, computer, harness, conversation_id, state) VALUES ($1, $2, 'claude-code', 'c', $3)`,
        [user, computer, state]
      );
    await ins("u", "devbox");
    await ins("u", "mac");
    await ins("v", "devbox");
    await expect(ins("u", "devbox")).rejects.toThrow(/duplicate key/);
    for (const s of AGENT_CONVERSATION_STATES) await ins(`s-${s}`, "x", s);
    await expect(ins("w", "x", "thinking")).rejects.toThrow(
      /agent_conversations_state_chk/
    );
    await expect(
      pg.query(
        `INSERT INTO agent_conversations (user_id, computer, harness, conversation_id, state, subagent_count) VALUES ('z', 'x', 'h', 'c', 'idle', -1)`
      )
    ).rejects.toThrow(/agent_conversations_subagents_chk/);
    await pg.close();
  }, 60_000);

  it("the baseline carries the same table + indexes, and schema-coherence names it", () => {
    const start = M0354.indexOf(
      'CREATE TABLE IF NOT EXISTS "agent_conversations"'
    );
    const create = M0354.slice(start).trim();
    expect(create.length).toBeGreaterThan(900);
    expect(BASELINE).toContain(create);
    expect(
      REQUIRED_COLUMNS.filter((c) => c.table === "agent_conversations").map(
        (c) => c.column
      )
    ).toEqual(expect.arrayContaining(["last_seen_at", "ended_at"]));
  });
});
