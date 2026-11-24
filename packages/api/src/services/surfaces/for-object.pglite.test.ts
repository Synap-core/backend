/**
 * `surfaces.forObject` (Surfaces P1) on PGlite, through the REAL tRPC
 * procedure, the real access floors (`scopedDb` rules for views, documents,
 * artifacts, relations, cell instances, Sites; `userVisibleWhere` for spaces)
 * and the real renderer ladder (`readBoundRenderer` over `renderer_bindings`).
 *
 *   W   — Alice owns it, Bob is a member. Project P lives in W.
 *   W2  — Bob's alone; Alice has no role there.
 *
 * One test per source (a project-pinned view, a co-worker's view in a shared
 * space, an exposed view, a session output, an entity body, a renderer
 * binding for a kind, a start page, a cell linked to an entity), the visible
 * floor (Bob's view in W2 never shows to Alice; the same floor on hub
 * `listViews`, which `synap_list_views` and `GET /views` call), a missing anchor (NOT_FOUND,
 * never an empty list) and a store that fails (named in `unavailable` while
 * the others still answer).
 *
 * Stubbed: `db`/`getDb` → a PGlite drizzle over every schema table; the event
 * repository (no-op). Not seen: production Postgres constraints, Typesense.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
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
  const noop = new Proxy(
    {},
    { get: (_t, k) => (k === "then" ? undefined : async () => undefined) }
  );
  return { ...actual, db, getDb: async () => db, eventRepository: noop };
});

import { pgliteAllTablesDdl } from "../../__tests__/pglite-ddl.js";
import { surfacesRouter } from "../../routers/surfaces.js";
import { hubViewsRouter } from "../../routers/hub-protocol/views.js";

const ALICE = randomUUID();
const BOB = randomUUID();
const W = randomUUID();
const W2 = randomUUID();
const P = randomUUID();
const V_PIN = randomUUID(); // Bob's, in W, pinned to P
const V_EXPOSED = randomUUID(); // Bob's, in W, exposed to P
const V_HIDDEN = randomUUID(); // Bob's, in W2, pinned to P: Alice cannot see it
const V_HOME = randomUUID(); // W's home bento
const S = randomUUID(); // Alice's session
const D_OUT = randomUUID(); // the session's output document (html)
const E = randomUUID(); // Alice's task
const D_BODY = randomUUID(); // E's body
const CELL = randomUUID(); // a cell instance linked to E

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const forObject = (input: {
  kind:
    | "entity"
    | "profile"
    | "workspace"
    | "project"
    | "track"
    | "playbook"
    | "session";
  id: string;
  workspaceId?: string;
}) =>
  surfacesRouter
    .createCaller({
      authenticated: true,
      userId: ALICE,
      workspaceId: null,
    } as never)
    .forObject(input);

beforeAll(async () => {
  await h.client!.exec(pgliteAllTablesDdl());
  await q(
    `insert into workspaces (id, name, owner_id, settings) values ($1,'W',$2,$3::jsonb), ($4,'W2',$5,'{}'::jsonb)`,
    [
      W,
      ALICE,
      JSON.stringify({
        layout: {
          primarySurface: { kind: "cell", cellKey: "home-cell", title: "Home" },
        },
      }),
      W2,
      BOB,
    ]
  );
  await q(
    `insert into workspace_members (workspace_id, user_id, role) values ($1,$2,'owner'), ($1,$3,'editor'), ($4,$3,'owner')`,
    [W, ALICE, BOB, W2]
  );
  await q(
    `insert into projects (id, user_id, workspace_id, name) values ($1,$2,$3,'P')`,
    [P, ALICE, W]
  );
  const view = (
    id: string,
    ws: string,
    owner: string,
    type: string,
    projectId: string | null,
    exposed: boolean,
    metadata: Record<string, unknown> = {}
  ) =>
    q(
      `insert into views (id, workspace_id, user_id, project_id, exposed_at, name, type, category, metadata)
       values ($1,$2,$3,$4,$5,$6,$7,'structured',$8::jsonb)`,
      [
        id,
        ws,
        owner,
        projectId,
        exposed ? new Date().toISOString() : null,
        `view ${type}`,
        type,
        JSON.stringify(metadata),
      ]
    );
  await view(V_PIN, W, BOB, "kanban", P, false);
  await view(V_EXPOSED, W, BOB, "table", P, true);
  await view(V_HIDDEN, W2, BOB, "table", P, false);
  await view(V_HOME, W, ALICE, "bento", null, false, {
    homeScope: "workspace",
  });

  await q(
    `insert into focus_sessions (id, user_id, goal, status) values ($1,$2,'ship','active')`,
    [S, ALICE]
  );
  await q(
    `insert into documents (id, user_id, workspace_id, title, type) values ($1,$2,null,'Deck','html'), ($3,$2,$4,'Spec','markdown')`,
    [D_OUT, ALICE, D_BODY, W]
  );
  await q(
    `insert into artifacts (id, user_id, workspace_id, kind, ref_id, title, session_id) values ($1,$2,null,'document',$3,'Deck',$4)`,
    [randomUUID(), ALICE, D_OUT, S]
  );

  await q(
    `insert into entities (id, user_id, workspace_id, type, title, document_id) values ($1,$2,$3,'task','Fix it',$4)`,
    [E, ALICE, W, D_BODY]
  );
  await q(
    `insert into renderer_bindings (id, scope_kind, subject_kind, content_kind, surface, ref, created_by)
     values ($1,'pod','task','entity-card','app',$2::jsonb,$3)`,
    [
      randomUUID(),
      JSON.stringify({ kind: "cell", cellKey: "task-card" }),
      ALICE,
    ]
  );
  await q(
    `insert into cell_instances (id, workspace_id, user_id, cell_type, name, config) values ($1,$2,$3,'note','Notes','{}'::jsonb)`,
    [CELL, W, ALICE]
  );
  await q(
    `insert into relations (id, user_id, workspace_id, source_kind, target_kind, source_cell_id, target_entity_id, type)
     values ($1,$2,$3,'cell','entity',$4,$5,'references')`,
    [randomUUID(), ALICE, W, CELL, E]
  );
});

describe("surfaces.forObject", () => {
  it("project: a co-worker's pinned view and an exposed view, never a view in a space you cannot see", async () => {
    const { rows, unavailable } = await forObject({ kind: "project", id: P });
    expect(unavailable).toEqual([]);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(V_PIN)).toMatchObject({
      body: "view",
      viewType: "kanban",
      relation: "pinned",
      anchor: { kind: "project", id: P },
      openUrl: `/open/${V_PIN}`,
      source: "views",
    });
    expect(byId.get(V_EXPOSED)?.relation).toBe("exposed");
    expect(byId.has(V_HIDDEN)).toBe(false);
  });

  it("session: what it produced (an HTML artifact, read-only)", async () => {
    const { rows, unavailable } = await forObject({ kind: "session", id: S });
    expect(unavailable).toEqual([]);
    expect(rows).toEqual([
      expect.objectContaining({
        id: D_OUT,
        body: "html",
        relation: "session-output",
        readOnly: true,
        source: "session-outputs",
      }),
    ]);
  });

  it("entity: its body, its kind's renderer binding, a linked cell", async () => {
    const { rows, unavailable } = await forObject({ kind: "entity", id: E });
    expect(unavailable).toEqual([]);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: D_BODY,
          body: "document",
          relation: "body",
        }),
        expect.objectContaining({
          body: "cell",
          relation: "renders",
          cellKey: "task-card",
          slot: "card",
          source: "renderer:pod",
        }),
        expect.objectContaining({
          id: CELL,
          body: "cell",
          relation: "attached",
          cellKey: "note",
        }),
      ])
    );
  });

  it("workspace: its home bento and its start page", async () => {
    const { rows, unavailable } = await forObject({ kind: "workspace", id: W });
    expect(unavailable).toEqual([]);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: V_HOME,
          body: "bento",
          relation: "home",
        }),
        expect.objectContaining({
          id: "home-cell",
          body: "cell",
          relation: "home",
          source: "start-page",
        }),
      ])
    );
  });

  it("an object you cannot see is NOT_FOUND, never an empty list", async () => {
    await expect(
      forObject({ kind: "workspace", id: W2 })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("hub listViews (synap_list_views, GET /views): the VISIBLE floor, narrowed by project", async () => {
    const caller = hubViewsRouter.createCaller({
      authenticated: true,
      userId: ALICE,
      apiKeyId: randomUUID(),
      scopes: ["hub-protocol.read"],
    } as never);
    const all = (await caller.listViews({ userId: ALICE })) as Array<{
      id: string;
    }>;
    const ids = all.map((v) => v.id);
    // Bob's views in the space Alice shares with him: found.
    expect(ids).toEqual(expect.arrayContaining([V_PIN, V_EXPOSED, V_HOME]));
    // Bob's view in a space Alice is not in: never.
    expect(ids).not.toContain(V_HIDDEN);
    const inP = (await caller.listViews({
      userId: ALICE,
      projectId: P,
    })) as Array<{ id: string }>;
    expect(inP.map((v) => v.id).sort()).toEqual([V_EXPOSED, V_PIN].sort());
  });

  // Last: it drops a table.
  it("a store that fails is named in `unavailable`; the others still answer", async () => {
    await q(`drop table resource_shares`);
    const { rows, unavailable } = await forObject({ kind: "project", id: P });
    expect(unavailable.map((u) => u.source)).toEqual(["sites"]);
    expect(unavailable[0]!.error.length).toBeGreaterThan(0);
    expect(rows.map((r) => r.id)).toEqual(
      expect.arrayContaining([V_PIN, V_EXPOSED])
    );
  });
});
