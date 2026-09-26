/**
 * Sites W2 S2 — THE GUEST FLOOR, end to end on PGlite, through the real doors.
 *
 * Driven through: `relations.exposeToAnchor` + `relations.grantAnchorMembership`
 * (real router, real repositories), the real access registry (`scopedDb`), the
 * real document gates (`loadReadableDocument` / `loadEditableDocument`), the
 * real `assertViewAccess`, and the real `views.list` / `projects.get` /
 * `projects.list` procedures. Only governance (`checkPermissionOrPropose`: grant
 * for a human, propose for an agent), the audit log and the split-brain guard
 * are stubbed. 0276 is executed after the Drizzle DDL, so its CHECKs exist.
 *
 * Principals (all with a `users` row unless stated):
 *   A   — owner: pod_members owner, owns workspaces W and PV (pod_visible);
 *   M   — a participant: pod_members member, no project membership;
 *   G   — a GUEST: project_members(P, 'guest') granted through the door, and
 *         nothing else;
 *   GP  — a guest role on P who is ALSO a participant (pod_members) — keeps the
 *         full participant floor;
 *   PV_ — a project-only VIEWER on P (the federated scopeKind:"project" shape),
 *         no participation: NOT a guest, access unchanged;
 *   X   — an UNKNOWN principal: no row anywhere, not even `users`.
 *
 * What this CANNOT see: production Postgres (tables are generated from the
 * Drizzle definitions; only 0276's constraints are real), realtime rooms, the
 * IS / agent hub, keyword search (Typesense), and the workspace-lens default of
 * `accessFor()` (R1: a guest on a door that defaults the lens to `null` sees
 * nothing — NEEDS-DOGFOOD for the W6 viewer).
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const schema = await import("@synap/database/schema");
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema });
  h.db = db;
  return {
    ...actual,
    db,
    getDb: async () => db,
    eventRepository: { append: async () => undefined },
  };
});
vi.mock("../utils/permission-check.js", () => ({
  checkPermissionOrPropose: vi.fn(async (args: { agentUserId?: string }) =>
    args.agentUserId ? { proposalId: "proposal-1" } : { allowed: true }
  ),
  previewPermissionDecision: vi.fn(),
  proposedMessageFor: vi.fn(() => "proposed"),
}));
vi.mock("../utils/audit-log.js", () => ({ auditLog: vi.fn() }));
vi.mock("../utils/split-brain-service.js", () => ({
  isPodReadOnly: vi.fn().mockResolvedValue(false),
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { eq } from "drizzle-orm";
import * as schema from "@synap/database/schema";
import {
  entities,
  documents,
  views,
  projects,
  projectTracks,
  resourceShares,
  automations,
} from "@synap/database/schema";
import { ProjectRepository } from "@synap/database";
import { AccessContext, scopedDb } from "./index.js";
import { relationsRouter } from "../routers/relations.js";
import { viewsRouter, assertViewAccess } from "../routers/views.js";
import { projectsRouter } from "../routers/projects.js";
import { listTracks } from "../services/tracks/tracks-service.js";
import {
  loadEditableDocument,
  loadReadableDocument,
} from "../utils/document-edit-access.js";

const A = randomUUID();
const M = randomUUID();
const G = randomUUID();
const GP = randomUUID();
const PV_ = randomUUID();
const X = randomUUID();

const W = randomUUID();
const PV_WS = randomUUID();
let P = ""; // created by ProjectRepository.create (post-0151 shape)
let P3 = "";

const E = randomUUID(); // W, exposed to P (visible_to)
const F = randomUUID(); // PV_WS (pod_visible), unexposed
const U = randomUUID(); // W, unexposed
const B = randomUUID(); // W, belongs_to_project → P
const S = randomUUID(); // pod-wide, owned by A, live pod-wide facet (pod-shared)
const GE = randomUUID(); // pod-personal (NULL workspace), owned by the GUEST G
const D = randomUUID(); // E's body document (W)
const D2 = randomUUID(); // standalone document (W)
const V1 = randomUUID(); // exposed on P
const V2 = randomUUID(); // pinned to P, NOT exposed
const V3 = randomUUID(); // exposed on P3
const T_P = randomUUID(); // track on P
const T_P3 = randomUUID(); // track on P3
const RS = randomUUID(); // a resource_shares row (A, W)
const AUTO = randomUUID(); // a pod-wide (NULL workspace) automation — a pod-level global

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    // The repositories insert without an id (`defaultRandom()`), so uuid
    // primary keys carry the default the real schema has.
    const pk = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    return `"${c.name}" ${type}${pk}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "OK";
  } catch (err) {
    return (err as { code?: string }).code ?? String(err);
  }
}

const idsOf = (rows: Array<{ id: string }>) => new Set(rows.map((r) => r.id));
const seen = async (userId: string, table: object) =>
  idsOf(
    await scopedDb(AccessContext.operator({ userId })).findMany<{ id: string }>(
      table
    )
  );
const callerFor = (userId: string) =>
  ({ authenticated: true, userId, workspaceId: null }) as never;

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));
  // 0276's CHECKs / trigger on top of the Drizzle-derived tables.
  const here = path.dirname(fileURLToPath(import.meta.url));
  await h.client!.exec(
    readFileSync(
      path.resolve(
        here,
        "../../../database/migrations/0276_exposure_substrate.sql"
      ),
      "utf8"
    )
  );

  for (const u of [A, M, G, GP, PV_]) {
    await q(`insert into users (id, email) values ($1, $2)`, [
      u,
      `${u}@example.test`,
    ]);
  }
  await q(
    `insert into workspaces (id, name, owner_id, settings) values ($1,'W',$2,'{}'::jsonb),($3,'PV',$2,'{"workspaceVisibility":"pod_visible"}'::jsonb)`,
    [W, A, PV_WS]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
    [randomUUID(), W, A]
  );
  await q(
    `insert into pod_members (id, user_id, pod_role) values ($1,$2,'owner'),($3,$4,'member'),($5,$6,'member')`,
    [randomUUID(), A, randomUUID(), M, randomUUID(), GP]
  );

  // Projects through the ONE creation door — post-0151, no entity twin.
  const repo = new ProjectRepository(h.db, {
    append: async () => undefined,
  } as never);
  P = (
    await repo.create({ name: "Client portal", workspaceId: W, userId: A }, A)
  ).id;
  P3 = (
    await repo.create(
      { name: "Internal roadmap", workspaceId: W, userId: A },
      A
    )
  ).id;

  for (const [id, ws, owner, doc] of [
    [E, W, A, D],
    [F, PV_WS, A, null],
    [U, W, A, null],
    [B, W, A, null],
    [S, null, A, null],
    [GE, null, G, null],
  ] as const) {
    await q(
      `insert into entities (id, user_id, workspace_id, title, document_id) values ($1,$2,$3,'e',$4)`,
      [id, owner, ws, doc]
    );
  }
  await q(
    `insert into entity_facets (id, entity_id, workspace_id, deleted_at) values ($1,$2,null,null)`,
    [randomUUID(), S]
  );
  await q(
    `insert into relations (id, user_id, workspace_id, source_entity_id, target_entity_id, type) values ($1,$2,$3,$4,$5,'belongs_to_project')`,
    [randomUUID(), A, W, B, P]
  );
  for (const id of [D, D2]) {
    await q(
      `insert into documents (id, user_id, workspace_id, title, type, current_version, content_revision) values ($1,$2,$3,'Doc','markdown',1,1)`,
      [id, A, W]
    );
  }
  for (const [id, project, exposed] of [
    [V1, P, true],
    [V2, P, false],
    [V3, P3, true],
  ] as const) {
    await q(
      `insert into views (id, workspace_id, user_id, project_id, name, type, exposed_at) values ($1,$2,$3,$4,'v','table',$5)`,
      [id, W, A, project, exposed ? new Date() : null]
    );
  }
  await q(
    // status is NOT NULL DEFAULT 'active' in the real schema; the generated
    // PGlite DDL has no defaults, so it is set explicitly.
    `insert into project_tracks (id, project_id, user_id, status) values ($1,$2,$3,'active'),($4,$5,$3,'active')`,
    [T_P, P, A, T_P3, P3]
  );
  await q(
    `insert into resource_shares (id, resource_type, resource_id, created_by, workspace_id, audience, anchor_project_id) values ($1,'entity',$2,$3,$4,'link',$5)`,
    [RS, E, A, W, P]
  );
  await q(
    `insert into automations (id, created_by, workspace_id, name) values ($1,$2,null,'pod-wide')`,
    [AUTO, A]
  );
  // The other members of P. GP and PV_ are seeded directly (the door is
  // exercised for G below).
  await q(
    `insert into project_members (id, project_id, user_id, role) values ($1,$2,$3,'guest'),($4,$2,$5,'viewer')`,
    [randomUUID(), P, GP, randomUUID(), PV_]
  );

  // ── Through the doors: expose E to P, then grant G a guest membership. ──
  const asA = relationsRouter.createCaller(callerFor(A));
  const exposed = await asA.exposeToAnchor({ entityId: E, anchorId: P });
  expect(exposed.status).toBe("created");
  const granted = await asA.grantAnchorMembership({
    anchorId: P,
    userId: G,
    role: "guest",
  });
  expect(granted.status).toBe("created");
}, 120_000);

describe("T1 — a NEW project exposed to a guest, end to end", () => {
  it("P is a post-0151 project: it has no entity twin", async () => {
    const twin = await q(
      `select count(*)::int as n from entities where id = $1`,
      [P]
    );
    expect((twin.rows[0] as { n: number }).n).toBe(0);
  });

  it("the grant through the door stored role 'guest'", async () => {
    const r = await q(
      `select role from project_members where project_id = $1 and user_id = $2`,
      [P, G]
    );
    expect(r.rows).toEqual([{ role: "guest" }]);
  });

  it("the guest sees EXACTLY the exposed entity — not even its own pod-personal row", async () => {
    // GE is G's own NULL-workspace entity: the pod-personal branch is closed
    // to a guest (the floor is the exposure branch only).
    expect(await seen(G, entities)).toEqual(new Set([E]));
    // Non-vacuity: GE really exists (the exact-set above is what excludes it).
    const ge = await q(
      `select count(*)::int as n from entities where id = $1`,
      [GE]
    );
    expect((ge.rows[0] as { n: number }).n).toBe(1);
  });
});

describe("T2 — the guest floor is gated on participation, not removed", () => {
  it("the guest sees neither the pod-visible F nor the pod-shared S; a participant sees both", async () => {
    const g = await seen(G, entities);
    expect(g.has(F)).toBe(false);
    expect(g.has(S)).toBe(false);
    const m = await seen(M, entities);
    expect(m.has(F)).toBe(true);
    expect(m.has(S)).toBe(true);
  });

  it("a guest reads no pod-level global row; a participant does", async () => {
    expect((await seen(G, automations)).has(AUTO)).toBe(false);
    expect((await seen(M, automations)).has(AUTO)).toBe(true);
  });

  it("a guest who is ALSO a participant keeps the full participant floor", async () => {
    // pod-visible F + pod-shared S (participant), E (visible_to via its guest
    // anchor) — but NOT B: a guest anchor admits explicit shares only.
    expect(await seen(GP, entities)).toEqual(new Set([E, F, S]));
  });

  it("a project-only VIEWER (not a guest) keeps today's access", async () => {
    // B (belongs_to_project) + E (visible_to) through its anchor, and the
    // pod-visible workspace's F exactly as before this wave.
    expect(await seen(PV_, entities)).toEqual(new Set([B, E, F]));
  });

  it("audience() evaluates the same predicates", async () => {
    const audience = (u: string) =>
      AccessContext.operator({ userId: u }).audience();
    expect(await audience(G)).toBe("guest");
    expect(await audience(M)).toBe("member");
    expect(await audience(GP)).toBe("member");
    expect(await audience(PV_)).toBe("member");
    expect(await audience(X)).toBe("unknown");
  });
});

describe("T3 — a document follows its entity's exposure", () => {
  it("the guest reads E's body, cannot edit it, and cannot see a standalone document", async () => {
    expect(await codeOf(loadReadableDocument(G, D))).toBe("OK");
    expect(await codeOf(loadEditableDocument(G, D))).toBe("FORBIDDEN");
    expect(await codeOf(loadReadableDocument(G, D2))).toBe("NOT_FOUND");
  });
});

describe("T4 — a view visible through project membership (exposed_at)", () => {
  it("the guest sees exactly the view exposed on its project (not the pinned surface, not P3's)", async () => {
    expect(await seen(G, views)).toEqual(new Set([V1]));
  });

  it("assertViewAccess admits the read and refuses the write (the loaded row)", async () => {
    const v1 = await (
      h.db as {
        query: {
          views: {
            findFirst: (c: unknown) => Promise<typeof views.$inferSelect>;
          };
        };
      }
    ).query.views.findFirst({ where: eq(views.id, V1) });
    expect(v1.exposedAt).toBeTruthy();
    expect(await codeOf(assertViewAccess(v1, G, "read"))).toBe("OK");
    expect(await codeOf(assertViewAccess(v1, G, "write"))).toBe("FORBIDDEN");
  });

  it("the views.list door returns the exposed view to the guest", async () => {
    const res = (await viewsRouter
      .createCaller(callerFor(G))
      .list({})) as unknown as { items: Array<{ id: string }> };
    expect(idsOf(res.items)).toEqual(new Set([V1]));
  });
});

describe("T5 — projects and tracks follow membership", () => {
  it("the guest sees P and P's track only", async () => {
    expect(await seen(G, projects)).toEqual(new Set([P]));
    expect(await seen(G, projectTracks)).toEqual(new Set([T_P]));
  });

  it("the listTracks door (tRPC / Hub REST / MCP all call it) returns P's track to the guest", async () => {
    const onP = await listTracks({ projectId: P, actor: { userId: G } });
    expect(idsOf(onP ?? [])).toEqual(new Set([T_P]));
    // Not a member of P3: "no such project for you" (null), never [].
    expect(
      await listTracks({ projectId: P3, actor: { userId: G } })
    ).toBeNull();
    // Non-vacuity: the owner reads P3's track through the same door.
    const owner = await listTracks({ projectId: P3, actor: { userId: A } });
    expect(idsOf(owner ?? [])).toEqual(new Set([T_P3]));
  });

  it("projects.get and projects.list agree with the registry", async () => {
    const asG = projectsRouter.createCaller(callerFor(G));
    expect((await asG.get({ id: P })).project.id).toBe(P);
    expect(await codeOf(asG.get({ id: P3 }))).toBe("NOT_FOUND");
    const list = (await asG.list({})) as unknown as {
      items: Array<{ id: string }>;
    };
    expect(idsOf(list.items)).toEqual(new Set([P]));
  });
});

describe("T6 — an anonymous principal reads nothing", () => {
  it("no AccessContext without a userId", () => {
    expect(() => AccessContext.from({ userId: null })).toThrow();
    expect(() => AccessContext.from({ userId: undefined })).toThrow();
    expect(() => AccessContext.from({ userId: "" })).toThrow();
    expect(() =>
      AccessContext.from({ userId: null, isHubProtocol: true })
    ).toThrow();
  });

  it("an unknown id sees 0 rows of every data table; the owner sees each (non-vacuity)", async () => {
    for (const table of [
      entities,
      documents,
      views,
      projects,
      projectTracks,
      resourceShares,
      automations,
    ]) {
      expect((await seen(A, table)).size).toBeGreaterThan(0);
      expect((await seen(X, table)).size).toBe(0);
    }
  });
});

describe("revocation — deleting the exposure edge closes the document too", () => {
  it("after the visible_to edge is gone, the guest loses E and its body", async () => {
    await q(
      `delete from relations where type = 'visible_to' and source_entity_id = $1 and target_entity_id = $2`,
      [E, P]
    );
    expect((await seen(G, entities)).size).toBe(0);
    expect(await codeOf(loadReadableDocument(G, D))).toBe("NOT_FOUND");
  });
});
