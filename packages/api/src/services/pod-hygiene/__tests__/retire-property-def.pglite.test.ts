/**
 * `propertyDefs.proposeRetire` / capability verb `property_def.propose_retire`
 * — governed FIELD retirement, the field twin of `profile.propose_retire`.
 *
 * Driven on PGlite through the REAL procedure and the REAL `property_def/retire`
 * approval executor (`insertPendingProposal` is shimmed to the same INSERT on
 * PGlite — its own client is unreachable here). Nothing governs by mock:
 * this door has no gate call to mock — it files a PENDING proposal for every
 * caller, which is exactly what these pin:
 *   - a BASE def on a system kind (workspace_id NULL) — which the old
 *     `propertyDefs.delete` door refuses to EVERYONE — can be proposed by a pod
 *     admin, lands PENDING (a human too), and approving it deletes the def with
 *     the DELETE's own RETURNING as the receipt;
 *   - the agent door (capability verb) also only ever proposes;
 *   - authority on the LOADED row: a plain space member cannot file on a
 *     system kind's field or a global field;
 *   - a field that still holds a value is REFUSED (no proposal), and a value
 *     written AFTER filing refuses at APPROVAL (the def survives).
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  drizzleDb: null as unknown,
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
  return {
    ...actual,
    db: d,
    getDb: async () => d,
    // `insertPendingProposal` binds @synap/database's OWN postgres.js client,
    // which the barrel `db` swap never reaches — stubbed to the same INSERT on
    // PGlite (the pod-hygiene suite's shim, plus the agent attribution column).
    insertPendingProposal: async (input: {
      workspaceId: string | null;
      targetType: string;
      targetId: string;
      proposalType: string;
      data: Record<string, unknown>;
      createdBy: string | null;
      proposedByUserId?: string | null;
      subjectUserId?: string | null;
      agentUserId?: string | null;
    }) => {
      const id = randomUUID();
      const { rows } = await client.query(
        `insert into proposals (id, status, workspace_id, target_type, target_id, proposal_type, data,
           created_by, proposed_by_user_id, subject_user_id, agent_user_id, created_at, updated_at)
         values ($1,'pending',$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,now(),now()) returning *`,
        [
          id,
          input.workspaceId,
          input.targetType,
          input.targetId,
          input.proposalType,
          JSON.stringify(input.data),
          input.createdBy,
          input.proposedByUserId ?? null,
          input.subjectUserId ?? null,
          input.agentUserId ?? null,
        ]
      );
      return { proposal: { ...(rows[0] as object), id }, deduped: false };
    },
  };
});
vi.mock("../../../utils/audit-log.js", () => ({
  auditLog: vi.fn(async () => null),
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { propertyDefsRouter } from "../../../routers/property-defs.js";
import { BUILTIN_VERBS } from "../../capabilities/builtin-verbs.js";
import { proposalExecRegistry } from "../../../routers/proposals/execution-registry.js";
import { registerPodHygieneExecutors } from "../../../routers/proposals/executors/pod-hygiene.js";

const ADMIN = randomUUID();
const MEMBER = randomUUID();
const AGENT = randomUUID();
const WS = randomUUID();
const POD_ADMIN_WS = randomUUID();
const QUESTION = randomUUID(); // system kind: workspace NULL, user NULL
const EMPTY_DEF = randomUUID(); // base def, no values
const USED_DEF = randomUUID(); // base def, one record carries it
const LATE_DEF = randomUUID(); // base def, a value arrives after filing
const GLOBAL_DEF = randomUUID(); // no profile, no workspace

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

const caller = (userId: string) =>
  propertyDefsRouter.createCaller({
    db: h.drizzleDb,
    authenticated: true,
    userId,
    workspaceId: null,
  } as never);

const defExists = async (id: string) =>
  (
    await q<{ n: number }>(
      `select count(*)::int as n from property_defs where id = $1`,
      [id]
    )
  ).rows[0]!.n === 1;

async function approve(proposalId: string, targetId: string) {
  const row = (
    await q<{ data: unknown; workspace_id: string | null }>(
      `select data, workspace_id from proposals where id = $1`,
      [proposalId]
    )
  ).rows[0]!;
  return proposalExecRegistry.resolve("property_def/retire")!.execute({
    proposal: {
      id: proposalId,
      targetType: "property_def",
      targetId,
      proposalType: "retire",
      workspaceId: row.workspace_id,
      subjectUserId: ADMIN,
      data: row.data,
    },
    payload: row.data,
    userId: ADMIN,
    input: { proposalId },
    ctx: {},
    deps: { reportProposalOutcome: vi.fn(), emitProposalReviewed: vi.fn() },
  } as never);
}

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));

  await q(
    `insert into workspaces (id, name, owner_id, settings, system_slug) values
      ($1,'Foundation',$3,'{}'::jsonb,null),($2,'Pod admin',$3,'{}'::jsonb,'pod-admin')`,
    [WS, POD_ADMIN_WS, ADMIN]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values
      ($1,$4,$5,'owner'),($2,$6,$5,'admin'),($3,$4,$7,'editor')`,
    [randomUUID(), randomUUID(), randomUUID(), WS, ADMIN, POD_ADMIN_WS, MEMBER]
  );
  await q(
    `insert into profiles (id, slug, display_name, scope, profile_kind, is_active, workspace_id, user_id)
     values ($1,'question','Question','system','kind',true,null,null)`,
    [QUESTION]
  );
  await q(
    `insert into property_defs (id, slug, profile_id, workspace_id, value_type) values
      ($1,'evidence-quality',$5,null,'string'),
      ($2,'grp-domain',$5,null,'string'),
      ($3,'interrogation-number',$5,null,'number'),
      ($4,'legacy-global',null,null,'string')`,
    [EMPTY_DEF, USED_DEF, LATE_DEF, GLOBAL_DEF, QUESTION]
  );
  await q(
    `insert into profile_properties (profile_id, property_def_id) values ($1,$2)`,
    [QUESTION, EMPTY_DEF]
  );
  await q(
    `insert into entities (id, user_id, workspace_id, profile_id, type, title, properties)
     values ($1,$2,$3,$4,'question','GRP #1','{"grp-domain":"generation"}'::jsonb)`,
    [randomUUID(), ADMIN, WS, QUESTION]
  );
  registerPodHygieneExecutors();
});

describe("propertyDefs.proposeRetire — always a proposal", () => {
  it("the old delete door refuses a base def to everyone (the gap)", async () => {
    await expect(caller(ADMIN).delete({ id: EMPTY_DEF })).rejects.toMatchObject(
      { code: "FORBIDDEN" }
    );
  });

  it("a pod admin's retire of a base def lands PENDING, def untouched, then approval deletes it", async () => {
    const res = await caller(ADMIN).proposeRetire({
      id: EMPTY_DEF,
      reason: "duplicate of the grp question fields",
    });
    expect(res).toMatchObject({
      status: "proposed",
      dependents: { indexedValues: 0, entityValues: 0, profileLinks: 1 },
    });
    const proposalId = (res as { proposalId: string }).proposalId;
    const row = (
      await q<{
        status: string;
        target_type: string;
        proposal_type: string;
        data: { summary: string };
      }>(
        `select status, target_type, proposal_type, data from proposals where id = $1`,
        [proposalId]
      )
    ).rows[0]!;
    expect(row).toMatchObject({
      status: "pending",
      target_type: "property_def",
      proposal_type: "retire",
    });
    expect(row.data.summary).toBe('Retire Field "evidence-quality"');
    expect(await defExists(EMPTY_DEF)).toBe(true);

    // A second filing does not stack a duplicate.
    expect(await caller(ADMIN).proposeRetire({ id: EMPTY_DEF })).toEqual({
      status: "already_pending",
      proposalId,
    });

    const applied = await approve(proposalId, EMPTY_DEF);
    expect(applied).toMatchObject({
      success: true,
      effect: { applied: "verified", rows: 1, subject: "property_defs" },
    });
    expect(await defExists(EMPTY_DEF)).toBe(false);
    expect(
      (
        await q<{ status: string }>(
          `select status from proposals where id = $1`,
          [proposalId]
        )
      ).rows[0]!.status
    ).toBe("approved");
  });

  it("the agent door (capability verb) only ever proposes", async () => {
    const res = await BUILTIN_VERBS["property_def.propose_retire"]!(
      { propertyDefId: LATE_DEF, reason: "unused" },
      { userId: ADMIN, workspaceId: WS, agentUserId: AGENT } as never
    );
    expect(res).toMatchObject({ status: "proposed" });
    expect(await defExists(LATE_DEF)).toBe(true);
  });

  it("a value written AFTER filing refuses at approval; the def survives", async () => {
    const [pending] = (
      await q<{ id: string }>(
        `select id from proposals where target_id = $1 and status = 'pending'`,
        [LATE_DEF]
      )
    ).rows;
    await q(
      `insert into entities (id, user_id, workspace_id, profile_id, type, title, properties)
       values ($1,$2,$3,$4,'question','GRP #9','{"interrogation-number":9}'::jsonb)`,
      [randomUUID(), ADMIN, WS, QUESTION]
    );
    await expect(approve(pending!.id, LATE_DEF)).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    expect(await defExists(LATE_DEF)).toBe(true);
  });
});

describe("propertyDefs.proposeRetire — refusals", () => {
  it("a field that still holds a value is refused with reasons, and files nothing", async () => {
    const res = await caller(ADMIN).proposeRetire({ id: USED_DEF });
    expect(res).toMatchObject({
      status: "refused",
      migrationProposalId: null,
      dependents: { entityValues: 1 },
    });
    expect((res as { reasons: string[] }).reasons.join(" ")).toMatch(
      /1 record\(s\) still carry a value/
    );
    const filed = await q<{ n: number }>(
      `select count(*)::int as n from proposals where target_id = $1`,
      [USED_DEF]
    );
    expect(filed.rows[0]!.n).toBe(0);
  });

  it.each([
    ["a system kind's base field", USED_DEF],
    ["a global field", GLOBAL_DEF],
  ])("a plain space member cannot file on %s", async (_label, id) => {
    await expect(caller(MEMBER).proposeRetire({ id })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("a pod admin CAN file on a global field (non-vacuity for the row above)", async () => {
    await expect(
      caller(ADMIN).proposeRetire({ id: GLOBAL_DEF })
    ).resolves.toMatchObject({ status: "proposed" });
  });

  it("an unknown def is NOT_FOUND", async () => {
    await expect(
      caller(ADMIN).proposeRetire({ id: randomUUID() })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
