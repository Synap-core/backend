/**
 * `projects.fileEntities` — file EXISTING records into a project, and un-file
 * them. Driven through the REAL procedure, the REAL floor, the REAL
 * `linkEntityToProject` / `unlinkEntitiesFromProject` and the REAL approval
 * executors on PGlite. Only the governance ENGINE (`checkPermissionOrPropose`)
 * is mocked at the module seam, so these assert what the door ASKS the gate
 * and what it does with each answer; the proposal title is built by the REAL
 * `buildProposalSummary` from the payload the door actually sent.
 *
 *   - agent → proposed, nothing written; asks `project/file_entities` with
 *     `forcePropose`; one proposal for the batch; title names count, kind and
 *     project; approving it (real executor) files the batch, floored on the
 *     proposal's OWNER, and the receipt counts the insert's RETURNING;
 *   - human granted → filed directly; a re-file reports "already filed";
 *   - floor BEFORE the gate: invisible project, a record the caller cannot
 *     write (viewer role, someone else's pod record), a deleted record;
 *   - un-file asks `link/delete` (the DESTRUCTIVE floor) and its approval runs
 *     through the `link/delete` executor.
 *
 * The engine's own verdict for `forcePropose` (rung 2.1, agent always proposes)
 * belongs to the permission-check suites, not here.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  drizzleDb: null as unknown,
  perm: vi.fn(),
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const d = drizzle(client, { schema });
  h.drizzleDb = d;
  return { ...actual, db: d, getDb: async () => d };
});
vi.mock("../utils/permission-check.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../utils/permission-check.js")>();
  return {
    ...actual,
    checkPermissionOrPropose: (...a: unknown[]) => h.perm(...a),
  };
});
vi.mock("../utils/audit-log.js", () => ({ auditLog: vi.fn(async () => null) }));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { projectsRouter } from "./projects.js";
import { buildProposalSummary } from "../utils/permission-check.js";
import { proposalExecRegistry } from "./proposals/execution-registry.js";
import { registerProjectFilingExecutors } from "./proposals/executors/project-filing.js";
import { registerLinkExecutors } from "./proposals/executors/link.js";

const OWNER = randomUUID();
const VIEWER = randomUUID();
const OTHER = randomUUID();
const APPROVER = randomUUID();
const AGENT = randomUUID();
const WS = randomUUID();
const PROJECT = randomUUID();
const HIDDEN_PROJECT = randomUUID();
const Q1 = randomUUID();
const Q2 = randomUUID();
const POD_DECISION = randomUUID();
const FOREIGN = randomUUID();
const DELETED = randomUUID();

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const pk = c.primary
      ? type === "uuid"
        ? " primary key default gen_random_uuid()"
        : " primary key"
      : "";
    return `"${c.name}" ${type}${pk}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}
const q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const caller = (userId: string, agentUserId?: string) =>
  projectsRouter.createCaller({
    db: h.drizzleDb,
    authenticated: true,
    userId,
    workspaceId: null,
    ...(agentUserId ? { agentUserId } : {}),
  } as never);

const filed = async (projectId = PROJECT) =>
  (
    await q<{ source_entity_id: string }>(
      `select source_entity_id from relations where type = 'belongs_to_project' and target_entity_id = $1 order by source_entity_id`,
      [projectId]
    )
  ).rows.map((r) => r.source_entity_id);

const deps = {
  reportProposalOutcome: vi.fn(),
  emitProposalReviewed: vi.fn(),
} as never;

/** Store the proposal the gate WOULD have filed, then approve it for real. */
async function approve(
  key: "project/file_entities" | "link/delete",
  data: Record<string, unknown>
) {
  const id = randomUUID();
  const [targetType, proposalType] = key.split("/") as [string, string];
  const stored = { requestId: id, targetType, changeType: proposalType, data };
  await q(
    `insert into proposals (id, workspace_id, target_type, target_id, proposal_type, status, data, subject_user_id, agent_user_id)
     values ($1,$2,$3,$4,$5,'pending',$6::jsonb,$7,$8)`,
    [
      id,
      WS,
      targetType,
      PROJECT,
      proposalType,
      JSON.stringify(stored),
      OWNER,
      AGENT,
    ]
  );
  const exec = proposalExecRegistry.resolve(key)!;
  const res = await exec.execute({
    proposal: {
      id,
      targetType,
      targetId: PROJECT,
      proposalType,
      workspaceId: WS,
      agentUserId: AGENT,
      subjectUserId: OWNER,
      data: stored,
    },
    payload: stored,
    userId: APPROVER,
    input: { proposalId: id },
    ctx: {},
    deps,
  } as never);
  const status = (
    await q<{ status: string }>(`select status from proposals where id = $1`, [
      id,
    ])
  ).rows[0]!.status;
  return { res, status };
}

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));

  await q(
    `insert into workspaces (id, name, owner_id, settings) values ($1,'Foundation',$2,'{}'::jsonb)`,
    [WS, OWNER]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values
      ($1,$3,$4,'owner'),($2,$3,$5,'viewer')`,
    [randomUUID(), randomUUID(), WS, OWNER, VIEWER]
  );
  await q(
    `insert into projects (id, user_id, workspace_id, name) values
      ($1,$3,$4,'Launch The Architech'),($2,$5,null,'Someone else''s')`,
    [PROJECT, HIDDEN_PROJECT, OWNER, WS, OTHER]
  );
  await q(
    `insert into entities (id, user_id, workspace_id, type, title, deleted_at) values
      ($1,$6,$7,'question','GRP #1: Porteur',null),
      ($2,$6,$7,'question','GRP #2: Conventions',null),
      ($3,$6,null,'decision','Architech revenue model',null),
      ($4,$8,null,'decision','Not yours',null),
      ($5,$6,$7,'question','Gone',now())`,
    [Q1, Q2, POD_DECISION, FOREIGN, DELETED, OWNER, WS, OTHER]
  );
  registerProjectFilingExecutors();
  registerLinkExecutors();
});

beforeEach(async () => {
  h.perm.mockReset();
  await q(`delete from relations`);
});

describe("projects.fileEntities — agent proposes, approval files", () => {
  it("asks project/file_entities with forcePropose, writes nothing, and titles the batch", async () => {
    h.perm.mockResolvedValue({
      granted: false,
      proposalId: "prop-1",
      reviewUrl: "https://pod/r/prop-1",
    });
    const res = await caller(OWNER, AGENT).fileEntities({
      projectId: PROJECT,
      entityIds: [Q1, Q2, Q1],
      reasoning: "GRP questions belong to the launch",
    });
    expect(res).toMatchObject({ status: "proposed", proposalId: "prop-1" });
    expect(h.perm).toHaveBeenCalledTimes(1); // ONE proposal for the batch
    const opts = h.perm.mock.calls[0]![0] as Record<string, unknown>;
    expect(opts).toMatchObject({
      userId: OWNER,
      agentUserId: AGENT,
      workspaceId: WS,
      subjectType: "project",
      action: "file_entities",
      forcePropose: true,
      reasoning: "GRP questions belong to the launch",
    });
    const data = opts.data as Record<string, unknown>;
    expect(data.entityIds).toEqual([Q1, Q2]); // deduped
    expect(buildProposalSummary("project", "file_entities", data)).toBe(
      'File 2 questions into project "Launch The Architech"'
    );
    expect(await filed()).toEqual([]);
  });

  it("approving the stored proposal files the batch (real executor, owner floor)", async () => {
    h.perm.mockResolvedValue({ granted: false, proposalId: "prop-2" });
    await caller(OWNER, AGENT).fileEntities({
      projectId: PROJECT,
      entityIds: [Q1, Q2],
    });
    const data = (h.perm.mock.calls[0]![0] as { data: Record<string, unknown> })
      .data;
    const { res, status } = await approve("project/file_entities", data);
    expect(res).toMatchObject({
      success: true,
      effect: { applied: "verified", rows: 2, subject: "relations" },
    });
    expect(status).toBe("approved");
    expect(await filed()).toEqual([Q1, Q2].sort());
  });

  it("a single named record titles by its name", () => {
    expect(
      buildProposalSummary("project", "file_entities", {
        entityIds: [POD_DECISION],
        entityKind: "decision",
        entityName: "Architech revenue model",
        projectName: "Launch The Architech",
      })
    ).toBe(
      'File "Architech revenue model" into project "Launch The Architech"'
    );
  });
});

describe("projects.fileEntities — human direct path", () => {
  it("files directly when the gate grants, and a re-file reports already filed", async () => {
    h.perm.mockResolvedValue({ granted: true });
    const first = await caller(OWNER).fileEntities({
      projectId: PROJECT,
      entityIds: [Q1, POD_DECISION],
    });
    expect(first).toMatchObject({ status: "filed", alreadyFiled: [] });
    expect((first as { filed: string[] }).filed.sort()).toEqual(
      [Q1, POD_DECISION].sort()
    );
    const again = await caller(OWNER).fileEntities({
      projectId: PROJECT,
      entityIds: [Q1],
    });
    expect(again).toMatchObject({
      status: "filed",
      filed: [],
      alreadyFiled: [Q1],
    });
    expect(await filed()).toEqual([Q1, POD_DECISION].sort());
  });

  it("a denied gate is FORBIDDEN and writes nothing", async () => {
    h.perm.mockResolvedValue({ denied: true, reason: "nope" });
    await expect(
      caller(OWNER).fileEntities({ projectId: PROJECT, entityIds: [Q1] })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await filed()).toEqual([]);
  });
});

describe("projects.fileEntities — visibility floor BEFORE the gate", () => {
  it.each([
    ["a project the caller cannot see", OWNER, HIDDEN_PROJECT, [Q1]],
    ["a record the caller can only READ (viewer)", VIEWER, PROJECT, [Q1]],
    ["someone else's pod-wide record", OWNER, PROJECT, [Q1, FOREIGN]],
    ["a deleted record", OWNER, PROJECT, [DELETED]],
  ] as const)("refuses %s", async (_label, user, projectId, ids) => {
    h.perm.mockResolvedValue({ granted: true });
    await expect(
      caller(user).fileEntities({ projectId, entityIds: [...ids] })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(h.perm).not.toHaveBeenCalled();
    expect(await filed(projectId)).toEqual([]);
  });

  it("the viewer CAN see the project (so the refusal is the record floor, not the project)", async () => {
    // Non-vacuity for the viewer row above: with the owner's record swapped
    // for nothing, the viewer's refusal would be indistinguishable from an
    // invisible project. The viewer reads the project fine.
    const got = await q<{ n: number }>(
      `select count(*)::int as n from workspace_members where user_id = $1 and workspace_id = $2`,
      [VIEWER, WS]
    );
    expect(got.rows[0]!.n).toBe(1);
  });
});

describe("projects.fileEntities {remove} — un-file is a governed link delete", () => {
  it("asks link/delete (DESTRUCTIVE floor), and approval removes exactly the batch", async () => {
    await q(
      `insert into relations (user_id, source_entity_id, target_entity_id, type) values
        ($1,$2,$4,'belongs_to_project'),($1,$3,$4,'belongs_to_project')`,
      [OWNER, Q1, Q2, PROJECT]
    );
    h.perm.mockResolvedValue({ granted: false, proposalId: "prop-3" });
    const res = await caller(OWNER, AGENT).fileEntities({
      projectId: PROJECT,
      entityIds: [Q1, Q2],
      remove: true,
    });
    expect(res).toMatchObject({ status: "proposed" });
    const opts = h.perm.mock.calls[0]![0] as {
      subjectType: string;
      action: string;
      data: Record<string, unknown>;
    };
    expect(opts.subjectType).toBe("link");
    expect(opts.action).toBe("delete");
    expect(opts.data).toMatchObject({
      linkType: "belongs_to_project",
      fromType: "entity",
      toType: "project",
      toId: PROJECT,
    });
    expect(buildProposalSummary("link", "delete", opts.data)).toBe(
      'Unfile 2 questions from project "Launch The Architech"'
    );
    expect(await filed()).toEqual([Q1, Q2].sort()); // nothing removed yet

    const { res: approved, status } = await approve("link/delete", opts.data);
    expect(approved).toMatchObject({
      success: true,
      effect: { applied: "verified", rows: 2 },
    });
    expect(status).toBe("approved");
    expect(await filed()).toEqual([]);
  });
});
