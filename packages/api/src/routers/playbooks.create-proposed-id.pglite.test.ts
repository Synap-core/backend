/**
 * An approved playbook create lands under the id its proposal promised, so
 * the `targetId` an agent reads off its own proposal names the playbook.
 *
 * MEASURED DEFECT (live, 2026-10-21): proposal ee96643d (create playbook
 * "Build a prospect list from our foundation") had targetId 6847b54f; its
 * approval created the playbook as 48e6878a. `synap_start_session` with the
 * proposal's targetId then refused: "names no playbook you can see".
 * `playbooks.create` gave the gate no `data.id` (so the gate minted a random
 * targetId) and inserted with a database-minted id.
 *
 * Driven on PGlite through the REAL `playbooks.create` (agent call → its gate
 * proposes) and the REAL `playbook/create` approval executor replaying into the
 * REAL `playbooks.create` (its gate recorded as granted). Stubbed: the gate
 * itself, audit and side effects. NOT executed: the gate's own targetId
 * derivation (`permission-check.ts`, `data.documentId || data.entityId ||
 * data.id || randomUUID()`) — this asserts the gate is HANDED `data.id` and
 * files the proposal row with that id as its targetId.
 *
 * Rows that rule out a wrong rule:
 *  - approving lands the playbook AS the proposal's targetId (the defect: a
 *    new id), and the executor reports that id;
 *  - a proposal filed before the gate minted an id (random targetId, no
 *    `data.id`) is adopted too;
 *  - re-running create with an id this workspace's playbook already holds
 *    returns it: one row, no crash (a replayed approval);
 *  - an id held by ANOTHER workspace's playbook mints a fresh one and leaves
 *    theirs untouched (rules out "reuse whatever row has the id").
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  gate: vi.fn(),
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const schema = await import("@synap/database/schema");
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema });
  return {
    ...actual,
    db,
    getDb: async () => db,
    eventRepository: {
      append: async () => ({ id: randomUUID() }),
      emitCompleted: async () => undefined,
    },
  };
});
vi.mock("../utils/permission-check.js", () => ({
  checkPermissionOrPropose: h.gate,
  previewPermissionDecision: vi.fn(async () => ({ decision: "allow" })),
  proposedMessageFor: vi.fn(() => "proposed"),
}));
vi.mock("../utils/audit-log.js", () => ({ auditLog: vi.fn() }));
vi.mock("../utils/split-brain-service.js", () => ({
  isPodReadOnly: vi.fn().mockResolvedValue(false),
}));
vi.mock("@synap/events", () => ({
  emitSideEffects: async () => {},
  getBoss: () => ({ send: async () => null }),
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { playbooksRouter } from "./playbooks.js";
import { proposalExecRegistry } from "./proposals/execution-registry.js";
import type { ProposalExecutorArgs } from "./proposals/execution-registry.js";
import { registerPlaybookExecutors } from "./proposals/executors/playbook.js";

const OWNER = randomUUID();
const AGENT = randomUUID();
const WS = randomUUID();
const OTHER_WS = randomUUID();

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const isArray = t.endsWith("[]");
    const base = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const type = isArray && !base.endsWith("[]") ? `${base}[]` : base;
    const pk = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    const def =
      c.name === "created_at" || c.name === "updated_at"
        ? " default now()"
        : c.name === "version"
          ? " default 1"
          : "";
    return `"${c.name}" ${type}${pk}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}
const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);

const caller = () =>
  playbooksRouter.createCaller({
    authenticated: true,
    userId: OWNER,
    workspaceId: WS,
    workspaceRole: "owner",
  } as never);

const deps = {
  reportProposalOutcome: vi.fn(),
  emitProposalReviewed: vi.fn(),
} as unknown as ProposalExecutorArgs["deps"];

const definition = (name: string) => ({
  name,
  goalTemplate: "Build a prospect list for {market}",
  params: [{ name: "market", type: "text" }],
  executor: "is-agent",
  status: "active",
});

async function playbookIdsNamed(name: string): Promise<string[]> {
  const { rows } = await q(`select id from playbooks where name = $1`, [name]);
  return (rows as Array<{ id: string }>).map((r) => r.id);
}

/** File the proposal row exactly as the gate stores it, and approve it. */
async function fileAndApprove(
  targetId: string,
  innerData: Record<string, unknown>
) {
  const proposalId = randomUUID();
  const data = {
    targetType: "playbook",
    targetId,
    changeType: "create",
    targetName: innerData.name,
    data: innerData,
  };
  await q(
    `insert into proposals (id, workspace_id, target_type, target_id, proposal_type, data, status, created_by)
     values ($1, $2, 'playbook', $3, 'create', $4::jsonb, 'pending', $5)`,
    [proposalId, WS, targetId, JSON.stringify(data), OWNER]
  );
  const exec = proposalExecRegistry.resolveExact("playbook/create");
  if (!exec) throw new Error("playbook/create executor is not registered");
  return exec.execute({
    proposal: {
      id: proposalId,
      targetType: "playbook",
      targetId,
      proposalType: "create",
      workspaceId: WS,
      sessionId: null,
      projectId: null,
      agentUserId: AGENT,
      subjectUserId: OWNER,
      sourceMessageId: null,
      data,
    },
    payload: data as never,
    userId: OWNER,
    input: { proposalId },
    ctx: {} as ProposalExecutorArgs["ctx"],
    deps,
  } as unknown as ProposalExecutorArgs);
}

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));
  for (const [id, email] of [
    [OWNER, "o@x.test"],
    [AGENT, "agent@x.synap.agent"],
  ])
    await q(`insert into users (id, email) values ($1, $2)`, [id, email]);
  for (const [id, name] of [
    [WS, "Builder"],
    [OTHER_WS, "Elsewhere"],
  ])
    await q(
      `insert into workspaces (id, name, owner_id, settings) values ($1,$2,$3,'{}'::jsonb)`,
      [id, name, OWNER]
    );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
    [randomUUID(), WS, OWNER]
  );
  registerPlaybookExecutors();
}, 120_000);

beforeEach(() => {
  // An agent call PROPOSES; the approver's replay (no agentUserId) is granted.
  h.gate
    .mockReset()
    .mockImplementation(async (opts: { agentUserId?: string }) =>
      opts.agentUserId
        ? { proposalId: randomUUID(), proposalType: "create" }
        : { allowed: true }
    );
});

describe("an approved playbook create keeps its proposal's id", () => {
  it("the agent's create hands the gate the id the playbook will land under", async () => {
    const res = (await caller().create({
      ...definition("Prospect list A"),
      agentUserId: AGENT,
    } as never)) as { status: string };
    expect(res.status).toBe("proposed");
    const gated = h.gate.mock.calls[0]![0] as { data: { id?: unknown } };
    expect(typeof gated.data.id).toBe("string");
    expect(await playbookIdsNamed("Prospect list A")).toEqual([]);

    const promised = gated.data.id as string;
    const out = await fileAndApprove(promised, gated.data);
    expect(await playbookIdsNamed("Prospect list A")).toEqual([promised]);
    expect((out as { primaryId?: string }).primaryId).toBe(promised);
  });

  it("a proposal filed before the gate minted an id is adopted too", async () => {
    const legacyTarget = randomUUID();
    await fileAndApprove(legacyTarget, definition("Prospect list B"));
    expect(await playbookIdsNamed("Prospect list B")).toEqual([legacyTarget]);
  });

  it("an id this workspace's playbook already holds returns it: one row, no crash", async () => {
    const [id] = await playbookIdsNamed("Prospect list B");
    const res = (await caller().create({
      ...definition("Prospect list B"),
      proposedPlaybookId: id,
    } as never)) as { status: string; playbook: { id: string } };
    expect(res.status).toBe("created");
    expect(res.playbook.id).toBe(id);
    expect(await playbookIdsNamed("Prospect list B")).toEqual([id]);
  });

  it("an id another workspace's playbook holds mints a fresh one and leaves theirs alone", async () => {
    const theirs = randomUUID();
    await q(
      `insert into playbooks (id, workspace_id, created_by, name, goal_template, params, input_strategy, channel_spec, expected_outputs, stages, criteria, status, executor, metadata, version)
       values ($1,$2,$3,'Their list','Theirs','[]'::jsonb,'{"kind":"none"}'::jsonb,'{}'::jsonb,'[]'::jsonb,'[]'::jsonb,'[]'::jsonb,'active','is-agent','{}'::jsonb,1)`,
      [theirs, OTHER_WS, OWNER]
    );
    const res = (await caller().create({
      ...definition("Prospect list C"),
      proposedPlaybookId: theirs,
    } as never)) as { status: string; playbook: { id: string } };
    expect(res.status).toBe("created");
    expect(res.playbook.id).not.toBe(theirs);
    expect(await playbookIdsNamed("Prospect list C")).toEqual([
      res.playbook.id,
    ]);
    expect(await playbookIdsNamed("Their list")).toEqual([theirs]);
  });
});
