/**
 * GUEST PROVENANCE — a proposal filed through a public form (Sites W4) must
 * reach the review surfaces as a GUEST's, never as AI work. Driven through the
 * REAL `enrichProposalsForDisplay` on PGlite: the actor's stored `agent_type`
 * is the only input; nothing between the users row and the enriched field is
 * hand-built.
 *
 * Discriminating fixtures: the ordinary agent and the form actor are BOTH
 * `user_type = 'agent'` with an agentUserId on the proposal — the exact input
 * on which "has an agent ⇒ AI" and the guest rule disagree. The forged row
 * carries `form:` only in `agent_metadata`, proving the rule reads the column.
 *
 * What this cannot see: the frontend presenters (synap-app
 * `useProposalPresentation`, relay) that must honour `actorKind` — handoff.
 */

import { describe, it, expect, vi, beforeAll } from "vitest";
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
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  return { ...actual, db: drizzle(client) };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { enrichProposalsForDisplay } from "./display.js";

const VIEWER = "viewer-1";
const WS = randomUUID();
const FORM_ID = randomUUID();
const FORM_ACTOR = "form-actor-user";
const AI_AGENT = "ai-agent-user";
const FORGED = "forged-agent-user";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}
const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);

async function enrichAs(agentUserId: string | null) {
  const now = new Date();
  const [row] = await enrichProposalsForDisplay(
    [
      {
        id: randomUUID(),
        status: "pending",
        proposalType: "create",
        targetType: "entity",
        targetId: randomUUID(),
        data: {},
        workspaceId: WS,
        projectId: null,
        threadId: null,
        sessionId: null,
        correlationId: null,
        agentUserId,
        subjectUserId: VIEWER,
        createdBy: VIEWER,
        reviewedBy: null,
        createdAt: now,
        updatedAt: now,
      } as never,
    ],
    VIEWER
  );
  return row as unknown as Record<string, unknown>;
}

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));
  await q(`insert into workspaces (id, name, owner_id) values ($1,'W',$2)`, [
    WS,
    VIEWER,
  ]);
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
    [randomUUID(), WS, VIEWER]
  );
  await q(
    `insert into users (id, name, email, user_type, agent_type, agent_metadata, created_by_user_id) values
      ($1,'Form: Contact','f@x','agent',$2,$3::jsonb,$4),
      ($5,'Scout','s@x','agent','assistant','{"agentType":"assistant"}'::jsonb,$4),
      ($6,'Forged','g@x','agent','assistant',$3::jsonb,$4),
      ($4,'Owner','o@x','human',null,null,null)`,
    [
      FORM_ACTOR,
      `form:${FORM_ID}`,
      JSON.stringify({ agentType: `form:${FORM_ID}` }),
      VIEWER,
      AI_AGENT,
      FORGED,
    ]
  );
});

describe("enrichProposalsForDisplay — guest provenance", () => {
  it("a form actor's proposal is a GUEST's, with the form as its door", async () => {
    const row = await enrichAs(FORM_ACTOR);
    expect(row.actorKind).toBe("guest");
    expect(row.formId).toBe(FORM_ID);
  });

  it("an ordinary agent's proposal carries NO guest marking", async () => {
    const row = await enrichAs(AI_AGENT);
    expect(row.agentActorName).toBeTruthy(); // non-vacuity: the actor WAS resolved
    expect(row).not.toHaveProperty("actorKind");
    expect(row).not.toHaveProperty("formId");
  });

  it("the rule reads the agent_type COLUMN — `form:` in agent_metadata alone is not a guest", async () => {
    const row = await enrichAs(FORGED);
    expect(row.agentActorName).toBeTruthy();
    expect(row).not.toHaveProperty("actorKind");
  });

  it("a human's proposal carries no actor marking at all", async () => {
    const row = await enrichAs(null);
    expect(row).not.toHaveProperty("actorKind");
  });
});
