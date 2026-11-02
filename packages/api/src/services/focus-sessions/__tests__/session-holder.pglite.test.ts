/**
 * WHO HAS IT — `readSessionHolder` and the packet's `holder` section, read
 * back out of PGlite with every @synap/database table.
 *
 * Pinned (the five cases B8 builds its screens on):
 *   - a session held by a running worker: its live runner says `busy` → the
 *     agent at work, named "<agent> on <computer>", served (nobodyRuns false);
 *   - held, but nothing runs the agent (its computer's runner stamp is older
 *     than the live window): the agent, stopped, `nobodyRuns: true`;
 *   - handed back to the person: the agent is not at work and the person owes
 *     a slot → the person, with the slot's wait kind, the agent still named;
 *   - unassigned: no agent anywhere → nobody (`no_agent`);
 *   - a failed read is `unavailable`, never "nobody";
 * and the packet's section is the same answer as the standalone read (one
 * derivation, two doors).
 *
 * Only `getEffectiveLifecycle` is stubbed (no lifecycle is under test).
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.setConfig({ testTimeout: 120_000 });

const holder = vi.hoisted(() => ({ db: undefined as unknown }));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const mocked = {
    ...actual,
    getDb: async () => holder.db,
    ProfileResolutionService: class extends (actual.ProfileResolutionService as new (
      db: unknown
    ) => object) {
      async getEffectiveLifecycle() {
        return null;
      }
    },
  };
  Object.defineProperty(mocked, "db", {
    get: () => holder.db,
    enumerable: true,
  });
  return mocked;
});

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import * as schema from "@synap/database/schema";
import {
  allSchemaTables,
  pgliteTableDdl,
} from "../../../__tests__/pglite-ddl.js";
import { PULL_LIVE_WINDOW_MS } from "../../agent-presence.js";
import { readSessionHolder } from "../session-holder.js";
import { projectContinuationPacket } from "../continuation-packet.js";

const OWNER = randomUUID();
const W = randomUUID();
/** The owner's computer, named "devbox". */
const DEVBOX = randomUUID();
/** On DEVBOX; its worker served it 30 s ago. */
const WORKER = randomUUID();
/** On DEVBOX; its worker last served it two hours ago. */
const STALE = randomUUID();

const S_RUNNING = randomUUID();
const S_NOBODY_RUNS = randomUUID();
const S_HANDED_BACK = randomUUID();
const S_UNASSIGNED = randomUUID();
const S_CLOSED = randomUUID();

let client: PGlite;
const q = (sql: string, params: unknown[] = []) => client.query(sql, params);
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
/** When the agent handed the credential back. */
const OWED_SINCE = ago(120_000);

async function session(
  id: string,
  o: { status?: string; agentIds?: string[]; outputs?: unknown[] } = {}
) {
  await q(
    `insert into focus_sessions (id, user_id, workspace_id, title, goal, status, origin, agent_ids, expected_outputs, metadata, started_at, created_at, updated_at)
     values ($1, $2, $3, 'Make a video', 'Do it', $4, 'user', $5::text[], $6::jsonb, '{}'::jsonb, now(), now(), now())`,
    [
      id,
      OWNER,
      W,
      o.status ?? "active",
      o.agentIds ?? [],
      JSON.stringify(o.outputs ?? []),
    ]
  );
}

const row = async (id: string) => {
  const db = holder.db as ReturnType<typeof drizzle<typeof schema>>;
  const [r] = await db
    .select()
    .from(schema.focusSessions)
    .where(eq(schema.focusSessions.id, id));
  if (!r) throw new Error(`no session ${id}`);
  return r;
};

beforeAll(async () => {
  client = new PGlite();
  for (const t of allSchemaTables()) await client.exec(pgliteTableDdl(t));
  holder.db = drizzle(client, { schema });

  await q(
    `insert into users (id, email, name, user_type) values ($1, 'o@x.test', 'Owner', 'human')`,
    [OWNER]
  );
  await q(
    `insert into workspaces (id, owner_id, name, workspace_type) values ($1, $2, 'Content OS', 'personal')`,
    [W, OWNER]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, 'owner')`,
    [randomUUID(), W, OWNER]
  );
  const agent = (
    id: string,
    name: string,
    agentType: string,
    host: string | null
  ) =>
    q(
      `insert into users (id, email, name, user_type, agent_type, created_by_user_id, host_user_id) values ($1, $2, $3, 'agent', $4, $5, $6)`,
      [id, `${id}@x.test`, name, agentType, OWNER, host]
    );
  await agent(DEVBOX, "devbox", "machine", null);
  await agent(WORKER, "Claude Code", "claude-code", DEVBOX);
  await agent(STALE, "Codex", "codex", DEVBOX);
  const key = (agentId: string, servedAt: string) =>
    q(
      `insert into api_keys (id, user_id, key_type, linked_user_id, is_active, last_used_at, instance_label, worker_served_at, created_at)
       values ($1, $2, 'hub_inbound', $3, true, $4, 'devbox', $4, now())`,
      [randomUUID(), agentId, OWNER, servedAt]
    );
  await key(WORKER, ago(30_000));
  await key(STALE, ago(PULL_LIVE_WINDOW_MS + 3_600_000));

  // 1. Held by a running worker: its runner is live and says busy.
  await session(S_RUNNING, { agentIds: [WORKER] });
  await q(
    `insert into session_runners (session_id, client_key, user_id, agent_user_id, api_key_id, harness, conversation_id, process_key, state, state_since, state_reported_at, first_seen_at, last_seen_at)
     values ($1, $2, $3, $4, $5, 'claude-code', 'conv-1', '', 'busy', now() - interval '20 seconds', now() - interval '20 seconds', now() - interval '5 minutes', now() - interval '10 seconds')`,
    [
      S_RUNNING,
      `key:${randomUUID()}|conv:claude-code:conv-1`,
      OWNER,
      WORKER,
      randomUUID(),
    ]
  );
  // 2. Held, but nothing runs the agent now.
  await session(S_NOBODY_RUNS, { agentIds: [STALE] });
  // 3. Handed back: the agent asked for a credential and stopped.
  await session(S_HANDED_BACK, {
    agentIds: [WORKER],
    outputs: [
      {
        key: "stripe-key",
        label: "Stripe key",
        kind: "secret",
        owner: "human",
        status: "pending",
        blockedReason: "credential",
        owedSince: OWED_SINCE,
      },
    ],
  });
  // 4. Unassigned: no agent on it.
  await session(S_UNASSIGNED);
  // 5. Ended.
  await session(S_CLOSED, { status: "closed", agentIds: [WORKER] });
});

const read = async (id: string) =>
  readSessionHolder(await row(id), { userId: OWNER });

describe("readSessionHolder", () => {
  it("a session held by a running worker: the agent at work, on its computer, served", async () => {
    const section = await read(S_RUNNING);
    expect(section.status).toBe("ok");
    if (section.status !== "ok") return;
    expect(section.holder).toMatchObject({
      kind: "agent",
      waitKind: "agent_work",
      source: { from: "runner", state: "busy" },
      agent: {
        agentUserId: WORKER,
        displayName: "Claude Code on devbox",
        computer: { agentUserId: DEVBOX, name: "devbox", source: "host" },
        reach: "pull",
        nobodyRuns: false,
      },
    });
    expect(section.holder.since).not.toBeNull();
  });

  it("held but nothing runs the agent: stopped, and nobodyRuns says so", async () => {
    const section = await read(S_NOBODY_RUNS);
    expect(section).toMatchObject({
      status: "ok",
      holder: {
        kind: "agent",
        waitKind: "agent_stopped",
        source: { from: "live", working: false },
        agent: {
          agentUserId: STALE,
          displayName: "Codex on devbox",
          nobodyRuns: true,
        },
      },
    });
  });

  it("handed back to the person: the person's wait kind, the agent still named", async () => {
    const section = await read(S_HANDED_BACK);
    expect(section).toMatchObject({
      status: "ok",
      holder: {
        kind: "person",
        waitKind: "access",
        since: OWED_SINCE,
        source: { from: "waiting_on" },
        agent: { agentUserId: WORKER },
      },
    });
  });

  it("unassigned: nobody, because no agent is on it", async () => {
    expect(await read(S_UNASSIGNED)).toEqual({
      status: "ok",
      holder: {
        kind: "nobody",
        waitKind: null,
        since: null,
        agent: null,
        source: { from: "roster" },
        reason: "no_agent",
      },
    });
  });

  it("an ended session: nobody, because it ended", async () => {
    expect(await read(S_CLOSED)).toMatchObject({
      status: "ok",
      holder: { kind: "nobody", reason: "ended", agent: null },
    });
  });

  it("a failed read is unavailable, never nobody", async () => {
    const broken = {
      select: () => {
        throw new Error("connection reset");
      },
    } as never;
    for (const id of [S_RUNNING, S_UNASSIGNED]) {
      const section = await readSessionHolder(await row(id), {
        userId: OWNER,
        database: broken,
      });
      expect(section).toEqual({
        status: "unavailable",
        reason: "Who has this session could not be read.",
      });
    }
  });
});

describe("the packet's holder", () => {
  it("is the same answer as the standalone read", async () => {
    for (const id of [S_RUNNING, S_NOBODY_RUNS, S_HANDED_BACK, S_UNASSIGNED]) {
      const r = await row(id);
      const packet = await projectContinuationPacket(r, { userId: OWNER });
      const alone = await readSessionHolder(r, { userId: OWNER });
      expect(packet.holder).toEqual(alone);
    }
  });
});
