/**
 * The terminal registry (0354) end to end on PGlite, with the REAL 0342 and
 * 0354 migrations (the upserts conflict on their keys), driven from a raw
 * heartbeat body through `decodeHeartbeat` → `recordHeartbeat` → the readers.
 *
 * Pinned:
 *   - idempotent upsert: one row per (person, computer, harness,
 *     conversation), whatever spelling the computer arrives in; an unchanged
 *     beat inside the interval writes nothing; `stateSince` moves only when
 *     `state` changes;
 *   - `ended: true` closes it (gone from the live list); a later beat reopens;
 *   - owner floor: another person's beat for the same conversation is their
 *     own row, never in my list; they cannot bind my session (404, no runner);
 *   - the session link is a `session_runners` row (no path), read back as the
 *     terminal's `sessionId` and as the session's runner WITH its terminal —
 *     the terminal facts for the viewer only;
 *   - silence ages out of the live list;
 *   - the stored row holds no path (the codec's floor, at the store).
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

import { decodeHeartbeat } from "../heartbeat-codec.js";
import {
  loadLiveTerminals,
  loadSessionRunnerTerminals,
  recordHeartbeat,
  CONVERSATION_LIVE_WINDOW_SECONDS,
} from "../agent-conversations.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = resolve(HERE, "../../../../../database/migrations");
const sql = (f: string) => readFileSync(resolve(MIGRATIONS, f), "utf8");
const q = <T>(text: string, params?: unknown[]) =>
  h.client!.query<T>(text, params);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ADA = "user-ada";
const BOB = "user-bob";
const ADA_AGENT = "agent-ada-cc";
const DEVBOX = "machine-devbox";
const ADA_KEY = randomUUID();
const BOB_KEY = randomUUID();
const ADA_SESSION = randomUUID();
const CONV = "6f1c2a4e-9b7d-4a51-8c3e-2d9f0b1a7c55";

const beat = (
  userId: string,
  body: Record<string, unknown>,
  key: { agentUserId?: string | null; apiKeyId?: string | null } = {}
) => {
  const d = decodeHeartbeat({
    computer: "Devbox.local",
    harness: "claude-code",
    conversationId: CONV,
    state: "working",
    ...body,
  });
  if (!d.ok) throw new Error(d.error);
  return recordHeartbeat({
    userId,
    agentUserId: key.agentUserId ?? null,
    apiKeyId: key.apiKeyId ?? null,
    heartbeat: d.heartbeat,
  });
};
const rows = () =>
  q<Record<string, unknown>>(
    `SELECT * FROM agent_conversations ORDER BY first_seen_at`
  ).then((r) => r.rows);

beforeAll(async () => {
  await h.client!.exec(`
    CREATE TABLE users (id text PRIMARY KEY, agent_type text, host_user_id text);
    CREATE TABLE focus_sessions (id uuid PRIMARY KEY, user_id text NOT NULL);
  `);
  await h.client!.exec(sql("0342_session_runners.sql"));
  await h.client!.exec(sql("0354_agent_conversations.sql"));
  await q(
    `INSERT INTO users (id, agent_type, host_user_id) VALUES ($1, 'machine', NULL), ($2, 'claude-code', $1)`,
    [DEVBOX, ADA_AGENT]
  );
  await q(`INSERT INTO focus_sessions (id, user_id) VALUES ($1, $2)`, [
    ADA_SESSION,
    ADA,
  ]);
}, 120_000);

afterAll(async () => {
  await h.client?.close();
});

describe("recordHeartbeat — one row per conversation", () => {
  it("upserts idempotently; the computer's two spellings are one key; the machine is the key's", async () => {
    const first = await beat(
      ADA,
      { folder: "/Users/ada/code/synap/", subagents: 1 },
      { agentUserId: ADA_AGENT, apiKeyId: ADA_KEY }
    );
    expect(first.ok && first.answer.written).toBe(true);
    const again = await beat(
      ADA,
      { computer: "devbox", folder: "/Users/ada/code/synap/", subagents: 1 },
      { agentUserId: ADA_AGENT, apiKeyId: ADA_KEY }
    );
    // Unchanged inside the rewrite interval: nothing written, same row.
    expect(again.ok && again.answer.written).toBe(false);
    expect(again.ok && again.answer.conversation.id).toBe(
      first.ok && first.answer.conversation.id
    );
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      user_id: ADA,
      computer: "devbox",
      harness: "claude-code",
      conversation_id: CONV,
      folder: "synap",
      state: "working",
      subagent_count: 1,
      machine_user_id: DEVBOX,
      agent_user_id: ADA_AGENT,
      ended_at: null,
    });
    // The store's own never-stored floor: no path anywhere in the row.
    expect(JSON.stringify(all[0])).not.toMatch(/\/Users|\/code\//);
  });

  it("stateSince moves only when state changes", async () => {
    const before = (await rows())[0]!.state_since as Date;
    await sleep(15);
    const waiting = await beat(
      ADA,
      { state: "waiting", subagents: 1 },
      { agentUserId: ADA_AGENT, apiKeyId: ADA_KEY }
    );
    expect(waiting.ok && waiting.answer.written).toBe(true);
    const moved = (await rows())[0]!.state_since as Date;
    expect(moved.getTime()).toBeGreaterThan(before.getTime());
    // Folder omitted keeps the one it had.
    expect((await rows())[0]!.folder).toBe("synap");
    await sleep(15);
    // A sub-agent change rewrites the row but is not a state change.
    const sub = await beat(
      ADA,
      { state: "waiting", subagents: 3 },
      { agentUserId: ADA_AGENT, apiKeyId: ADA_KEY }
    );
    expect(sub.ok && sub.answer.written).toBe(true);
    const row = (await rows())[0]!;
    expect(row.subagent_count).toBe(3);
    expect((row.state_since as Date).getTime()).toBe(moved.getTime());
  });

  it("ended: true closes it (off the live list); a later beat reopens it", async () => {
    const ended = await beat(
      ADA,
      { state: "idle", ended: true },
      { agentUserId: ADA_AGENT, apiKeyId: ADA_KEY }
    );
    expect(ended.ok && ended.answer.conversation.endedAt).not.toBeNull();
    expect(await loadLiveTerminals(ADA)).toEqual([]);
    const reopened = await beat(
      ADA,
      { state: "working" },
      { agentUserId: ADA_AGENT, apiKeyId: ADA_KEY }
    );
    expect(reopened.ok && reopened.answer.conversation.endedAt).toBeNull();
    expect((await loadLiveTerminals(ADA)).map((t) => t.conversationId)).toEqual(
      [CONV]
    );
  });
});

describe("owner floor", () => {
  it("another person's beat for the same conversation is theirs, never in my list", async () => {
    const bob = await beat(BOB, { state: "idle" }, { apiKeyId: BOB_KEY });
    expect(bob.ok).toBe(true);
    expect(await rows()).toHaveLength(2);
    const mine = await loadLiveTerminals(ADA);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.state).toBe("working");
    const theirs = await loadLiveTerminals(BOB);
    expect(theirs).toHaveLength(1);
    expect(theirs[0]!.state).toBe("idle");
  });

  it("they cannot bind my session: 404, and no runner row", async () => {
    const r = await beat(
      BOB,
      { sessionId: ADA_SESSION },
      { apiKeyId: BOB_KEY }
    );
    expect(r).toEqual({
      ok: false,
      status: 404,
      error: `Focus session ${ADA_SESSION} not found`,
    });
    const runners = await q(`SELECT 1 FROM session_runners`);
    expect(runners.rows).toHaveLength(0);
  });
});

describe("the session link is session_runners", () => {
  it("a bound beat stamps the runner (no path), read back on the terminal and on the session", async () => {
    const r = await beat(
      ADA,
      { sessionId: ADA_SESSION, folder: "/Users/ada/code/synap" },
      { agentUserId: ADA_AGENT, apiKeyId: ADA_KEY }
    );
    expect(r.ok && r.answer.sessionId).toBe(ADA_SESSION);
    const runner = await q<Record<string, unknown>>(
      `SELECT * FROM session_runners`
    );
    expect(runner.rows).toHaveLength(1);
    expect(runner.rows[0]).toMatchObject({
      session_id: ADA_SESSION,
      client_key: `key:${ADA_KEY}|conv:claude-code:${CONV}`,
      user_id: ADA,
      harness: "claude-code",
      conversation_id: CONV,
      cwd: null,
      machine_user_id: DEVBOX,
    });

    const [terminal] = await loadLiveTerminals(ADA);
    expect(terminal!.sessionId).toBe(ADA_SESSION);

    const forAda = await loadSessionRunnerTerminals([ADA_SESSION], ADA);
    const [item] = forAda.get(ADA_SESSION)!;
    expect(item).toMatchObject({
      harness: "claude-code",
      conversationId: CONV,
      agentUserId: ADA_AGENT,
      machineId: DEVBOX,
      live: true,
      terminal: {
        computer: "devbox",
        folder: "synap",
        state: "working",
        subagents: 0,
        ended: false,
      },
    });
    // A member of a shared session (Bob) sees who is attached — never Ada's
    // terminal facts, nor his own row that happens to carry the same
    // conversation id: the terminal is the RUNNER's person's, for them only.
    const forBob = await loadSessionRunnerTerminals([ADA_SESSION], BOB);
    expect(forBob.get(ADA_SESSION)![0]!.conversationId).toBe(CONV);
    expect(forBob.get(ADA_SESSION)![0]!.terminal).toBeNull();
    const forCarol = await loadSessionRunnerTerminals([ADA_SESSION], "carol");
    expect(forCarol.get(ADA_SESSION)![0]!.terminal).toBeNull();
  });

  it("a key-less caller is recorded but cannot name a runner", async () => {
    const r = await beat(ADA, {
      conversationId: "other-conv",
      sessionId: ADA_SESSION,
    });
    expect(r.ok && r.answer.sessionId).toBeNull();
    expect(r.ok && r.answer.sessionLinkSkipped).toBe("no_api_key");
  });
});

describe("liveness window", () => {
  it("silence ages out of the live list", async () => {
    await q(
      `UPDATE agent_conversations SET last_seen_at = now() - make_interval(secs => $1) WHERE user_id = $2 AND conversation_id = 'other-conv'`,
      [CONVERSATION_LIVE_WINDOW_SECONDS + 60, ADA]
    );
    const live = await loadLiveTerminals(ADA);
    expect(live.map((t) => t.conversationId)).toEqual([CONV]);
  });
});
