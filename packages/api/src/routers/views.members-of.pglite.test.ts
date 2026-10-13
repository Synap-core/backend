/**
 * LIVE LISTS — `config.membersOf` as a VIEW SCOPE in `views.execute`, on PGlite
 * through the REAL procedure and the real access floor. Only governance, the
 * audit log, side effects and the split-brain guard are stubbed (same harness
 * as views.project-pinned.pglite.test.ts).
 *
 * A List a Library Build made names its group container in `membersOf` and was
 * born with a fixed `query.entityIds`. The List must show the container's
 * CURRENT members (`parent_of` edges), so a rebuild that attaches a new member
 * grows it — and never a member the caller cannot read.
 *
 * What this CANNOT see: production Postgres, Typesense.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  permCalls: [] as Array<Record<string, unknown>>,
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
      append: async () => undefined,
      emitCompleted: async () => undefined,
    },
  };
});
vi.mock("../utils/permission-check.js", () => ({
  checkPermissionOrPropose: vi.fn(async (args: Record<string, unknown>) => {
    h.permCalls.push(args);
    return args.agentUserId ? { proposalId: "proposal-1" } : { allowed: true };
  }),
  previewPermissionDecision: vi.fn(async () => ({ decision: "allow" })),
  proposedMessageFor: vi.fn(() => "proposed"),
}));
vi.mock("../utils/audit-log.js", () => ({ auditLog: vi.fn() }));
vi.mock("../utils/split-brain-service.js", () => ({
  isPodReadOnly: vi.fn().mockResolvedValue(false),
}));
vi.mock("@synap/events", () => ({ emitSideEffects: async () => {} }));
vi.mock("../lib/event-helpers.js", () => ({
  ViewEvents: new Proxy(
    {},
    { get: (_t, k) => (k === "then" ? undefined : async () => undefined) }
  ),
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { viewsRouter } from "./views.js";

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
    const def =
      c.name === "created_at" || c.name === "updated_at"
        ? " default now()"
        : "";
    return `"${c.name}" ${type}${pk}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const A = randomUUID();
const B = randomUUID();
const WA = randomUUID();
const WX = randomUUID(); // B's
const KIND = randomUUID();
const C = randomUUID(); // the group container (A, WA)
const M1 = randomUUID(); // born member
const M2 = randomUUID(); // member attached later (a rebuild)
const N = randomUUID(); // A's, never a member
const BX = randomUUID(); // B's, attached to C — A cannot see WX

const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);
const callerFor = (userId: string) =>
  ({ authenticated: true, userId, workspaceId: null }) as never;

async function run(userId: string, viewId: string) {
  const res = (await viewsRouter
    .createCaller(callerFor(userId))
    .execute({ id: viewId })) as { entities: Array<{ id: string }> };
  return new Set(res.entities.map((e) => e.id));
}

async function insertList(config: Record<string, unknown>): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into views (id, workspace_id, user_id, name, type, scope_profile_ids, query, config, metadata)
     values ($1, $2, $3, 'Recipes', 'list', $4::uuid[], $5::jsonb, $6::jsonb, '{}'::jsonb)`,
    [
      id,
      WA,
      A,
      `{${KIND}}`,
      JSON.stringify({ entityIds: [M1] }),
      JSON.stringify(config),
    ]
  );
  return id;
}

const attach = (member: string, owner: string, ws: string) =>
  q(
    `insert into relations (id, user_id, workspace_id, source_entity_id, target_entity_id, type) values ($1,$2,$3,$4,$5,'parent_of')`,
    [randomUUID(), owner, ws, C, member]
  );

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));

  for (const u of [A, B]) {
    await q(`insert into users (id, email) values ($1, $2)`, [
      u,
      `${u}@example.test`,
    ]);
  }
  await q(
    `insert into pod_members (id, user_id, pod_role) values ($1,$2,'owner'),($3,$4,'member')`,
    [randomUUID(), A, randomUUID(), B]
  );
  for (const [ws, owner] of [
    [WA, A],
    [WX, B],
  ] as const) {
    await q(
      `insert into workspaces (id, name, owner_id, settings) values ($1,'w',$2,'{}'::jsonb)`,
      [ws, owner]
    );
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
      [randomUUID(), ws, owner]
    );
  }
  await q(
    `insert into profiles (id, slug, display_name, profile_kind, scope) values ($1,'thing','Thing','kind','system')`,
    [KIND]
  );
  for (const [id, owner, ws] of [
    [C, A, WA],
    [M1, A, WA],
    [M2, A, WA],
    [N, A, WA],
    [BX, B, WX],
  ] as const) {
    await q(
      `insert into entities (id, user_id, workspace_id, profile_id, title, properties) values ($1,$2,$3,$4,'e','{}'::jsonb)`,
      [id, owner, ws, KIND]
    );
  }
  await attach(M1, A, WA);
  await attach(BX, B, WX);
}, 120_000);

describe("views.execute — membersOf is a live scope", () => {
  it("shows the container's CURRENT members, and grows when a member is attached", async () => {
    const list = await insertList({ membersOf: C });
    expect(await run(A, list)).toEqual(new Set([M1]));
    await attach(M2, A, WA);
    // Born over M1 only (query.entityIds) — the live scope supersedes it.
    expect(await run(A, list)).toEqual(new Set([M1, M2]));
  });

  it("never shows a member the caller cannot read, nor a non-member", async () => {
    const list = await insertList({ membersOf: C });
    const seen = await run(A, list);
    expect(seen.has(BX)).toBe(false);
    expect(seen.has(N)).toBe(false);
    expect(seen.has(C)).toBe(false);
  });

  it("a List without membersOf keeps its fixed set", async () => {
    const list = await insertList({});
    expect(await run(A, list)).toEqual(new Set([M1]));
  });

  it("a malformed membersOf is no scope — the fixed set stands", async () => {
    const list = await insertList({ membersOf: "not-an-id" });
    expect(await run(A, list)).toEqual(new Set([M1]));
  });
});
