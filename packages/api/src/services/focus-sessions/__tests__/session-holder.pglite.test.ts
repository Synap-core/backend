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
 * derivation, two doors). Sessions cockpit C4/C5 add:
 *   - a live runner saying `needs_answer` → the person, wait kind `answer`;
 *   - an ENDED runner with a roster → the agent, stopped (never "nobody");
 *   - THE CONVERGENCE GUARD: the rows' holder (`attachSessionHolder` over
 *     `attachSessionLiveness`, the list and graph doors' composition, every
 *     row in ONE batch) equals `readSessionHolder` row by row. Same code path,
 *     so it proves sameness only: a batch loader that mis-keys one session's
 *     facts onto another fails it, which one-row reads never could;
 *   - the bound: ~500 rows cost the same number of queries as 5.
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
import { attachSessionHolder, readSessionHolder } from "../session-holder.js";
import { attachSessionLiveness } from "../session-list-rows.js";
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
const S_ANSWER = randomUUID();
const S_RUNNER_ENDED = randomUUID();
/** The bound test's sessions: plain, unassigned. */
const BULK = Array.from({ length: 500 }, () => randomUUID());

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
  // 6. A question waits at the terminal: its runner says needs_answer.
  // 7. Its runner said `ended`: not live, the roster's live rule decides.
  const runnerRow = (sessionId: string, conv: string, state: string) =>
    q(
      `insert into session_runners (session_id, client_key, user_id, agent_user_id, api_key_id, harness, conversation_id, process_key, state, state_since, state_reported_at, first_seen_at, last_seen_at)
       values ($1, $2, $3, $4, $5, 'claude-code', $6, 'mac-a:4242:1761600000000', $7, now() - interval '40 seconds', now() - interval '40 seconds', now() - interval '5 minutes', now() - interval '10 seconds')`,
      [
        sessionId,
        `key:${randomUUID()}|conv:claude-code:${conv}`,
        OWNER,
        WORKER,
        randomUUID(),
        conv,
        state,
      ]
    );
  await session(S_ANSWER, { agentIds: [WORKER] });
  await runnerRow(S_ANSWER, "conv-2", "needs_answer");
  await session(S_RUNNER_ENDED, { agentIds: [WORKER] });
  await runnerRow(S_RUNNER_ENDED, "conv-3", "ended");
  // The bound's sessions, in one statement (a hook has seconds, not minutes).
  await q(
    `insert into focus_sessions (id, user_id, workspace_id, title, goal, status, origin, agent_ids, expected_outputs, metadata, started_at, created_at, updated_at)
     select id, $2, $3, 'Make a video', 'Do it', 'active', 'user', '{}'::text[], '[]'::jsonb, '{}'::jsonb, now(), now(), now()
     from unnest($1::uuid[]) as id`,
    [BULK, OWNER, W]
  );
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

describe("readSessionHolder — the runner words (cockpit C4)", () => {
  it("needs_answer: the person, wait kind answer, the agent named", async () => {
    expect(await read(S_ANSWER)).toMatchObject({
      status: "ok",
      holder: {
        kind: "person",
        waitKind: "answer",
        source: { from: "runner", state: "needs_answer" },
        agent: { agentUserId: WORKER },
      },
    });
  });

  it("an ended runner with a roster: the agent, stopped — never nobody", async () => {
    expect(await read(S_RUNNER_ENDED)).toMatchObject({
      status: "ok",
      holder: {
        kind: "agent",
        waitKind: "agent_stopped",
        agent: { agentUserId: WORKER },
      },
    });
  });
});

const CASES = [
  S_RUNNING,
  S_NOBODY_RUNS,
  S_HANDED_BACK,
  S_UNASSIGNED,
  S_CLOSED,
  S_ANSWER,
  S_RUNNER_ENDED,
];

/** The list and graph doors' composition: liveness attached, then the holder. */
const attachRows = async (ids: readonly string[]) =>
  attachSessionHolder(
    await attachSessionLiveness(await Promise.all(ids.map(row)), {
      userId: OWNER,
      roster: false,
    }),
    { userId: OWNER, roster: false }
  );

describe("the rows' holder (attachSessionHolder, cockpit C5)", () => {
  it("CONVERGENCE: every row's holder, read in one batch, is the session read's own answer", async () => {
    const rows = await attachRows(CASES);
    for (const r of rows) {
      expect({ id: r.id, holder: r.holder }).toEqual({
        id: r.id,
        holder: await readSessionHolder(await row(r.id), { userId: OWNER }),
      });
    }
    // Non-vacuity: the batch held every word the guard is about.
    const words = rows.map((r) =>
      r.holder.status === "ok" ? r.holder.holder.waitKind : "unavailable"
    );
    expect(words).toEqual(
      expect.arrayContaining(["agent_work", "answer", "agent_stopped", null])
    );
    expect(words).not.toContain("unavailable");
  });

  it("a failed fact makes THAT row unavailable, never nobody; the others still read", async () => {
    const rows = await Promise.all([S_RUNNING, S_UNASSIGNED].map(row));
    const [running, unassigned] = await attachSessionHolder(
      [
        { ...rows[0]!, live: null },
        { ...rows[1]!, live: undefined },
      ],
      { userId: OWNER }
    );
    expect(running!.holder).toEqual({
      status: "unavailable",
      reason: "Who has this session could not be read.",
    });
    expect(unassigned!.holder).toMatchObject({
      status: "ok",
      holder: { kind: "nobody", reason: "no_agent" },
    });
  });

  it("BOUND: ~500 rows cost the same number of queries as 5", async () => {
    const counted = async (ids: readonly string[]) => {
      const live = await attachSessionLiveness(
        await Promise.all(ids.map(row)),
        { userId: OWNER, roster: false }
      );
      const original = client.query.bind(client);
      let n = 0;
      client.query = ((...args: Parameters<typeof original>) => {
        n++;
        return original(...args);
      }) as typeof client.query;
      const started = performance.now();
      try {
        const out = await attachSessionHolder(live, { userId: OWNER });
        expect(out.every((r) => r.holder.status === "ok")).toBe(true);
      } finally {
        client.query = original;
      }
      return { n, ms: performance.now() - started };
    };
    const few = await counted([...BULK.slice(0, 4), S_RUNNING]);
    const many = await counted([...BULK, S_RUNNING]);
    expect(many.n).toBe(few.n);
    expect(many.n).toBeLessThanOrEqual(20);
    // The cost the PR reports (PGlite, one process): queries and time.
    console.info(
      `[holder bound] 5 rows: ${few.n} queries ${few.ms.toFixed(0)} ms; ${BULK.length + 1} rows: ${many.n} queries ${many.ms.toFixed(0)} ms`
    );
  });
});

describe("the packet's holder", () => {
  it("is the same answer as the standalone read", async () => {
    for (const id of [
      S_RUNNING,
      S_NOBODY_RUNS,
      S_HANDED_BACK,
      S_UNASSIGNED,
      S_ANSWER,
      S_RUNNER_ENDED,
    ]) {
      const r = await row(id);
      const packet = await projectContinuationPacket(r, { userId: OWNER });
      const alone = await readSessionHolder(r, { userId: OWNER });
      expect(packet.holder).toEqual(alone);
    }
  });
});
