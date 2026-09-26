/**
 * PROJECT-PINNED VIEWS (W2a, concept consolidation) on PGlite, through the
 * REAL `views.create` and `views.execute` procedures, the real access floor
 * (`accessScopeWhere`) and the real project narrow (`projectLensWhere`, the
 * `belongs_to_project` predicate). Only governance, the audit log, side
 * effects and the split-brain guard are stubbed.
 *
 * Principals: A and B, two users of one pod, each a member of their OWN
 * workspaces only. No `project_members` rows: membership of a project is not
 * what these assertions are about, and a member row would widen the floor by
 * design (exposure) — that path is covered by exposure-guest-floor.
 *
 *   P  — A's project, pod-personal; its members span WA and WB.
 *   Q  — B's project, pod-personal.
 *
 * What this CANNOT see: production Postgres (tables generated from the Drizzle
 * definitions), facet/role lens rows (none seeded), Typesense.
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

const A = randomUUID();
const B = randomUUID();
const WA = randomUUID();
const WB = randomUUID();
const WX = randomUUID(); // B's
const P = randomUUID(); // A's project
const Q = randomUUID(); // B's project
const KIND = randomUUID();

const E_WA_P = randomUUID(); // WA, in P
const E_WB_P = randomUUID(); // WB, in P
const E_WA = randomUUID(); // WA, NOT in P
const E_POD_P = randomUUID(); // A's pod-personal, in P
const E_WX_P = randomUUID(); // B's WX, linked to P — A cannot see WX
const E_WX_Q = randomUUID(); // B's WX, in Q
const E_WA_Q = randomUUID(); // A's WA, linked to Q — B cannot see WA

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

const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);
const callerFor = (userId: string) =>
  ({ authenticated: true, userId, workspaceId: null }) as never;

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "OK";
  } catch (err) {
    return (err as { code?: string }).code ?? String(err);
  }
}

async function run(userId: string, viewId: string, projectId?: string) {
  const res = (await viewsRouter
    .createCaller(callerFor(userId))
    .execute({ id: viewId, ...(projectId ? { projectId } : {}) })) as {
    entities: Array<{ id: string }>;
  };
  return new Set(res.entities.map((e) => e.id));
}

async function insertView(
  owner: string,
  workspaceId: string | null,
  projectId: string | null
): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into views (id, workspace_id, user_id, project_id, name, type, scope_profile_ids, query, config, metadata)
     values ($1, $2, $3, $4, 'v', 'table', $5::uuid[], '{}'::jsonb, '{}'::jsonb, '{}'::jsonb)`,
    [id, workspaceId, owner, projectId, `{${KIND}}`]
  );
  return id;
}

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
    [WB, A],
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
    `insert into projects (id, user_id, workspace_id, name, status) values ($1,$2,null,'P','active'),($3,$4,null,'Q','active')`,
    [P, A, Q, B]
  );
  await q(
    `insert into profiles (id, slug, display_name, profile_kind, scope) values ($1,'thing','Thing','kind','system')`,
    [KIND]
  );
  for (const [id, owner, ws] of [
    [E_WA_P, A, WA],
    [E_WB_P, A, WB],
    [E_WA, A, WA],
    [E_POD_P, A, null],
    [E_WX_P, B, WX],
    [E_WX_Q, B, WX],
    [E_WA_Q, A, WA],
  ] as const) {
    await q(
      `insert into entities (id, user_id, workspace_id, profile_id, title, properties) values ($1,$2,$3,$4,'e','{}'::jsonb)`,
      [id, owner, ws, KIND]
    );
  }
  for (const [src, owner, ws, project] of [
    [E_WA_P, A, WA, P],
    [E_WB_P, A, WB, P],
    [E_POD_P, A, null, P],
    [E_WX_P, B, WX, P],
    [E_WX_Q, B, WX, Q],
    [E_WA_Q, A, WA, Q],
  ] as const) {
    await q(
      `insert into relations (id, user_id, workspace_id, source_entity_id, target_entity_id, type) values ($1,$2,$3,$4,$5,'belongs_to_project')`,
      [randomUUID(), owner, ws, src, project]
    );
  }
}, 120_000);

describe("views.create accepts projectId", () => {
  it("creates a PINNED view with no workspace, through the governance gate", async () => {
    h.permCalls.length = 0;
    const res = (await viewsRouter.createCaller(callerFor(A)).create({
      name: "P board",
      type: "table",
      scopeProfileIds: [KIND],
      projectId: P,
    })) as {
      view: {
        id: string;
        projectId: string | null;
        workspaceId: string | null;
      };
    };
    expect(res.view.projectId).toBe(P);
    expect(res.view.workspaceId).toBeNull();
    // Gated even without a workspace — never an ungoverned agent write.
    expect(h.permCalls).toHaveLength(1);
    expect(h.permCalls[0]).toMatchObject({ projectId: P, subjectType: "view" });
    // …and the pin is what execute narrows by.
    expect(await run(A, res.view.id)).toEqual(
      new Set([E_WA_P, E_WB_P, E_POD_P])
    );
  });

  it("refuses a pin to a project the caller cannot see (NOT_FOUND, nothing filed)", async () => {
    h.permCalls.length = 0;
    expect(
      await code(
        viewsRouter.createCaller(callerFor(B)).create({
          name: "snoop",
          type: "table",
          scopeProfileIds: [KIND],
          projectId: P,
        })
      )
    ).toBe("NOT_FOUND");
    expect(h.permCalls).toHaveLength(0);
  });
});

describe("views.execute honours view.projectId", () => {
  it("NO workspace + pin ⇒ the owner's full visible access narrowed to the project, across workspaces", async () => {
    const v = await insertView(A, null, P);
    // WA + WB + pod-personal members of P; NOT A's non-P entity; NOT B's WX
    // entity even though it is linked to P (A cannot see WX).
    expect(await run(A, v)).toEqual(new Set([E_WA_P, E_WB_P, E_POD_P]));
  });

  it("a WORKSPACE view pinned to P narrows that workspace to P's members", async () => {
    const v = await insertView(A, WA, P);
    // Pod-wide globals stay in a workspace lens (includePodWide), narrowed.
    expect(await run(A, v)).toEqual(new Set([E_WA_P, E_POD_P]));
  });

  it("an input projectId only narrows further — it cannot escape the pin", async () => {
    const v = await insertView(A, null, P);
    // A may pass B's project id: P ∩ Q is empty for A.
    expect(await run(A, v, Q)).toEqual(new Set());
  });

  it("an UNPINNED null-workspace view stays pod-personal (unchanged)", async () => {
    const v = await insertView(A, null, null);
    expect(await run(A, v)).toEqual(new Set([E_POD_P]));
  });

  it("TWO USERS, no leak: B's pinned view on Q never shows A's entity linked to Q; B cannot run A's view", async () => {
    const vb = await insertView(B, null, Q);
    expect(await run(B, vb)).toEqual(new Set([E_WX_Q]));
    const va = await insertView(A, null, P);
    expect(await code(run(B, va))).toBe("FORBIDDEN");
  });
});
