/**
 * The heartbeat DOOR (`POST /conversations/heartbeat`) through the real Hono
 * route on PGlite with the real 0342 + 0354 migrations — the seam between the
 * wire and the store:
 *   - write scope required;
 *   - a forbidden field (prompt text, a path, an identity field) is a 400 and
 *     NOTHING is written;
 *   - the person, agent and key are the KEY's (context), never the body's;
 *   - a session the person does not own is a 404, no runner written.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    close: () => Promise<void>;
  },
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  return { ...actual, db: drizzle(client, { schema }) };
});

import { OpenAPIHono } from "@hono/zod-openapi";
import type { HubHono, HubVariables } from "./_shared.js";
import { registerConversationsRoutes } from "./conversations.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = resolve(HERE, "../../../../../database/migrations");
const sql = (f: string) => readFileSync(resolve(MIGRATIONS, f), "utf8");
const q = <T>(text: string, params?: unknown[]) =>
  h.client!.query<T>(text, params);

const ADA = "user-ada";
const ADA_AGENT = "agent-ada";
const ADA_KEY = randomUUID();
const BOB_SESSION = randomUUID();

function door(
  ctx: { scopes?: string[]; userId?: string; agentUserId?: string } = {}
) {
  const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  app.use("*", async (c, next) => {
    c.set("scopes", ctx.scopes ?? ["hub-protocol.read", "hub-protocol.write"]);
    c.set("userId", ctx.userId ?? ADA);
    c.set("agentUserId", ctx.agentUserId ?? ADA_AGENT);
    c.set("apiKeyId", ADA_KEY);
    await next();
  });
  registerConversationsRoutes(app);
  return (body: unknown) =>
    app.request("/conversations/heartbeat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
}

const BODY = {
  computer: "devbox",
  harness: "claude-code",
  conversationId: "conv-1",
  state: "working",
  folder: "/home/ada/code/synap",
};
const count = async () =>
  (await q<{ n: number }>(`SELECT count(*)::int AS n FROM agent_conversations`))
    .rows[0]!.n;

beforeAll(async () => {
  await h.client!.exec(`
    CREATE TABLE users (id text PRIMARY KEY, agent_type text, host_user_id text);
    CREATE TABLE focus_sessions (id uuid PRIMARY KEY, user_id text NOT NULL);
  `);
  await h.client!.exec(sql("0342_session_runners.sql"));
  await h.client!.exec(sql("0354_agent_conversations.sql"));
  await q(`INSERT INTO focus_sessions (id, user_id) VALUES ($1, 'user-bob')`, [
    BOB_SESSION,
  ]);
}, 120_000);

afterAll(async () => {
  await h.client?.close();
});

describe("POST /conversations/heartbeat", () => {
  it("needs the write scope", async () => {
    const res = await door({ scopes: ["hub-protocol.read"] })(BODY);
    expect(res.status).toBe(403);
    expect(await count()).toBe(0);
  });

  for (const [field, value] of [
    ["prompt", "fix the login bug"],
    ["tty", "/dev/ttys004"],
    ["resumePath", "/home/ada/.claude/projects/x.jsonl"],
    ["userId", "user-bob"],
  ] as const) {
    it(`refuses \`${field}\` with 400 and writes nothing`, async () => {
      const res = await door()({ ...BODY, [field]: value });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(
        /Invalid heartbeat/
      );
      expect(await count()).toBe(0);
    });
  }

  it("records the KEY's person, agent and key — the folder as its basename", async () => {
    const res = await door()(BODY);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      conversation: { computer: string; state: string };
      written: boolean;
    };
    expect(body).toMatchObject({
      conversation: { computer: "devbox", state: "working" },
      written: true,
    });
    const rows = await q<Record<string, unknown>>(
      `SELECT user_id, agent_user_id, api_key_id, folder FROM agent_conversations`
    );
    expect(rows.rows).toEqual([
      {
        user_id: ADA,
        agent_user_id: ADA_AGENT,
        api_key_id: ADA_KEY,
        folder: "synap",
      },
    ]);
  });

  it("a session the person does not own is a 404, and no runner is written", async () => {
    const res = await door()({ ...BODY, sessionId: BOB_SESSION });
    expect(res.status).toBe(404);
    const runners = await q(`SELECT 1 FROM session_runners`);
    expect(runners.rows).toHaveLength(0);
  });
});
