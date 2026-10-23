/**
 * `synap_get_thread_context` honours `limit` — through the MCP handler AND the
 * real Hub `context.getThreadContext` procedure on PGlite (every schema table
 * created, columns only), so the value is proven to REACH the message read,
 * not merely to be accepted. Before: the tool declared no `limit`, the handler
 * forwarded none, and the procedure hard-coded 50.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
  const state = {
    client: null as null | {
      exec: (sql: string) => Promise<unknown>;
      query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    },
    db: null as unknown,
    async init(): Promise<unknown> {
      if (!state.db) {
        const { PGlite } = await import("@electric-sql/pglite");
        const { drizzle } = await import("drizzle-orm/pglite");
        const schema = await import("@synap/database/schema");
        const client = new PGlite();
        state.client = client as unknown as typeof state.client;
        state.db = drizzle(client, { schema });
      }
      return state.db;
    },
    async clientPgModule() {
      const db = await state.init();
      return {
        db,
        sql: undefined,
        getDb: async () => db,
        setCurrentUser: async () => undefined,
        clearCurrentUser: async () => undefined,
        closeDatabase: async () => undefined,
      };
    },
  };
  return state;
});

vi.mock("../../../../../database/dist/client-pg.js", () => h.clientPgModule());
vi.mock("../../../../../database/src/client-pg.js", () => h.clientPgModule());
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const pg = await h.init();
  return { ...actual, db: pg, getDb: async () => pg };
});

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { contextRouter } from "../context.js";
import { createHubProtocolCallerContext } from "../utils.js";
import { readHandlers } from "../../mcp/handlers/read.js";

const OWNER = "user-owner";
const CHANNEL = randomUUID();
const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

beforeAll(async () => {
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) await h.client!.exec(ddlFor(value));
  }
  await q(`insert into users (id, user_type) values ($1, 'human')`, [OWNER]);
  await q(
    `insert into channels (id, user_id, workspace_id, channel_type, created_at, updated_at)
     values ($1, $2, null, 'ai_thread', now(), now())`,
    [CHANNEL, OWNER]
  );
  for (let i = 0; i < 12; i++) {
    await q(
      `insert into messages (id, channel_id, role, author_type, user_id, content, timestamp, ephemeral, hash, previous_hash)
       values ($1, $2, 'user', 'human', $3, $4, $5, false, 'h', '')`,
      [
        randomUUID(),
        CHANNEL,
        OWNER,
        `message ${i}`,
        new Date(Date.now() - (60 - i) * 60_000).toISOString(),
      ]
    );
  }
});

/** The MCP handler driving the REAL procedure. */
async function viaMcp(args: Record<string, unknown>) {
  const ctx = await createHubProtocolCallerContext(OWNER, [
    "hub-protocol.read",
  ]);
  const caller = { context: contextRouter.createCaller(ctx as never) };
  const result = await readHandlers.synap_get_thread_context!({
    toolName: "synap_get_thread_context",
    args: { threadId: CHANNEL, ...args },
    userId: OWNER,
    apiKeyScopes: ["mcp.read"],
    caller,
  } as never);
  const text = (result.content[0] as { text: string }).text;
  return JSON.parse(text) as { messages: Array<{ content: string }> };
}

describe("synap_get_thread_context limit", () => {
  it("returns the NEWEST `limit` messages", async () => {
    const out = await viaMcp({ limit: 3 });
    expect(out.messages.map((m) => m.content)).toEqual([
      "message 11",
      "message 10",
      "message 9",
    ]);
  });

  it("keeps the default when no limit is given", async () => {
    const out = await viaMcp({});
    expect(out.messages).toHaveLength(12);
  });

  it("clamps an out-of-range limit instead of failing", async () => {
    expect((await viaMcp({ limit: 0 })).messages).toHaveLength(1);
    expect((await viaMcp({ limit: 500 })).messages).toHaveLength(12);
  });
});
