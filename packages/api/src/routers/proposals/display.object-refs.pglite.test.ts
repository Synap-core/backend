/**
 * READ time — `objectRefs`: every `*Id` / `*Ids` a proposal payload names
 * (nested, arrays) resolved to `{ id, kind, name }`, keyed by payload path,
 * through the real `enrichProposalsForDisplay` on PGlite with the real access
 * predicates. An id the viewer may not read gets NO entry (absent = unknown).
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
const OTHER = "other-1";
const WS_SEEN = randomUUID();
const WS_HIDDEN = randomUUID();
const PB_SEEN = randomUUID();
const PB_HIDDEN = randomUUID();
const HIDDEN_NAME = "Other's secret template";
const RULE = randomUUID();
const ACME = randomUUID();
const BETA = randomUUID();
const HIDDEN_LEAD = randomUUID();
const HIDDEN_LEAD_NAME = "Somebody else's lead";

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

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));
  await q(
    `insert into workspaces (id, name, owner_id) values ($1,'Foundation',$3),($2,'Hidden WS',$4)`,
    [WS_SEEN, WS_HIDDEN, VIEWER, OTHER]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner'),($4,$5,$6,'owner')`,
    [randomUUID(), WS_SEEN, VIEWER, randomUUID(), WS_HIDDEN, OTHER]
  );
  await q(
    `insert into playbooks (id, workspace_id, created_by, name, goal_template, status) values ($1,$2,$3,'Qualify a lead','g','active'),($4,$5,$6,$7,'g','active')`,
    [PB_SEEN, WS_SEEN, VIEWER, PB_HIDDEN, WS_HIDDEN, OTHER, HIDDEN_NAME]
  );
  await q(
    `insert into automations (id, workspace_id, created_by, name) values ($1,$2,$3,'New lead → qualify')`,
    [RULE, WS_SEEN, VIEWER]
  );
  await q(
    `insert into entities (id, user_id, workspace_id, type, title) values ($1,$4,$5,'lead','Acme Corp'),($2,$4,$5,'lead','Beta Ltd'),($3,$6,$7,'lead',$8)`,
    [
      ACME,
      BETA,
      HIDDEN_LEAD,
      VIEWER,
      WS_SEEN,
      OTHER,
      WS_HIDDEN,
      HIDDEN_LEAD_NAME,
    ]
  );
});

function row(payload: Record<string, unknown>) {
  const now = new Date();
  return {
    id: randomUUID(),
    status: "pending",
    proposalType: "capability.run",
    targetType: "capability",
    targetId: randomUUID(),
    data: {
      targetType: "capability",
      targetId: randomUUID(),
      changeType: "run",
      data: payload,
    },
    workspaceId: WS_SEEN,
    projectId: null,
    threadId: null,
    sessionId: null,
    correlationId: null,
    agentUserId: null,
    subjectUserId: VIEWER,
    createdBy: VIEWER,
    reviewedBy: null,
    createdAt: now,
    updatedAt: now,
  } as never;
}

type Refs = Record<string, { id: string; kind: string; name: string | null }>;
async function refsOf(
  payload: Record<string, unknown>
): Promise<Refs | undefined> {
  const [out] = await enrichProposalsForDisplay([row(payload)], VIEWER);
  return (out as unknown as { objectRefs?: Refs }).objectRefs;
}

describe("objectRefs — the payload's ids, as doors", () => {
  it("resolves nested ids and id arrays to their object, keyed by path", async () => {
    const refs = await refsOf({
      subjectId: ACME,
      parameters: { automationId: RULE, playbookId: PB_SEEN },
      entityIds: [BETA, ACME],
      spaceGrant: { workspaceId: WS_SEEN },
    });
    expect(refs).toEqual({
      subjectId: { id: ACME, kind: "entity", name: "Acme Corp" },
      "parameters.automationId": {
        id: RULE,
        kind: "automation",
        name: "New lead → qualify",
      },
      "parameters.playbookId": {
        id: PB_SEEN,
        kind: "playbook",
        name: "Qualify a lead",
      },
      "entityIds.0": { id: BETA, kind: "entity", name: "Beta Ltd" },
      "entityIds.1": { id: ACME, kind: "entity", name: "Acme Corp" },
      "spaceGrant.workspaceId": {
        id: WS_SEEN,
        kind: "workspace",
        name: "Foundation",
      },
    });
  });

  it("never resolves an id the viewer may not read", async () => {
    const refs = await refsOf({
      subjectId: HIDDEN_LEAD,
      playbookId: PB_HIDDEN,
      workspaceId: WS_HIDDEN,
    });
    expect(refs).toBeUndefined();
  });
});
