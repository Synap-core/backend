/**
 * Capture "Give to agent" (W8) — the capture becomes work the agent SEES.
 *
 * Driven through the real service and read back out of PGlite:
 *   - the new session is the PERSON's, its goal is the capture's words, the
 *     agent is on its roster, and its parent is the capture's intake run;
 *   - that agent's orient (`buildStartHere` → `handedToYou`) lists it; ANOTHER
 *     agent's does not;
 *   - the answer is honest: "Delivered when <agent> checks in", its last-seen
 *     time, never "sent";
 *   - a foreign capture, an agent off the roster, and a house agent (nothing
 *     would ever pick it up) are refused and write nothing;
 *   - giving the same capture again returns the open session (idempotent).
 *   - a BOUND agent (reach 'dispatch') is PUSHED: its binding's capability's
 *     hand-off playbook runs with the capture as the task, the line says what
 *     the run did, a live/proposed hand-off is never started twice, and a
 *     binding whose template ships no hand-off playbook is refused by name.
 *
 * Real: `giveCaptureToAgent`, `scopedDb` (documents floor), `queryAgentUsers`
 * (roster floor), `loadAgentPresence`, `createFocusSession`, `buildStartHere`'s
 * `handedToYou` read. Stubbed: governance (granted), the session room, the
 * spawn edge writer (its own connection), realtime, project placement.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  vi,
} from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    close: () => Promise<void>;
  },
  spawns: [] as Array<Record<string, unknown>>,
  runs: [] as Array<Record<string, unknown>>,
  runStatus: "running" as string,
  runError: null as string | null,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  return {
    ...actual,
    db: drizzle(client, {
      schema: {
        focusSessions: actual.focusSessions as never,
        playbooks: actual.playbooks as never,
        documents: actual.documents as never,
        documentVersions: actual.documentVersions as never,
        users: actual.users as never,
        workspaceMembers: actual.workspaceMembers as never,
        apiKeys: actual.apiKeys as never,
      },
    }),
    recordSessionSpawn: async (input: Record<string, unknown>) => {
      h.spawns.push(input);
      return { linked: true, suspendedIntentRecorded: false };
    },
    resolveSessionProjectPlacement: async () => ({ projectId: null }),
  };
});
vi.mock("../../../utils/permission-check.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    checkPermissionOrPropose: async () => ({ granted: true }),
  };
});
vi.mock(
  "../../focus-sessions/ensure-session-channel.js",
  async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return { ...actual, ensureSessionChannel: async () => null };
  }
);
// The ONE run door, stubbed AT the door: it records the call and writes the
// session + run rows a real run writes, so the dedupe reads real data.
vi.mock("../../playbooks/run-playbook.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    runPlaybook: async (input: Record<string, unknown>) => {
      h.runs.push(input);
      const { randomUUID } = await import("node:crypto");
      const sessionId = randomUUID();
      const runId = randomUUID();
      await h.client!.query(
        `insert into focus_sessions (id, user_id, goal, status, expected_outputs, agent_ids, metadata, created_at, updated_at, started_at)
         values ($1, $2, $3, 'active', '[]'::jsonb, '{}', '{}'::jsonb, now(), now(), now())`,
        [sessionId, input.userId, (input.params as { task: string }).task]
      );
      await h.client!.query(
        `insert into playbook_runs (id, playbook_id, session_id, executor, status, input, created_by, error, started_at)
         values ($1, $2, $3, 'external-agent', $4, $5::jsonb, $6, $7, now())`,
        [
          runId,
          input.playbookId,
          sessionId,
          h.runStatus,
          JSON.stringify(input.params),
          input.userId,
          h.runError,
        ]
      );
      return {
        run: { id: runId, status: h.runStatus, error: h.runError },
        session: { id: sessionId },
      };
    },
  };
});
vi.mock("../../../utils/domain-event-bridge.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, emitHubRealtimeEvent: () => undefined };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as database from "@synap/database";
import { is } from "drizzle-orm";
import { PgTable as PgTableClass } from "drizzle-orm/pg-core";
import { AccessContext } from "../../../access/index.js";
import { giveCaptureToAgent } from "../give-to-agent.js";
import { buildStartHere } from "../../discover/start-here.js";

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "99999999-9999-4999-8999-999999999999";
const AGENT = "22222222-2222-4222-8222-222222222222";
const AGENT_B = "33333333-3333-4333-8333-333333333333";
const HOUSE = "44444444-4444-4444-8444-444444444444";
/** An agent another person operates — visible on the pod-wide roster. */
const THEIRS = "55555555-5555-4555-8555-555555555555";
/** An agent the person OWNS, bound for dispatch — no key, never seen. */
const BOUND = "66666666-6666-4666-8666-666666666666";
/** Bound too, but its capability ships no hand-off playbook. */
const BOUND_BARE = "77777777-7777-4777-8777-777777777777";
const WS = "88888888-8888-4888-8888-888888888888";
const TOOL = "a0000000-0000-4000-8000-000000000001";
const TOOL_BARE = "a0000000-0000-4000-8000-000000000002";
const CAP = "b0000000-0000-4000-8000-000000000001";
const CAP_BARE = "b0000000-0000-4000-8000-000000000002";
const HAND_OFF = "c0000000-0000-4000-8000-000000000001";
/** Same capability, but NOT a hand-off (another executor) — never picked. */
const OTHER_PLAYBOOK = "c0000000-0000-4000-8000-000000000002";
const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = t.endsWith("[]") ? t : BASIC.test(t) ? t : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key default gen_random_uuid()" : ""}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const access = AccessContext.from({ userId: USER });

async function seedCapture(opts: {
  owner?: string;
  text?: string;
  runId?: string | null;
}): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into documents (id, user_id, title, type, metadata, created_at, updated_at)
     values ($1, $2, 'Capture', 'text', $3::jsonb, now(), now())`,
    [
      id,
      opts.owner ?? USER,
      JSON.stringify({
        intakeSource: {
          version: 1,
          kind: "text",
          contentHash: "h",
          sessionId: opts.runId ?? null,
          door: "relay",
        },
      }),
    ]
  );
  await q(
    `insert into document_versions (id, document_id, version, content, created_at)
     values ($1, $2, 1, $3, now())`,
    [
      randomUUID(),
      id,
      opts.text ?? "Draft a LinkedIn post about our pricing change",
    ]
  );
  return id;
}

async function seedRun(): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, goal, status, expected_outputs, agent_ids, metadata, created_at, updated_at, started_at)
     values ($1, $2, 'intake', 'closed', '[]'::jsonb, '{}', '{}'::jsonb, now(), now(), now())`,
    [id, USER]
  );
  return id;
}

const handedTo = async (agentUserId: string) => {
  const s = await buildStartHere({
    caller: {} as never,
    userId: USER,
    agentUserId,
    pending: { status: "unavailable" },
    learnMoreSkill: "system/synap/concepts",
  });
  return s.handedToYou;
};

// One PGlite for both suites — closed once, after the last.
afterAll(async () => {
  await h.client?.close();
});

describe("captures.giveToAgent", () => {
  beforeAll(async () => {
    // EVERY table the database package declares: the documents VisibilityRule
    // and the create door join across many of them, and a hand list falls
    // behind the rule the moment it grows a join.
    const seen = new Set<string>();
    for (const t of Object.values(database)) {
      if (!is(t, PgTableClass)) continue;
      const name = getTableConfig(t as PgTable).name;
      if (seen.has(name)) continue;
      seen.add(name);
      await h.client!.exec(ddlFor(t as PgTable));
    }
    expect(seen.size).toBeGreaterThan(50);
    await q(
      `insert into users (id, email, name, user_type, created_via, is_personal_agent) values
        ($1, 'a@x.test', 'Antoine', 'human', null, false),
        ($2, 'cc@x.test', 'Claude Code', 'agent', 'cli', false),
        ($3, 'cx@x.test', 'Codex', 'agent', 'cli', false),
        ($4, 'twin@x.test', 'Twin', 'agent', null, true),
        ($5, 'o@x.test', 'Other', 'human', null, false),
        ($6, 'theirs@x.test', 'Their Claude', 'agent', 'cli', false)`,
      [USER, AGENT, AGENT_B, HOUSE, OTHER, THEIRS]
    );
    // Operator links: AGENT and AGENT_B act for USER; THEIRS acts for OTHER.
    await q(
      `insert into api_keys (id, user_id, key_type, is_active, last_used_at, instance_id, linked_user_id) values
        ($1, $2, 'hub_inbound', true, '2026-09-28T08:00:00Z', 'mbp', $3),
        ($4, $5, 'hub_inbound', true, null, null, $3),
        ($6, $7, 'hub_inbound', true, null, null, $8)`,
      [
        randomUUID(),
        AGENT,
        USER,
        randomUUID(),
        AGENT_B,
        randomUUID(),
        THEIRS,
        OTHER,
      ]
    );
  }, 120_000);

  beforeEach(async () => {
    h.spawns.length = 0;
    await q(`delete from focus_sessions`);
  });

  it("files the capture as the person's session, on the agent's roster, under the capture's run", async () => {
    const runId = await seedRun();
    const captureId = await seedCapture({ runId });
    const r = await giveCaptureToAgent({
      access,
      userId: USER,
      captureId,
      agentUserId: AGENT,
    });
    expect(r).toMatchObject({
      status: "given",
      deduped: false,
      delivery: "on_check_in",
      line: "Delivered when Claude Code checks in",
      agent: { id: AGENT, name: "Claude Code" },
      roster: [{ id: AGENT, name: "Claude Code" }],
    });
    if (r.status !== "given") throw new Error("unreachable");
    expect(r.agent?.lastSeenAt).toBe("2026-09-28T08:00:00.000Z");

    const row = await q<{ user_id: string; goal: string; agent_ids: string[] }>(
      `select user_id, goal, agent_ids from focus_sessions where id = $1`,
      [r.sessionId]
    );
    expect(row.rows[0]).toMatchObject({
      user_id: USER,
      goal: "Draft a LinkedIn post about our pricing change",
      agent_ids: [AGENT],
    });
    // The capture's run is the parent (the capture's detail lists it).
    expect(h.spawns).toHaveLength(1);
    expect(h.spawns[0]).toMatchObject({
      childSessionId: r.sessionId,
      parentSessionId: runId,
    });
  });

  it("the agent's orient lists it under handedToYou; another agent's does not", async () => {
    const captureId = await seedCapture({});
    const r = await giveCaptureToAgent({
      access,
      userId: USER,
      captureId,
      agentUserId: AGENT,
    });
    if (r.status !== "given") throw new Error(r.status);
    const mine = await handedTo(AGENT);
    expect(mine).toMatchObject({ count: 1, items: [{ id: r.sessionId }] });
    expect(await handedTo(AGENT_B)).toMatchObject({ count: 0, items: [] });
  });

  it("giving the same capture again returns the open session", async () => {
    const captureId = await seedCapture({});
    const a = await giveCaptureToAgent({
      access,
      userId: USER,
      captureId,
      agentUserId: AGENT,
    });
    const b = await giveCaptureToAgent({
      access,
      userId: USER,
      captureId,
      agentUserId: AGENT,
    });
    if (a.status !== "given" || b.status !== "given")
      throw new Error("not given");
    expect(b.sessionId).toBe(a.sessionId);
    expect(b.deduped).toBe(true);
  });

  it("a repeat naming ANOTHER agent appends it to the open session's roster; the line names the real roster", async () => {
    const captureId = await seedCapture({});
    const a = await giveCaptureToAgent({
      access,
      userId: USER,
      captureId,
      agentUserId: AGENT,
    });
    const b = await giveCaptureToAgent({
      access,
      userId: USER,
      captureId,
      agentUserId: AGENT_B,
    });
    if (a.status !== "given" || b.status !== "given")
      throw new Error("not given");
    expect(b.sessionId).toBe(a.sessionId);
    expect(b.deduped).toBe(true);
    const row = await q<{ agent_ids: string[] }>(
      `select agent_ids from focus_sessions where id = $1`,
      [b.sessionId]
    );
    expect(row.rows[0]!.agent_ids).toEqual([AGENT, AGENT_B]);
    expect(b.roster.map((r) => r.id)).toEqual([AGENT, AGENT_B]);
    expect(b.line).toBe("Delivered when Claude Code or Codex checks in");
    // Codex can now actually see it.
    expect(await handedTo(AGENT_B)).toMatchObject({
      items: [{ id: b.sessionId }],
    });
  });

  it("another person's agent cannot be picked (it would never see the work)", async () => {
    const captureId = await seedCapture({});
    expect(
      await giveCaptureToAgent({
        access,
        userId: USER,
        captureId,
        agentUserId: THEIRS,
      })
    ).toEqual({ status: "agent_not_found" });
    const n = await q<{ n: number }>(
      `select count(*)::int as n from focus_sessions`
    );
    expect(n.rows[0]!.n).toBe(0);
  });

  it("no agent named ⇒ honest 'next agent that checks in'", async () => {
    const captureId = await seedCapture({});
    const r = await giveCaptureToAgent({ access, userId: USER, captureId });
    expect(r).toMatchObject({
      status: "given",
      agent: null,
      roster: [],
      line: "Delivered to the next agent that checks in",
    });
  });

  it("refuses a foreign capture, an unknown agent and a house agent — writing nothing", async () => {
    const foreign = await seedCapture({ owner: OTHER });
    expect(
      await giveCaptureToAgent({
        access,
        userId: USER,
        captureId: foreign,
        agentUserId: AGENT,
      })
    ).toEqual({ status: "not_found" });

    const mine = await seedCapture({});
    expect(
      await giveCaptureToAgent({
        access,
        userId: USER,
        captureId: mine,
        agentUserId: OTHER,
      })
    ).toEqual({ status: "agent_not_found" });
    expect(
      await giveCaptureToAgent({
        access,
        userId: USER,
        captureId: mine,
        agentUserId: HOUSE,
      })
    ).toMatchObject({ status: "agent_not_wakeable" });

    const n = await q<{ n: number }>(
      `select count(*)::int as n from focus_sessions`
    );
    expect(n.rows[0]!.n).toBe(0);
  });
});

describe("captures.giveToAgent — a BOUND agent is pushed", () => {
  beforeAll(async () => {
    await q(
      `insert into users (id, email, name, user_type, created_via, is_personal_agent, created_by_user_id) values
        ($1, 'ccr@x.test', 'Claude Code (cloud)', 'agent', 'cli', false, $3),
        ($2, 'cma@x.test', 'Managed', 'agent', 'cli', false, $3)`,
      [BOUND, BOUND_BARE, USER]
    );
    const binding = JSON.stringify({
      agentBinding: {
        protocol: "claude-code-routines",
        provider: "claude-code",
        supports: { push: false, inputRequired: false, cancel: false },
        verbs: { start: "ccr_dispatch", send: "ccr_send" },
      },
    });
    await q(
      `insert into tools (id, workspace_id, created_by, name, kind, executor, status, config, input_schema, capabilities, created_at, updated_at) values
        ($1, $3, $4, 'claude_code_routines', 'external', 'external-agent', 'active', $5::jsonb, '{}'::jsonb, '[]'::jsonb, now(), now()),
        ($2, $3, $4, 'claude_managed_agents', 'external', 'external-agent', 'active', $5::jsonb, '{}'::jsonb, '[]'::jsonb, now(), now())`,
      [TOOL, TOOL_BARE, WS, USER, binding]
    );
    await q(
      `insert into playbooks (id, workspace_id, created_by, name, executor, status, params, stages, metadata, created_at, updated_at) values
        ($1, $3, $4, 'Hand off to Claude Code', 'external-agent', 'active', '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, now(), now()),
        ($2, $3, $4, 'Routine digest', 'is-agent', 'active', '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, now() - interval '1 day', now())`,
      [HAND_OFF, OTHER_PLAYBOOK, WS, USER]
    );
    const edge = (
      fromType: string,
      fromId: string,
      toType: string,
      toId: string,
      linkType: string
    ) =>
      q(
        `insert into links (id, from_type, from_id, to_type, to_id, link_type, metadata, created_at) values ($1, $2, $3, $4, $5, $6, '{}'::jsonb, now())`,
        [randomUUID(), fromType, fromId, toType, toId, linkType]
      );
    await edge("participant", BOUND, "tool", TOOL, "dispatched_via");
    await edge("participant", BOUND_BARE, "tool", TOOL_BARE, "dispatched_via");
    await edge("tool", TOOL, "capability", CAP, "member_of");
    await edge("tool", TOOL_BARE, "capability", CAP_BARE, "member_of");
    await edge("playbook", HAND_OFF, "capability", CAP, "member_of");
    await edge("playbook", OTHER_PLAYBOOK, "capability", CAP, "member_of");
  });

  beforeEach(async () => {
    h.runs.length = 0;
    h.runStatus = "running";
    h.runError = null;
    await q(`delete from playbook_runs`);
  });

  it("runs the binding's hand-off playbook with the capture as the task, and says it was sent", async () => {
    const runId = await seedRun();
    const captureId = await seedCapture({
      runId,
      text: "Fix the flaky login test",
    });
    const r = await giveCaptureToAgent({
      access,
      userId: USER,
      captureId,
      agentUserId: BOUND,
    });
    expect(r).toMatchObject({
      status: "given",
      deduped: false,
      delivery: "sent",
      line: "Sent to Claude Code (cloud)",
      agent: { id: BOUND, name: "Claude Code (cloud)", lastSeenAt: null },
    });
    expect(h.runs).toHaveLength(1);
    expect(h.runs[0]).toMatchObject({
      playbookId: HAND_OFF,
      workspaceId: WS,
      userId: USER,
      params: {
        task: "Fix the flaky login test",
        agentUserId: BOUND,
        captureId,
      },
      parentSessionId: runId,
      onMissingRequired: "owe",
    });
  });

  it("giving it again while the hand-off is live returns that session — never a second start", async () => {
    const captureId = await seedCapture({});
    const a = await giveCaptureToAgent({
      access,
      userId: USER,
      captureId,
      agentUserId: BOUND,
    });
    const b = await giveCaptureToAgent({
      access,
      userId: USER,
      captureId,
      agentUserId: BOUND,
    });
    if (a.status !== "given" || b.status !== "given")
      throw new Error("not given");
    expect(b).toMatchObject({
      sessionId: a.sessionId,
      deduped: true,
      delivery: "sent",
    });
    expect(h.runs).toHaveLength(1);
  });

  it("a start waiting on approval says so, and is not started twice either", async () => {
    h.runStatus = "proposed";
    const captureId = await seedCapture({});
    const a = await giveCaptureToAgent({
      access,
      userId: USER,
      captureId,
      agentUserId: BOUND,
    });
    expect(a).toMatchObject({
      delivery: "awaiting_approval",
      line: "Sending this to Claude Code (cloud) needs your approval",
    });
    const b = await giveCaptureToAgent({
      access,
      userId: USER,
      captureId,
      agentUserId: BOUND,
    });
    expect(b).toMatchObject({ deduped: true, delivery: "awaiting_approval" });
    expect(h.runs).toHaveLength(1);
  });

  it("a failed start says why — and giving it again starts a fresh one", async () => {
    h.runStatus = "failed";
    h.runError = "the Claude Code agent did not accept the task: 429";
    const captureId = await seedCapture({});
    const a = await giveCaptureToAgent({
      access,
      userId: USER,
      captureId,
      agentUserId: BOUND,
    });
    expect(a).toMatchObject({
      delivery: "not_sent",
      line: "Not sent to Claude Code (cloud): the Claude Code agent did not accept the task: 429",
    });
    h.runStatus = "running";
    h.runError = null;
    const b = await giveCaptureToAgent({
      access,
      userId: USER,
      captureId,
      agentUserId: BOUND,
    });
    expect(b).toMatchObject({ deduped: false, delivery: "sent" });
    expect(h.runs).toHaveLength(2);
  });

  it("a binding whose template ships no hand-off playbook is refused by name, and nothing runs", async () => {
    const captureId = await seedCapture({});
    const r = await giveCaptureToAgent({
      access,
      userId: USER,
      captureId,
      agentUserId: BOUND_BARE,
    });
    expect(r).toMatchObject({ status: "agent_not_wakeable" });
    if (r.status !== "agent_not_wakeable") throw new Error("unreachable");
    expect(r.message).toMatch(/ships no hand-off playbook/);
    expect(h.runs).toHaveLength(0);
  });
});
