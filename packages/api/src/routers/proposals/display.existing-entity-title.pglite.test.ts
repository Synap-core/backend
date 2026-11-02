/**
 * READ time — a graph op that LINKS an existing record (`existingEntityId`)
 * whose own title is only its ref ("p1") is labelled with the record's REAL
 * title, through the real `enrichProposalsForDisplay` on PGlite: the id rides
 * the page's one batched, name-floored entity join. Before, the review named
 * the record "p1" (graph proposal e8fc00d6's sibling case). A record the
 * viewer cannot read keeps the op's own label: the join never becomes an
 * oracle for a name.
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
const AUDIENCE = randomUUID();
const HIDDEN_ENTITY = randomUUID();
const HIDDEN_TITLE = "Somebody else's audience";

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
    `insert into entities (id, user_id, workspace_id, type, title) values ($1,$3,$4,'audience','BYOA technical operators'),($2,$5,$6,'audience',$7)`,
    [AUDIENCE, HIDDEN_ENTITY, VIEWER, WS_SEEN, OTHER, WS_HIDDEN, HIDDEN_TITLE]
  );
});

function graphRow(operations: unknown[]) {
  const now = new Date();
  return {
    id: randomUUID(),
    status: "approval_failed",
    proposalType: "capture.graph",
    targetType: "entity",
    targetId: randomUUID(),
    data: { operations, graphSource: "capture" },
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

type Graph = {
  entities: Array<{ ref: string; title: string }>;
  relations: Array<{ sourceLabel: string; targetLabel: string }>;
};
async function graphOf(operations: unknown[]): Promise<Graph> {
  const [out] = await enrichProposalsForDisplay([graphRow(operations)], VIEWER);
  return (out as unknown as { review: { graph: Graph } }).review.graph;
}

describe("a graph op linking an existing record shows its real title", () => {
  it("a title that is only the ref reads as the record's title, in the node and the link", async () => {
    const graph = await graphOf([
      {
        op: "create_entity",
        ref: "p1",
        title: "p1",
        profileSlug: "audience",
        existingEntityId: AUDIENCE,
      },
      {
        op: "create_entity",
        ref: "n",
        title: "A new pain",
        profileSlug: "pain-point",
      },
      {
        op: "create_relation",
        type: "relates_to",
        sourceRef: "n",
        targetRef: "p1",
      },
    ]);
    expect(graph.entities[0]).toMatchObject({
      ref: "p1",
      title: "BYOA technical operators",
    });
    expect(graph.relations[0]!.targetLabel).toBe("BYOA technical operators");
  });

  it("an op with no title reads as the record's title too", async () => {
    const graph = await graphOf([
      {
        op: "create_entity",
        ref: "a",
        profileSlug: "audience",
        existingEntityId: AUDIENCE,
      },
    ]);
    expect(graph.entities[0]!.title).toBe("BYOA technical operators");
  });

  it("CONTROL: an op's own real title is kept", async () => {
    const graph = await graphOf([
      {
        op: "create_entity",
        ref: "p1",
        title: "Our wedge C operators",
        profileSlug: "audience",
        existingEntityId: AUDIENCE,
      },
    ]);
    expect(graph.entities[0]!.title).toBe("Our wedge C operators");
  });

  it("a record the viewer cannot read is never named", async () => {
    const graph = await graphOf([
      {
        op: "create_entity",
        ref: "p1",
        title: "p1",
        profileSlug: "audience",
        existingEntityId: HIDDEN_ENTITY,
      },
    ]);
    expect(graph.entities[0]!.title).toBe("p1");
    expect(JSON.stringify(graph)).not.toContain(HIDDEN_TITLE);
  });
});
