/**
 * A proposal whose APPROVAL FAILED is repaired by revising it: the revision
 * reopens it as pending (decision fa6c8833, 2026-10-29). It used to be refused
 * as "no longer pending — it was reviewed elsewhere", so the only way out was
 * to withdraw it and file a twin: two sessions did that for the same five
 * founder preferences in the same minute, and the founder reviewed both.
 *
 * SEAM: the REAL MCP `synap_revise_proposal` handler → `reviseProposal` → the
 * shared core `mergeProposalRevision`, on PGlite. Nothing hand-built between.
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

/** An agent's entity create that failed when the person approved it. */
async function insertFailed(
  status: string,
  extra: Record<string, unknown> = {}
): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into proposals (id, workspace_id, target_type, target_id, status, proposal_type, data, agent_user_id, created_by, subject_user_id, rejection_reason, reviewed_by, reviewed_at)
     values ($1,$2,'entity',$3,$4,'create',$5::jsonb,$6,$7,$7,$8,$7,now())`,
    [
      id,
      WS,
      randomUUID(),
      status,
      JSON.stringify({
        requestId: randomUUID(),
        targetType: "entity",
        changeType: "create",
        data: {
          profileSlug: "user_observation",
          title: "Founder working preference",
          properties: { uo_category: "preference", uo_observation: "x" },
        },
        failure: { errorClass: "validation" },
        summary: "s",
        ...extra,
      }),
      AGENT,
      OWNER,
      "Couldn't apply — some of the details aren't valid.",
    ]
  );
  return id;
}

async function rowOf(id: string) {
  const { rows } = await q(
    `select status, rejection_reason, reviewed_by, data, revision_history from proposals where id = $1`,
    [id]
  );
  return rows[0] as {
    status: string;
    rejection_reason: string | null;
    reviewed_by: string | null;
    data: Record<string, unknown> & { data: Record<string, unknown> };
    revision_history: Array<Record<string, unknown>>;
  };
}

const revise = (args: Record<string, unknown>) =>
  buildHandlers.synap_revise_proposal!({
    toolName: "synap_revise_proposal",
    args,
    userId: OWNER,
    apiKeyScopes: ["mcp.read", "mcp.write"],
    agentUserId: AGENT,
  } as unknown as McpToolContext);

const fixCategory = (proposalId: string) =>
  revise({
    proposalId,
    patch: {
      kind: "inner",
      fields: {
        properties: { uo_category: "preferences", uo_observation: "x" },
      },
    },
  });

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
  await h.client!.exec(`delete from proposals;`);
});

describe("revising a proposal whose approval failed reopens it (decision fa6c8833)", () => {
  it("the agent's repair lands, and the proposal waits for a review again", async () => {
    const id = await insertFailed("approval_failed");
    await fixCategory(id);
    const row = await rowOf(id);
    expect(row.status).toBe("pending");
    expect(row.rejection_reason).toBeNull();
    expect(row.reviewed_by).toBeNull();
    expect(row.data.data.properties).toEqual({
      uo_category: "preferences",
      uo_observation: "x",
    });
    // The failure is history, not a live mark on a pending row.
    expect(row.data.failure).toBeUndefined();
    expect(row.revision_history.at(-1)).toMatchObject({
      reopened: {
        from: "approval_failed",
        failure: "validation",
        rejectionReason: "Couldn't apply — some of the details aren't valid.",
      },
    });
  });

  it("a plan that partly applied and could not be undone is not reopened", async () => {
    const id = await insertFailed("approval_failed", {
      planFailure: {
        compensation: { notCompensated: [{ ref: "$op1", reason: "x" }] },
      },
    });
    await expect(fixCategory(id)).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringMatching(/could not be undone/),
    });
    expect((await rowOf(id)).status).toBe("approval_failed");
  });

  it("a decided proposal is refused with its real state, never 'reviewed elsewhere'", async () => {
    for (const [status, words] of [
      ["approved", /already approved/],
      ["rejected", /was rejected/],
      ["withdrawn", /was withdrawn/],
    ] as const) {
      const id = await insertFailed(status);
      await expect(fixCategory(id)).rejects.toMatchObject({
        code: "CONFLICT",
        message: expect.stringMatching(words),
      });
      expect((await rowOf(id)).status).toBe(status);
    }
  });
});
