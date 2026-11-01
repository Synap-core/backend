/**
 * WHERE A RUN RAN — `withRunWhere`, derived at read time from what records it
 * (computers plan v2 §0.5, plan v1 W3.6). PGLITE over the real tables: the
 * facts are a box run's lease, a session's runner rows, its roster, an
 * agent's computer and reach.
 *
 * Pinned, one run per case:
 *   - a box run names the computer that leased it, with whose it is; a box
 *     run still queued is unknown (null), never "the pod";
 *   - a session names its newest runner's computer over its roster;
 *     with no runner, its first roster agent's place; with nobody, unknown;
 *   - a playbook run reads its session;
 *   - an agent write: its computer; an outside client with no computer is
 *     "outside"; a pod agent is "pod"; a computer's own key is that computer;
 *   - automations, captures, chats and other capability runs: the pod;
 *   - a FAILED read leaves `where` absent (not read), never null or "pod".
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
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

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { withRunWhere } from "../run-where.js";
import type { UnifiedRun } from "../types.js";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = t.endsWith("[]") ? t : BASIC.test(t) ? t : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key default gen_random_uuid()" : ""}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}
const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const PERSON = randomUUID();
const DEVBOX = randomUUID();
const MAC = randomUUID();
/** Claude Code on the devbox. */
const ON_DEVBOX = randomUUID();
/** Claude Code on the Mac. */
const ON_MAC = randomUUID();
/** An outside client with a key and no computer (claude.ai, Raycast). */
const OUTSIDE = randomUUID();
/** A pod agent: no key of its own, the pod runs it. */
const POD_AGENT = randomUUID();

const BOX_LEASED = randomUUID();
const BOX_QUEUED = randomUUID();
const S_RUNNER = randomUUID();
const S_ROSTER = randomUUID();
const S_NOBODY = randomUUID();
const S_OF_PLAYBOOK = randomUUID();
const PLAYBOOK_RUN = randomUUID();

function run(
  flowType: UnifiedRun["flowType"],
  id: string,
  triggeredBy: string | null = null
): UnifiedRun {
  return {
    id,
    flowType,
    flowId: null,
    flowName: flowType,
    status: "completed",
    startedAt: new Date("2026-11-01T10:00:00Z"),
    completedAt: null,
    lastActivityAt: null,
    workspaceId: null,
    projectId: null,
    subjectEntityId: null,
    channelId: null,
    correlationId: null,
    replayOf: null,
    summary: null,
    error: null,
    triggeredBy,
    stepsCompleted: null,
    stepsFailed: null,
    definitionVersion: null,
  };
}

beforeAll(async () => {
  for (const t of Object.values(schema)) {
    if (is(t, PgTable)) await h.client!.exec(ddlFor(t));
  }
  const agent = (
    id: string,
    name: string,
    agentType: string,
    host: string | null = null,
    belongsTo: string | null = null
  ) =>
    q(
      `insert into users (id, email, name, user_type, agent_type, created_by_user_id, host_user_id, computer_belongs_to)
       values ($1, $2, $3, 'agent', $4, $5, $6, $7)`,
      [id, `${id}@x.test`, name, agentType, PERSON, host, belongsTo]
    );
  await q(
    `insert into users (id, email, name, user_type) values ($1, 'p@x.test', 'Person', 'human')`,
    [PERSON]
  );
  await agent(DEVBOX, "devbox", "machine", null, "agent");
  await agent(MAC, "MacBook", "machine", null, "person");
  await agent(ON_DEVBOX, "Claude Code", "claude-code", DEVBOX);
  await agent(ON_MAC, "Claude Code", "claude-code", MAC);
  await agent(OUTSIDE, "Claude (Web)", "claude-web");
  await agent(POD_AGENT, "Planner", "planner");
  // An outside client is one with a key of its own (reach `pull`).
  await q(
    `insert into api_keys (id, user_id, key_name, key_prefix, key_hash, key_type) values ($1, $2, 'k', 'p', 'h', 'user_pat')`,
    [randomUUID(), OUTSIDE]
  );

  await q(
    `insert into box_runs (id, user_id, spec, status, leased_by) values
       ($1, $3, '{}'::jsonb, 'running', $4),
       ($2, $3, '{}'::jsonb, 'queued', null)`,
    [BOX_LEASED, BOX_QUEUED, PERSON, DEVBOX]
  );

  const session = (id: string, agentIds: string[]) =>
    q(
      `insert into focus_sessions (id, user_id, goal, status, agent_ids) values ($1, $2, 'g', 'active', $3)`,
      [id, PERSON, agentIds]
    );
  // Roster says the Mac's agent; the runner that held its wait ran on the devbox.
  await session(S_RUNNER, [ON_MAC]);
  await session(S_ROSTER, [ON_MAC]);
  await session(S_NOBODY, []);
  await session(S_OF_PLAYBOOK, [ON_DEVBOX]);
  const runner = (sessionId: string, machine: string, lastSeenAt: string) =>
    q(
      `insert into session_runners (session_id, client_key, user_id, harness, conversation_id, machine_user_id, last_seen_at)
       values ($1, $2, $3, 'claude-code', $2, $4, $5)`,
      [sessionId, randomUUID(), PERSON, machine, lastSeenAt]
    );
  await runner(S_RUNNER, MAC, "2026-11-01T09:00:00Z");
  await runner(S_RUNNER, DEVBOX, "2026-11-01T10:00:00Z");
  await q(
    `insert into playbook_runs (id, playbook_id, created_by, session_id, status) values ($1, $2, $3, $4, 'running')`,
    [PLAYBOOK_RUN, randomUUID(), PERSON, S_OF_PLAYBOOK]
  );
});

const DEVBOX_WHERE = {
  kind: "computer",
  computer: { id: DEVBOX, name: "devbox", belongsTo: "agent" },
};

async function whereOf(r: UnifiedRun) {
  const [out] = await withRunWhere([r]);
  return out!.where;
}

describe("withRunWhere — where a run ran, read from what records it", () => {
  it("a box run names the computer holding its lease; a queued one is unknown", async () => {
    expect(await whereOf(run("capability", BOX_LEASED))).toEqual(DEVBOX_WHERE);
    expect(await whereOf(run("capability", BOX_QUEUED))).toBeNull();
  });

  it("a session names its newest runner's computer over its roster", async () => {
    expect(await whereOf(run("session", S_RUNNER))).toEqual(DEVBOX_WHERE);
  });

  it("with no runner, its first roster agent's computer; with nobody, unknown", async () => {
    expect(await whereOf(run("session", S_ROSTER))).toEqual({
      kind: "computer",
      computer: { id: MAC, name: "MacBook", belongsTo: "person" },
    });
    expect(await whereOf(run("session", S_NOBODY))).toBeNull();
  });

  it("a playbook run reads its session", async () => {
    expect(await whereOf(run("playbook", PLAYBOOK_RUN))).toEqual(DEVBOX_WHERE);
  });

  it("an agent write is where its agent is", async () => {
    expect(await whereOf(run("agent_write", "w1", ON_DEVBOX))).toEqual(
      DEVBOX_WHERE
    );
    expect(await whereOf(run("agent_write", "w2", OUTSIDE))).toEqual({
      kind: "outside",
      computer: null,
    });
    expect(await whereOf(run("agent_write", "w3", POD_AGENT))).toEqual({
      kind: "pod",
      computer: null,
    });
    // A computer's own key acting is that computer.
    expect(await whereOf(run("agent_write", "w4", DEVBOX))).toEqual(
      DEVBOX_WHERE
    );
    // A person is no agent: nothing says where.
    expect(await whereOf(run("agent_write", "w5", PERSON))).toBeNull();
  });

  it("the pod's own runs are the pod's", async () => {
    for (const f of ["automation", "capture", "chat"] as const)
      expect(await whereOf(run(f, randomUUID()))).toEqual({
        kind: "pod",
        computer: null,
      });
    // A capability run that is no box run ran in the pod.
    expect(await whereOf(run("capability", randomUUID()))).toEqual({
      kind: "pod",
      computer: null,
    });
  });

  it("a failed read leaves where absent, never unknown or the pod", async () => {
    await h.client!.exec(`alter table box_runs rename to box_runs_gone`);
    try {
      const [out] = await withRunWhere([run("capability", BOX_LEASED)]);
      expect(out).not.toHaveProperty("where");
    } finally {
      await h.client!.exec(`alter table box_runs_gone rename to box_runs`);
    }
  });
});
