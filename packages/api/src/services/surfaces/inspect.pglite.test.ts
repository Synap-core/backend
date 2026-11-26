/**
 * THE surface inspect (Surfaces P7), driven through the REAL Hub route
 * `GET /surfaces/inspect`, the REAL `inspectSurface` (surface load as the
 * caller, the read log query, the static lint) on PGlite with every
 * @synap/database table. Only the storage of a page's body is faked.
 *
 * Rows, each ruling out a wrong outcome:
 *  - a framed cell type: its logged reads are grouped into used / refused
 *    (FRAME_READ_UNDECLARED) / asked but undeclared / declared but unused;
 *    a row in a space the caller cannot read is NOT counted (rules out "the
 *    log is read unfloored"); a row older than the window is not counted;
 *  - a page: its reads, its hard-coded colour and its image without alt,
 *    each with its line;
 *  - a page whose body cannot be read: tokens and a11y are `unavailable`
 *    with the reason (rules out "a failed read is an empty pass");
 *  - a view: the cells it places; a built-in one is named as not logged,
 *    not silently dropped;
 *  - a built-in cell type alone: reads and lint `unavailable`, never `ok`
 *    with nothing in it;
 *  - render is always `unavailable` (no browser on the pod);
 *  - another person's page: 404; a markdown document: 400 (not a page).
 *
 * NOT COVERED: the tRPC twin `surfaces.inspect` and the MCP handler (thin
 * wrappers over the same `inspectSurface`), every lint rule (the unit test
 * `inspect-lint.test.ts`), and the grant fence (its classification
 * tripwire covers the route and the tool).
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
    bodies: new Map<string, string>(),
    async init(): Promise<unknown> {
      if (!state.db) {
        const { PGlite } = await import("@electric-sql/pglite");
        const { drizzle } = await import("drizzle-orm/pglite");
        const schema = await import("@synap/database/schema");
        const client = new PGlite();
        state.client = client as unknown as typeof state.client;
        const db = drizzle(client, { schema });
        (db as unknown as { transaction: unknown }).transaction = async (
          fn: (tx: unknown) => Promise<unknown>
        ) => fn(db);
        state.db = db;
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

vi.mock("../../../../database/dist/client-pg.js", () => h.clientPgModule());
vi.mock("../../../../database/src/client-pg.js", () => h.clientPgModule());
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const eventRepository = new Proxy(
    {},
    { get: () => async () => ({ id: globalThis.crypto.randomUUID() }) }
  );
  const db = await h.init();
  return { ...actual, db, getDb: async () => db, eventRepository };
});
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: vi.fn(async () => undefined),
  getBoss: () => ({ send: async () => randomUUID() }),
}));
vi.mock("@synap/jobs", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getBoss: () => ({ send: async () => undefined }),
}));
vi.mock("@synap/storage", () => ({
  storage: {
    downloadBuffer: vi.fn(async (key: string) => {
      const body = h.bodies.get(key);
      if (body === undefined) throw new Error(`no object at ${key}`);
      return Buffer.from(body, "utf-8");
    }),
  },
}));
vi.mock("../../utils/audit-log.js", () => ({
  auditLog: vi.fn(async () => null),
}));
vi.mock("../../utils/split-brain-service.js", () => ({
  isPodReadOnly: vi.fn().mockResolvedValue(false),
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { OpenAPIHono } from "@hono/zod-openapi";
import * as schema from "@synap/database/schema";
import { pgliteTableDdl } from "../../__tests__/pglite-ddl.js";
import { registerSurfacesRoutes } from "../../routers/hub-protocol/rest/surfaces.js";
import type {
  HubHono,
  HubVariables,
} from "../../routers/hub-protocol/rest/_shared.js";

const A = randomUUID(); // the caller
const B = randomUUID(); // another person
const WA = randomUUID(); // A's space
const WB = randomUUID(); // B's space, A is not a member
const PAGE = randomUUID(); // A's html page, declares entities.list
const BROKEN = randomUUID(); // A's html page whose body cannot be read
const B_PAGE = randomUUID(); // B's page
const NOTE = randomUUID(); // A's markdown document: not a page
const VIEW = randomUUID(); // A's bento placing a framed and a built-in cell

const RADAR = "cell:pkg:radar"; // framed, declares entities.list + views.list
const LIST = "entity-list"; // built-in
const DECLARED = [
  { op: "entities.list", params: { profileSlug: "deal" } },
  { op: "views.list" },
];

const PAGE_HTML = [
  "<!doctype html>",
  "<html><body>",
  '<h1 style="color: #ff0000">Deals</h1>',
  '<img src="data:image/png;base64,AA">',
  "</body></html>",
].join("\n");

const q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

async function inspect(query: Record<string, string>, asUser = A) {
  const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  app.use("*", async (c, next) => {
    c.set("userId", asUser);
    c.set("scopes", ["hub-protocol.read"]);
    await next();
  });
  registerSurfacesRoutes(app);
  const res = await app.request(
    `/surfaces/inspect?${new URLSearchParams(query).toString()}`
  );
  return { status: res.status, body: (await res.json()) as any };
}

async function log(
  surfaceKind: string,
  key: string,
  op: string,
  allowed: boolean,
  opts: { user?: string; ws?: string | null; daysAgo?: number } = {}
) {
  const at = new Date(Date.now() - (opts.daysAgo ?? 1) * 86_400_000);
  await q(
    `insert into frame_read_log (user_id, workspace_id, surface_kind, surface_key, op, params_hash, allowed, declared, at)
     values ($1,$2,$3,$4,$5,'h',$6,true,$7)`,
    [
      opts.user ?? A,
      opts.ws === undefined ? WA : opts.ws,
      surfaceKind,
      key,
      op,
      allowed,
      at.toISOString(),
    ]
  );
}

beforeAll(async () => {
  await h.init();
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(pgliteTableDdl(t));

  await q(
    `insert into users (id, email, user_type) values ($1, $2, 'human'), ($3, $4, 'human')`,
    [A, `${A}@x.test`, B, `${B}@x.test`]
  );
  await q(
    `insert into workspaces (id, name, owner_id, settings) values ($1,'A space',$2,'{}'::jsonb), ($3,'B space',$4,'{}'::jsonb)`,
    [WA, A, WB, B]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values
       (gen_random_uuid(), $1, $2, 'owner'), (gen_random_uuid(), $3, $4, 'owner')`,
    [WA, A, WB, B]
  );
  await q(
    `insert into widget_definitions (type_key, workspace_id, name, renderer_type, renderer_source, is_active, reads)
     values ($1, null, 'Radar', 'frame', $2, true, $3::jsonb),
            ($4, null, 'Entity list', 'builtin', null, true, null)`,
    [
      RADAR,
      [
        "export default function Radar() {",
        '  return <div style={{ backgroundColor: "#fafafa" }} />;',
        "}",
      ].join("\n"),
      JSON.stringify(DECLARED),
      LIST,
    ]
  );
  await q(
    `insert into documents (id, user_id, workspace_id, title, type, storage_url, storage_key, size, mime_type, metadata)
     values ($1,$2,$3,'Page','html','','k/page',$4,'text/html',$5::jsonb),
            ($6,$2,$3,'Broken','html','','k/missing',10,'text/html','{}'::jsonb),
            ($7,$8,$9,'B page','html','','k/b',10,'text/html','{}'::jsonb),
            ($10,$2,$3,'Notes','text','','k/note',10,'text/markdown','{}'::jsonb)`,
    [
      PAGE,
      A,
      WA,
      Buffer.byteLength(PAGE_HTML),
      JSON.stringify({ reads: [DECLARED[0]] }),
      BROKEN,
      B_PAGE,
      B,
      WB,
      NOTE,
    ]
  );
  h.bodies.set("k/page", PAGE_HTML);
  h.bodies.set("k/b", "<p>B</p>");
  await q(
    `insert into views (id, workspace_id, user_id, name, type, category, config)
     values ($1,$2,$3,'Deals board','bento','composed',$4::jsonb)`,
    [
      VIEW,
      WA,
      A,
      JSON.stringify({
        layout: "bento",
        blocks: [
          { id: "b1", kind: "cell", cellKey: RADAR },
          { id: "b2", kind: "widget", widgetType: LIST },
        ],
      }),
    ]
  );

  // The radar in A's space: two answered reads, one refused.
  await log("cell", RADAR, "entities.list", true);
  await log("cell", RADAR, "entities.list", true);
  await log("cell", RADAR, "documents.get", false);
  // In B's space, which A cannot read: never shown to A.
  await log("cell", RADAR, "relations.list", true, { user: B, ws: WB });
  // Older than the window.
  await log("cell", RADAR, "sessions.list", true, { daysAgo: 45 });
  // The page, in its own space.
  await log("document", PAGE, "entities.list", true);
}, 120_000);

describe("GET /surfaces/inspect", () => {
  it("a framed cell type: reads grouped, floored to the caller's spaces, windowed", async () => {
    const { status, body } = await inspect({ kind: "cell", typeKey: RADAR });
    expect(status).toBe(200);
    expect(body.surface).toMatchObject({ kind: "cell", typeKey: RADAR });
    expect(body.reads.status).toBe("ok");
    expect(body.reads.days).toBe(30);
    expect(body.reads.surfaces).toHaveLength(1);
    const r = body.reads.surfaces[0];
    expect(r).toMatchObject({ surfaceKind: "cell", key: RADAR });
    expect(r.declared.map((d: any) => d.op)).toEqual([
      "entities.list",
      "views.list",
    ]);
    expect(r.used.map((u: any) => [u.op, u.count])).toEqual([
      ["entities.list", 2],
    ]);
    expect(r.refused.map((u: any) => [u.op, u.count, u.code])).toEqual([
      ["documents.get", 1, "FRAME_READ_UNDECLARED"],
    ]);
    expect(r.usedUndeclared).toEqual(["documents.get"]);
    expect(r.declaredUnused).toEqual(["views.list"]);
    // B's space and the 45-day-old row are not counted.
    const ops = [...r.used, ...r.refused].map((u: any) => u.op);
    expect(ops).not.toContain("relations.list");
    expect(ops).not.toContain("sessions.list");

    // Its module source: the colour found; a11y reads HTML only, says so.
    expect(body.tokens.status).toBe("ok");
    expect(body.tokens.findings).toEqual([
      expect.objectContaining({
        source: `cell:${RADAR} rendererSource`,
        line: 2,
        found: "#fafafa",
        suggestion: "var(--synap-background)",
      }),
    ]);
    expect(body.a11y.status).toBe("unavailable");
    expect(body.a11y.reason).toContain("HTML only");
    expect(body.render).toEqual({
      status: "unavailable",
      reason: expect.stringContaining("no headless renderer on the pod"),
    });
  });

  it("an html page: its reads, its hard-coded colour and its image without alt", async () => {
    const { status, body } = await inspect({ kind: "document", id: PAGE });
    expect(status).toBe(200);
    expect(body.surface).toMatchObject({ kind: "document", id: PAGE });
    expect(body.reads.surfaces[0]).toMatchObject({
      surfaceKind: "document",
      key: PAGE,
      declaredUnused: [],
      usedUndeclared: [],
    });
    expect(body.reads.surfaces[0].used[0]).toMatchObject({
      op: "entities.list",
      count: 1,
    });
    expect(body.tokens.findings).toEqual([
      expect.objectContaining({
        line: 3,
        found: "#ff0000",
        suggestion: "var(--synap-color)",
      }),
    ]);
    expect(body.a11y.status).toBe("ok");
    expect(body.a11y.findings).toEqual([
      expect.objectContaining({ line: 4, rule: "img-alt" }),
    ]);
  });

  it("a page whose body cannot be read: lint unavailable with the reason, never an empty pass", async () => {
    const { status, body } = await inspect({ kind: "document", id: BROKEN });
    expect(status).toBe(200);
    expect(body.tokens).toEqual({
      status: "unavailable",
      reason: expect.stringContaining("could not be read"),
    });
    expect(body.a11y.status).toBe("unavailable");
    expect(body.tokens.findings).toBeUndefined();
  });

  it("a view: the cells it places; a built-in one is named as not logged", async () => {
    const { status, body } = await inspect({ kind: "view", id: VIEW });
    expect(status).toBe(200);
    expect(body.surface.cellKeys).toEqual([RADAR, LIST]);
    expect(body.reads.status).toBe("ok");
    expect(body.reads.surfaces.map((s: any) => s.key)).toEqual([RADAR]);
    expect(body.reads.notLogged).toEqual([
      { key: LIST, reason: expect.stringContaining("built-in") },
    ]);
    expect(body.tokens.status).toBe("ok");
    expect(body.tokens.notLinted).toEqual(
      expect.arrayContaining([
        { source: `cell:${LIST}`, reason: expect.stringContaining("built-in") },
      ])
    );
  });

  it("a built-in cell type alone: every check unavailable, never ok with nothing in it", async () => {
    const { status, body } = await inspect({ kind: "cell", typeKey: LIST });
    expect(status).toBe(200);
    expect(body.reads.status).toBe("unavailable");
    expect(body.tokens.status).toBe("unavailable");
    expect(body.a11y.status).toBe("unavailable");
  });

  it("another person's page is a 404; a markdown document is a 400; no id is a 400", async () => {
    expect((await inspect({ kind: "document", id: B_PAGE })).status).toBe(404);
    expect((await inspect({ kind: "document", id: NOTE })).status).toBe(400);
    expect((await inspect({ kind: "view" })).status).toBe(400);
    // B sees their own page.
    expect((await inspect({ kind: "document", id: B_PAGE }, B)).status).toBe(
      200
    );
  });
});
