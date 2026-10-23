/**
 * A revision of a PENDING playbook proposal is validated at revise time (gaps
 * report fb1020 §4): `synap_revise_proposal` merged an `inner` patch into the
 * proposal's payload and nothing checked it until approval, so a bad stage or
 * an undeclared goal placeholder surfaced only as an approval failure.
 *
 * SEAM: the REAL MCP `synap_revise_proposal` handler → `reviseProposal` → the
 * shared core `mergeProposalRevision` (row lock, author rung, PENDING check) →
 * the per-target validator → `assertRevisedPlaybookPayload` (the procedures'
 * own input schemas + the shared `assertPlaybookDefinitionWritable`), all on
 * PGlite. Nothing in between is hand-built.
 *
 * Pinned:
 *  - playbook/update: a goal placeholder the revision introduces is refused,
 *    the stored proposal is unchanged;
 *  - playbook/create: a stage without `category` is refused; a valid one lands;
 *  - a summary-only revision of a proposal whose payload already fails is NOT
 *    judged (it must stay possible on a proposal filed before a rule).
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
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
  return { ...actual, db, getDb: async () => db };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { buildHandlers } from "../../routers/mcp/handlers/build.js";
import type { McpToolContext } from "../../routers/mcp/handlers/shared.js";

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

const OWNER = randomUUID();
const AGENT = randomUUID();
const WS = randomUUID();
const STORED = randomUUID();

async function insertProposal(
  changeType: "create" | "update",
  inner: Record<string, unknown>
): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into proposals (id, workspace_id, target_type, target_id, status, proposal_type, data, agent_user_id, created_by, subject_user_id)
     values ($1,$2,'playbook',$3,'pending',$4,$5::jsonb,$6,$7,$7)`,
    [
      id,
      WS,
      changeType === "update" ? STORED : randomUUID(),
      `playbook.${changeType}`,
      JSON.stringify({
        requestId: randomUUID(),
        targetType: "playbook",
        changeType,
        data: inner,
        summary: "s",
      }),
      AGENT,
      OWNER,
    ]
  );
  return id;
}

async function innerOf(id: string): Promise<Record<string, unknown>> {
  const { rows } = await q(`select data from proposals where id = $1`, [id]);
  return (rows[0] as { data: { data: Record<string, unknown> } }).data.data;
}

const revise = (args: Record<string, unknown>) =>
  buildHandlers.synap_revise_proposal!({
    toolName: "synap_revise_proposal",
    args,
    userId: OWNER,
    apiKeyScopes: ["mcp.read", "mcp.write"],
    agentUserId: AGENT,
  } as unknown as McpToolContext);

const inner = (proposalId: string, fields: Record<string, unknown>) =>
  revise({ proposalId, patch: { kind: "inner", fields } });

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));
  await q(`insert into users (id, email) values ($1, 'o@x.test')`, [OWNER]);
  await q(
    `insert into workspaces (id, name, owner_id, settings) values ($1,'Builder',$2,'{}'::jsonb)`,
    [WS, OWNER]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
    [randomUUID(), WS, OWNER]
  );
}, 120_000);

beforeEach(async () => {
  await h.client!.exec(`delete from playbooks; delete from proposals;`);
  await q(
    `insert into playbooks (id, workspace_id, created_by, name, goal_template, params, input_strategy, channel_spec, expected_outputs, stages, criteria, status, executor, metadata, version)
     values ($1,$2,$3,'Prepare a pre-sale estimate','Estimate {client} work','[{"name":"client","type":"text"}]'::jsonb,'{"kind":"none"}'::jsonb,'{}'::jsonb,'[]'::jsonb,'[]'::jsonb,'[]'::jsonb,'active','is-agent','{}'::jsonb,1)`,
    [STORED, WS, OWNER]
  );
});

describe("revising a pending playbook proposal runs the playbook write's checks", () => {
  it("playbook/update: refuses a goal placeholder the revision introduces", async () => {
    const id = await insertProposal("update", {
      id: STORED,
      description: "x",
    });
    await expect(
      inner(id, { goalTemplate: "Estimate {client} work in {market}" })
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringMatching(/Revision refused[\s\S]*\{market\}/),
    });
    expect(await innerOf(id)).toEqual({ id: STORED, description: "x" });
  });

  it("playbook/update: a placeholder declared in the stored params is fine", async () => {
    const id = await insertProposal("update", { id: STORED });
    await inner(id, { goalTemplate: "Estimate {client} work, in days" });
    expect(await innerOf(id)).toMatchObject({
      goalTemplate: "Estimate {client} work, in days",
    });
  });

  it("playbook/create: refuses a stage without a category, lands a valid one", async () => {
    const id = await insertProposal("create", {
      name: "Prepare an estimate",
      goalTemplate: "Estimate {client}",
      params: [{ name: "client", type: "text" }],
      stages: [],
    });
    await expect(
      inner(id, { stages: [{ key: "scope", name: "Scope" }] })
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("stages"),
    });
    expect((await innerOf(id)).stages).toEqual([]);

    await inner(id, {
      stages: [{ key: "scope", name: "Scope", category: "started" }],
    });
    expect((await innerOf(id)).stages).toMatchObject([
      { key: "scope", name: "Scope", category: "started" },
    ]);
  });

  it("does not judge a revision that leaves the payload as it was", async () => {
    const id = await insertProposal("create", {
      name: "Legacy",
      goalTemplate: "Run {{task}}",
      stages: [{ key: "a", name: "A" }],
    });
    await expect(
      revise({ proposalId: id, summary: "Clearer summary" })
    ).resolves.toBeDefined();
    // An envelope patch that does not touch the payload is not judged either.
    await expect(
      revise({
        proposalId: id,
        patch: { kind: "envelope", fields: { targetName: "Legacy estimate" } },
      })
    ).resolves.toBeDefined();
    expect(await innerOf(id)).toMatchObject({ goalTemplate: "Run {{task}}" });
  });
});
