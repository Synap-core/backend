/**
 * JOURNEY, run half (consolidation W1; tickets 01b5b0b3, da1199bb): an
 * automation an agent authored and a person approved is OWNED by the person
 * (`created_by`) with the agent as its ACTOR (`agent_user_id`). Its run:
 *   - opens its run session as the PERSON (readable in their lists), the
 *     agent recorded on it;
 *   - launches its `playbook_run` as the PERSON: the run spine resolves the
 *     runner roster, the session and the AI principal for `userId`, so an
 *     agent the person operates is the person's (it used to be the agent's
 *     own roster: the external runner was refused);
 *   - has its writes judged by the AGENT's governance ladder, with RBAC on
 *     the PERSON: a write that needs approval for that agent still proposes,
 *     filed for the person, and nothing is written.
 *
 * Real: `handleAutomationExecute`, the playbook_run and output steps,
 * `checkAutomationWriteOrPropose`, `proposeAutomationWrite`, PGlite tables
 * derived from the Drizzle schema. Stubbed, each a seam with its own suite:
 * the ladder itself (`resolveAgentGovernanceDecision`, keyed on the principal
 * it is asked about), RBAC (`verifyPermission`, records who it checks), the
 * proposal insert, the run spine (`registerPlaybookRunner`), session
 * open/close and narration. What this does NOT run: `route()` and the IS —
 * the spine is handed `userId`, and `route()`'s roster-for-a-person rule is
 * covered by the runner-resolution suites.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  sessions: [] as Array<Record<string, unknown>>,
  runner: [] as Array<Record<string, unknown>>,
  ladder: [] as string[],
  rbac: [] as string[],
  proposals: [] as Array<Record<string, unknown>>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  return {
    ...actual,
    db: drizzle(client, { schema }),
    openRunSession: async (input: Record<string, unknown>) => {
      h.sessions.push(input);
      return { sessionId: randomUUID(), reused: false };
    },
    verifyPermission: async (input: { userId: string }) => {
      h.rbac.push(input.userId);
      return { allowed: true };
    },
    insertPendingProposal: async (input: Record<string, unknown>) => {
      h.proposals.push(input);
      return { proposal: { id: randomUUID() }, deduped: false };
    },
  };
});
// THE LADDER, keyed on the principal it judges: the agent's ladder says
// "propose" for this write; a person is not an agent.
vi.mock("@synap/database/agent-governance", () => ({
  resolveAgentGovernanceDecision: async (input: { agentUserId: string }) => {
    h.ladder.push(input.agentUserId);
    return input.agentUserId === AGENT
      ? { decision: "propose", reason: "this agent asks first" }
      : { decision: "not-agent" };
  },
}));
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: () => undefined,
}));
vi.mock("../../utils/realtime-broadcast.js", () => ({
  broadcastNotification: async () => undefined,
}));
vi.mock("../../utils/post-run-summary.js", () => ({
  postRunSummary: async () => undefined,
  resolveRunChannel: async () => null,
}));
vi.mock("../../utils/session-close.js", () => ({
  closeSessionViaDoor: async () => null,
}));

import { is, SQL } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { handleAutomationExecute } from "../automation-executor.js";
import { registerPlaybookRunner } from "../capability-dispatch.js";

const WS = "22222222-2222-4222-8222-222222222222";
const PERSON = "33333333-3333-4333-8333-333333333333";
const AGENT = "55555555-5555-4555-8555-555555555555";
const PLAYBOOK = "66666666-6666-4666-8666-666666666666";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function sqlDefault(d: unknown): string {
  if (is(d, SQL)) {
    return (d as SQL).queryChunks
      .map((c) => {
        const v = (c as { value?: unknown }).value;
        return Array.isArray(v) ? v.join("") : "";
      })
      .join("");
  }
  if (typeof d === "string") return `'${d.replace(/'/g, "''")}'`;
  if (typeof d === "number" || typeof d === "boolean") return String(d);
  if (d && typeof d === "object") return `'${JSON.stringify(d)}'::jsonb`;
  return "";
}
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = t.endsWith("[]")
      ? t
      : BASIC.test(t)
        ? t.replace(/\(.*\)/, "")
        : "text";
    const def =
      !c.hasDefault ||
      (c.default !== null &&
        typeof c.default === "object" &&
        !is(c.default, SQL) &&
        !/^json/.test(type))
        ? ""
        : sqlDefault(c.default);
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${def ? ` default ${def}` : ""}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

/** WHEN started → run the playbook → write a note (a governed write). */
const FLOW = {
  nodes: [
    { id: "t", type: "trigger", data: {} },
    {
      id: "run",
      type: "playbook_run",
      data: { playbookId: PLAYBOOK, playbookName: "Weekly review" },
    },
    {
      id: "note",
      type: "output",
      data: {
        outputType: "entity_create",
        config: { profileSlug: "note", title: "Weekly review started" },
      },
    },
  ],
  edges: [
    { id: "e1", source: "t", target: "run" },
    { id: "e2", source: "run", target: "note" },
  ],
};

async function automation(owner: string, actor: string | null) {
  const id = randomUUID();
  await q(
    `insert into automations (id, workspace_id, created_by, agent_user_id, name, trigger_type, trigger_config, flow_definition, status, success_count, failure_count, run_count, version)
     values ($1, $2, $3, $4, $5, 'manual', '{}'::jsonb, $6::jsonb, 'active', 0, 0, 0, 1)`,
    [id, WS, owner, actor, `rule-${id}`, JSON.stringify(FLOW)]
  );
  const runId = randomUUID();
  await q(
    `insert into automation_runs (id, automation_id, workspace_id, triggered_by, trigger_payload, status, ai_dispatch_count, started_at)
     values ($1, $2, $3, 'system', '{}'::jsonb, 'running', 0, now())`,
    [runId, id, WS]
  );
  return { id, runId };
}

const execute = (automationId: string, runId: string) =>
  handleAutomationExecute({
    data: {
      runId,
      automationId,
      workspaceId: WS,
      automationContext: {
        automationRunId: runId,
        automationId,
        chainDepth: 0,
        rootRunId: runId,
        chainAutomationIds: [],
      },
    } as never,
  });

beforeAll(async () => {
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) await h.client!.exec(ddlFor(value as PgTable));
  }
  registerPlaybookRunner(async (input) => {
    h.runner.push(input as unknown as Record<string, unknown>);
    return {
      run: { id: randomUUID(), status: "running" },
      session: { id: randomUUID(), channelId: null },
    };
  });
}, 120_000);

beforeEach(async () => {
  h.sessions = [];
  h.runner = [];
  h.ladder = [];
  h.rbac = [];
  h.proposals = [];
  await h.client!.exec(
    "delete from automations; delete from automation_runs; delete from automation_step_runs; delete from users; delete from workspace_members; delete from entities;"
  );
  await q(
    `insert into users (id, email, user_type) values ($1, 'p@x.test', 'human')`,
    [PERSON]
  );
  await q(
    `insert into users (id, email, user_type, created_by_user_id) values ($1, 'a@x.test', 'agent', $2)`,
    [AGENT, PERSON]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, 'owner')`,
    [randomUUID(), WS, PERSON]
  );
});

describe("an agent-authored automation runs as the person, governed as the agent", () => {
  it("session and playbook run are the person's; the write proposes under the agent's ladder", async () => {
    const { id, runId } = await automation(PERSON, AGENT);

    await execute(id, runId);

    // The run session: the person's, the agent recorded on it.
    expect(h.sessions).toHaveLength(1);
    expect(h.sessions[0]).toMatchObject({ userId: PERSON, agentUserId: AGENT });

    // The playbook run is launched as the person (roster, session, principal).
    expect(h.runner).toHaveLength(1);
    expect(h.runner[0]).toMatchObject({
      userId: PERSON,
      playbookId: PLAYBOOK,
      workspaceId: WS,
    });

    // The write: RBAC on the person, the ladder on the agent → a proposal by
    // the agent, filed for the person, and nothing written.
    expect(h.rbac).toEqual([PERSON]);
    expect(h.ladder).toEqual([AGENT]);
    expect(h.proposals).toHaveLength(1);
    expect(h.proposals[0]).toMatchObject({
      agentUserId: AGENT,
      subjectUserId: PERSON,
      targetType: "entity",
      proposalType: "create",
    });
    const { rows } = await q<{ n: number }>(
      "select count(*)::int as n from entities"
    );
    expect(rows[0]!.n).toBe(0);
  });

  it("CONTROL: a person's own automation is judged as the person (no agent in it)", async () => {
    const { id, runId } = await automation(PERSON, null);

    await execute(id, runId);

    expect(h.sessions[0]).toMatchObject({ userId: PERSON });
    expect(h.sessions[0]!.agentUserId ?? null).toBeNull();
    expect(h.runner[0]).toMatchObject({ userId: PERSON });
    // The ladder is asked about the person (only), who is not an agent: no
    // proposal. (The granted write may be retried; who is asked never changes.)
    expect(new Set(h.ladder)).toEqual(new Set([PERSON]));
    expect(h.proposals).toEqual([]);
  });
});
