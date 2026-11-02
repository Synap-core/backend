/**
 * `synap_get_relations` on a POD-WIDE entity — the REAL handler, the REAL hub
 * relations router and the REAL access registry, on PGlite (every table
 * generated from the Drizzle definitions).
 *
 * The bug: an entity with no workspace fell back to the caller's FIRST member
 * workspace (`ids[0]`) as the lens, so its edges drawn in any other space were
 * hidden, while `synap_get_graph` on the same entity (user floor, no lens)
 * showed them. Fixed: no lens ⇒ `listRelationsPodWide`, the user floor.
 *
 * Fixture: caller U is a member of W1 and W2. PE is pod-wide (NULL
 * workspace, owned by U) with three edges: PE→X1 drawn in W1, X2→PE drawn in
 * W2, PE→X3 pod-wide (owner U). Whichever of W1/W2 the old pick lands on,
 * one edge is missing, so the parity assertion is red on the old code for
 * either sort order.
 *
 * The floor must not widen: O (no membership, not the owner) sees none of
 * PE's edges, through either tool.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => {
  const state = {
    client: null as null | {
      exec: (sql: string) => Promise<unknown>;
      query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    },
    db: null as unknown,
    async init(): Promise<unknown> {
      if (!state.db) {
        const { PGlite } = await import("@electric-sql/pglite");
        const { drizzle } = await import("drizzle-orm/pglite");
        const schema = await import("@synap/database/schema");
        const client = new PGlite();
        state.client = client as unknown as typeof state.client;
        state.db = drizzle(client, { schema });
      }
      return state.db;
    },
    async clientPgModule() {
      const db = await state.init();
      return {
        db,
        sql: undefined,
        getDb: async () => db,
        setCurrentUser: async () => undefined,
        clearCurrentUser: async () => undefined,
        closeDatabase: async () => undefined,
      };
    },
  };
  return state;
});

vi.mock("../../../../../database/dist/client-pg.js", () => h.clientPgModule());
vi.mock("../../../../../database/src/client-pg.js", () => h.clientPgModule());
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const pg = await h.init();
  return { ...actual, db: pg, getDb: async () => pg };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import type { McpToolContext } from "./shared.js";

const { readHandlers } = await import("./read.js");
const { hubRelationsRouter } = await import("../../hub-protocol/relations.js");

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const pk = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    return `"${c.name}" ${type}${pk}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}

const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);

const U = randomUUID(); // the caller: member of W1 and W2, owner of PE
const O = randomUUID(); // an outsider: no membership, owns nothing here
const W1 = randomUUID();
const W2 = randomUUID();
const PE = randomUUID(); // pod-wide entity (NULL workspace)
const X1 = randomUUID(); // in W1
const X2 = randomUUID(); // in W2
const X3 = randomUUID(); // pod-wide, owned by U

/** The MCP context the adapter builds: a hub caller acting as `userId`. */
function ctxFor(
  userId: string,
  toolName: string,
  args: Record<string, unknown>
): McpToolContext {
  const relations = hubRelationsRouter.createCaller({
    authenticated: true,
    userId,
    scopes: ["hub-protocol.read"],
    apiKeyId: "test-key",
    apiKeyName: "test",
    workspaceId: null,
    isHubProtocol: true,
  } as never);
  return {
    toolName,
    args,
    userId,
    apiKeyScopes: ["mcp.read"],
    caller: { relations } as unknown as McpToolContext["caller"],
    lensCaller: {} as McpToolContext["lensCaller"],
    workspaceAccessible: false,
  } as McpToolContext;
}

function payloadOf(
  result: Awaited<
    ReturnType<NonNullable<typeof readHandlers.synap_get_relations>>
  >
) {
  const block = result.content?.[0];
  if (!block || block.type !== "text") throw new Error("expected text");
  return JSON.parse(block.text) as Record<string, unknown>;
}

async function relatedIds(userId: string): Promise<string[]> {
  const payload = payloadOf(
    await readHandlers.synap_get_relations!(
      ctxFor(userId, "synap_get_relations", { entityId: PE })
    )
  );
  expect(payload.error).toBeUndefined();
  const list = (payload.entities ?? []) as Array<{ id: string }>;
  return list.map((e) => e.id).sort();
}

async function graphEntityIds(userId: string): Promise<string[]> {
  const payload = payloadOf(
    await readHandlers.synap_get_graph!(
      ctxFor(userId, "synap_get_graph", { id: PE, type: "entity" })
    )
  );
  const neighbors = (payload.neighbors ?? []) as Array<{
    kind: string;
    id: string;
  }>;
  return [
    ...new Set(neighbors.filter((n) => n.kind === "entity").map((n) => n.id)),
  ].sort();
}

beforeAll(async () => {
  await h.init();
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));

  for (const u of [U, O]) {
    await q(`insert into users (id, email) values ($1, $2)`, [
      u,
      `${u}@example.test`,
    ]);
  }
  await q(
    `insert into workspaces (id, name, owner_id, settings) values ($1,'W1',$3,'{}'::jsonb),($2,'W2',$3,'{}'::jsonb)`,
    [W1, W2, U]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner'),($4,$5,$3,'owner')`,
    [randomUUID(), W1, U, randomUUID(), W2]
  );
  for (const [id, ws, title] of [
    [PE, null, "Pod-wide entity"],
    [X1, W1, "In W1"],
    [X2, W2, "In W2"],
    [X3, null, "Pod-wide neighbour"],
  ] as const) {
    await q(
      `insert into entities (id, user_id, workspace_id, title, type) values ($1,$2,$3,$4,'note')`,
      [id, U, ws, title]
    );
  }
  await q(
    `insert into relations (id, user_id, workspace_id, source_entity_id, target_entity_id, type, source_kind, target_kind, created_at)
     values ($1,$2,$3,$4,$5,'relates_to','entity','entity',now()),
            ($6,$2,$7,$8,$4,'relates_to','entity','entity',now()),
            ($9,$2,null,$4,$10,'relates_to','entity','entity',now())`,
    [randomUUID(), U, W1, PE, X1, randomUUID(), W2, X2, randomUUID(), X3]
  );
}, 120_000);

describe("synap_get_relations — a pod-wide entity", () => {
  it("returns every edge the caller can see, across both workspaces", async () => {
    expect(await relatedIds(U)).toEqual([X1, X2, X3].sort());
  });

  it("returns the same links as synap_get_graph on the same entity", async () => {
    const viaGraph = await graphEntityIds(U);
    expect(viaGraph).toEqual([X1, X2, X3].sort());
    expect(await relatedIds(U)).toEqual(viaGraph);
  });

  it("does not widen the floor: an outsider sees none of its edges", async () => {
    expect(await relatedIds(O)).toEqual([]);
    expect(await graphEntityIds(O)).toEqual([]);
  });

  it("an explicit workspaceId still narrows to that workspace", async () => {
    const payload = payloadOf(
      await readHandlers.synap_get_relations!(
        ctxFor(U, "synap_get_relations", { entityId: PE, workspaceId: W1 })
      )
    );
    const ids = ((payload.entities ?? []) as Array<{ id: string }>).map(
      (e) => e.id
    );
    // W1's edge, never W2's.
    expect(ids).toContain(X1);
    expect(ids).not.toContain(X2);
  });
});
