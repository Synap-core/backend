/**
 * JOURNEY, approval half (consolidation W1): an agent files `automation/create`
 * and a person approves it. The automation is OWNED by the person the proposal
 * was filed for (`proposals.subject_user_id`) — never the approver, never the
 * agent — and records the agent as its ACTOR (`agent_user_id`).
 *
 * Real: the `automation/create` executor (resolved through the registry, as
 * approval does), `materializeApprovedAutomation`, the owner door
 * `ownerAndActor`, the insert, `transitionProposal`. PGlite tables derived
 * from the Drizzle schema. Stubbed: side-effect events.
 *
 * The run half (the run executes as the person, its writes judged by the
 * agent's ladder) is `jobs/src/workers/__tests__/agent-authored-automation-
 * runs-as-person.pglite.test.ts`.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  h.db = drizzle(client, { schema });
  return { ...actual, db: h.db, getDb: async () => h.db };
});
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap/events")>()),
  emitSideEffects: () => undefined,
}));

import { is, SQL } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { proposalExecRegistry } from "../execution-registry.js";
import { registerAutomationExecutors } from "./automation.js";

const PERSON = "person-1"; // the person the agent works for
const APPROVER = "admin-1"; // another member who approves
const AGENT = "agent-1"; // works for PERSON
const POD_AGENT = "agent-pod"; // pod-wide key: installed by APPROVER
const WS = randomUUID();

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

const FLOW = {
  nodes: [
    {
      id: "n1",
      type: "trigger",
      position: { x: 0, y: 0 },
      data: { triggerType: "manual", label: "Manual", config: {} },
    },
  ],
  edges: [],
};
const DATA_CONTRACT = {
  version: 1,
  mode: "react",
  gets: [
    {
      id: "manual-input",
      label: "Manual request",
      origin: "manual",
      event: "The person starts it",
      nodeIds: ["n1"],
    },
  ],
  stores: [],
  reacts: [
    { id: "run", label: "Run the process", kind: "process", nodeIds: ["n1"] },
  ],
};

/** File the agent's proposal, approve it through the registry's executor. */
async function approve(p: {
  agentUserId: string;
  subjectUserId: string | null;
  approver: string;
}): Promise<{
  created_by: string;
  agent_user_id: string | null;
  status: string;
}> {
  const proposalId = randomUUID();
  const automationId = randomUUID();
  const data = {
    targetType: "automation",
    changeType: "create",
    data: {
      name: `Weekly digest ${automationId}`,
      triggerType: "manual",
      triggerConfig: {},
      flowDefinition: FLOW,
      metadata: { dataContract: DATA_CONTRACT },
    },
  };
  await q(
    `insert into proposals (id, workspace_id, target_type, target_id, proposal_type, status, created_by, agent_user_id, subject_user_id, data)
     values ($1, $2, 'automation', $3, 'create', 'pending', $4, $4, $5, $6::jsonb)`,
    [
      proposalId,
      WS,
      automationId,
      p.agentUserId,
      p.subjectUserId,
      JSON.stringify(data),
    ]
  );
  const exec = proposalExecRegistry.resolve("automation/create");
  if (!exec) throw new Error("no automation/create executor");
  await exec.execute({
    proposal: {
      id: proposalId,
      targetType: "automation",
      targetId: automationId,
      proposalType: "create",
      workspaceId: WS,
      sessionId: null,
      projectId: null,
      agentUserId: p.agentUserId,
      createdBy: p.agentUserId,
      subjectUserId: p.subjectUserId,
      sourceMessageId: null,
      data,
    },
    payload: data.data,
    userId: p.approver,
    input: { proposalId },
    ctx: {} as never,
    deps: {
      reportProposalOutcome: () => undefined,
      emitProposalReviewed: () => undefined,
    },
  } as never);
  const { rows } = await q<{
    created_by: string;
    agent_user_id: string | null;
    status: string;
  }>(
    `select created_by, agent_user_id, status from automations where id = $1`,
    [automationId]
  );
  return rows[0]!;
}

beforeAll(async () => {
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) await h.client!.exec(ddlFor(value as PgTable));
  }
  registerAutomationExecutors();
}, 120_000);

beforeEach(async () => {
  await h.client!.exec(
    "delete from automations; delete from proposals; delete from users;"
  );
  await q(
    `insert into users (id, email, user_type, created_by_user_id) values
      ($1, 'p@x.test', 'human', null),
      ($2, 'a@x.test', 'human', null),
      ($3, 'ag@x.test', 'agent', $1),
      ($4, 'pod@x.test', 'agent', $2)`,
    [PERSON, APPROVER, AGENT, POD_AGENT]
  );
});

describe("an approved agent automation is the person's, the agent its actor", () => {
  it("owner = the person it was filed for, not the approver; actor = the agent", async () => {
    const row = await approve({
      agentUserId: AGENT,
      subjectUserId: PERSON,
      approver: APPROVER,
    });
    expect(row).toEqual({
      created_by: PERSON,
      agent_user_id: AGENT,
      // An approval IS the activation.
      status: "active",
    });
  });

  it("a pod-wide agent's proposal (subject = the agent) is owned by the admin who installed it", async () => {
    const row = await approve({
      agentUserId: POD_AGENT,
      subjectUserId: POD_AGENT,
      approver: PERSON,
    });
    expect(row).toMatchObject({
      created_by: APPROVER,
      agent_user_id: POD_AGENT,
    });
  });

  it("a pre-0248 proposal (no subject) is owned by the agent's person", async () => {
    const row = await approve({
      agentUserId: AGENT,
      subjectUserId: null,
      approver: APPROVER,
    });
    expect(row).toMatchObject({ created_by: PERSON, agent_user_id: AGENT });
  });
});
