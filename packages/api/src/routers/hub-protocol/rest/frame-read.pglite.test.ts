/**
 * THE frame read door enforces declared reads on the SERVER (Surfaces P6a).
 *
 * Driven through the REAL Hub route `POST /frame/read`, the REAL `frameRead`
 * (surface load, declaration check, log), and the REAL read procedures it
 * runs (`entities.list` as the viewer), on PGlite with every @synap/database
 * table. Nothing between the request and the answer is hand-built.
 *
 * Rows, each ruling out a wrong outcome:
 *  - a cell declaring `entities.list {profileSlug:"deal"}` asking
 *    `documents.get`: 403 FRAME_READ_UNDECLARED, logged allowed=false
 *    declared=true (rules out "the server answers whatever the host asks");
 *  - the same cell asking `entities.list` of ANOTHER kind: 403 (rules out "an
 *    op match is enough, params are ignored");
 *  - the declared read: answered, as the viewer: a deal the viewer cannot see
 *    (another person's space) is NOT returned (rules out "the door reads with
 *    more than the viewer's access"), logged allowed=true;
 *  - an html page declaring reads in `metadata.reads`: enforced the same,
 *    logged as a `document` surface; read in the page's own space;
 *  - an html-embed cell's source (a `text` document with mime `text/html`,
 *    as `createHtmlCell` stores it): read as a page, in its own space (rules
 *    out "an html-embed frame 404s"); a markdown or plain-text document is
 *    still not a page: 404 (rules out "any text document is a page");
 *  - a cell that declares nothing: answered, logged declared=false (the
 *    backward-compatible default, rules out "undeclared = refused");
 *  - a person's own unsaved draft (`{kind:"draft", draftId}`, a preview):
 *    answered with that person's access in the host's lens, logged
 *    surface_kind "draft" declared=false (rules out "a draft reads nothing"
 *    and "a draft reads more than its person"); another person naming the
 *    same draft id: 403 FRAME_DRAFT_NOT_YOURS, logged refused, and the owner
 *    still reads (rules out "a draft id is anyone's" and "a refused claim
 *    steals it"); a draft in a space the viewer cannot read: 403;
 *  - an op outside the ceiling: 400; an unknown cell or a page the viewer
 *    cannot read: 404, nothing answered.
 *
 * NOT COVERED: the tRPC twin `surfaces.frameRead` (a thin wrapper over the
 * same `frameRead`), every op of the table (only `entities.list` runs; the
 * others are the same mapping as pod admin's `readForPage`), and the grant
 * fence (its classification tripwire covers the route).
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

vi.mock("../../../../../database/dist/client-pg.js", () => h.clientPgModule());
vi.mock("../../../../../database/src/client-pg.js", () => h.clientPgModule());
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
vi.mock("@synap/storage", () => ({ storage: {} }));
vi.mock("../../../utils/audit-log.js", () => ({
  auditLog: vi.fn(async () => null),
}));
vi.mock("../../../utils/split-brain-service.js", () => ({
  isPodReadOnly: vi.fn().mockResolvedValue(false),
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { OpenAPIHono } from "@hono/zod-openapi";
import * as schema from "@synap/database/schema";
import { pgliteTableDdl } from "../../../__tests__/pglite-ddl.js";
import { registerFrameReadRoutes } from "./frame-read.js";
import type { HubHono, HubVariables } from "./_shared.js";

const A = randomUUID(); // the viewer
const B = randomUUID(); // another person
const WA = randomUUID(); // A's space
const WB = randomUUID(); // B's space, A is not a member
const DEAL = randomUUID(); // kind
const PERSON = randomUUID(); // kind
const D_A = randomUUID(); // a deal A sees
const D_B = randomUUID(); // a deal only B sees
const P_A = randomUUID(); // a person A sees
const PAGE = randomUUID(); // A's html page, declares its reads
const B_PAGE = randomUUID(); // B's html page, A cannot read it
const EMBED = randomUUID(); // A's html-embed source: text + text/html
const NOTE = randomUUID(); // A's markdown document: not a page
const PLAIN = randomUUID(); // A's plain-text document: not a page

const DECLARED = [{ op: "entities.list", params: { profileSlug: "deal" } }];

const q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

function read(body: unknown, asUser = A) {
  const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  app.use("*", async (c, next) => {
    c.set("userId", asUser);
    c.set("scopes", ["hub-protocol.read"]);
    await next();
  });
  registerFrameReadRoutes(app);
  return app.request("/frame/read", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function lastLog() {
  const { rows } = await q<{
    surface_kind: string;
    surface_key: string;
    op: string;
    allowed: boolean;
    declared: boolean;
    user_id: string;
    workspace_id: string | null;
    params_hash: string;
  }>(`select * from frame_read_log order by at desc, ctid desc limit 1`);
  return rows[0];
}
const logCount = async () =>
  (await q<{ n: number }>(`select count(*)::int as n from frame_read_log`))
    .rows[0]!.n;

function idsOf(answer: unknown): string[] {
  const list = Array.isArray(answer)
    ? answer
    : ((answer as { items?: unknown[]; entities?: unknown[] }).items ??
      (answer as { entities?: unknown[] }).entities ??
      []);
  return (list as Array<{ id: string }>).map((r) => r.id);
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
    `insert into profiles (id, slug, display_name, profile_kind, scope, entity_scope, is_active, ui_hints, workspace_id)
     values ($1,'deal','Deal','kind','system','workspace',true,'{}'::jsonb,null),
            ($2,'person','Person','kind','system','workspace',true,'{}'::jsonb,null)`,
    [DEAL, PERSON]
  );
  for (const [id, owner, ws, profile, type] of [
    [D_A, A, WA, DEAL, "deal"],
    [D_B, B, WB, DEAL, "deal"],
    [P_A, A, WA, PERSON, "person"],
  ] as const) {
    await q(
      `insert into entities (id, user_id, workspace_id, profile_id, type, title, properties, system_data)
       values ($1,$2,$3,$4,$5,'Row','{}'::jsonb,'{}'::jsonb)`,
      [id, owner, ws, profile, type]
    );
  }
  // Two pod-wide cell types: one declares its reads, one declares nothing.
  await q(
    `insert into widget_definitions (type_key, workspace_id, name, renderer_type, renderer_source, is_active, reads)
     values ('cell:pkg:declared', null, 'Declared', 'frame', 'export default () => null', true, $1::jsonb),
            ('cell:pkg:open', null, 'Open', 'frame', 'export default () => null', true, null)`,
    [JSON.stringify(DECLARED)]
  );
  // A's html page in A's space, declaring the same read; B's page.
  await q(
    `insert into documents (id, user_id, workspace_id, title, type, storage_url, storage_key, size, mime_type, metadata)
     values ($1,$2,$3,'Page','html','','',0,'text/html',$4::jsonb),
            ($5,$6,$7,'B page','html','','',0,'text/html','{}'::jsonb)`,
    [PAGE, A, WA, JSON.stringify({ reads: DECLARED }), B_PAGE, B, WB]
  );
  // A's html-embed source, as `cellInstances.createHtmlCell` stores it, and
  // two text documents that are not pages.
  await q(
    `insert into documents (id, user_id, workspace_id, title, type, storage_url, storage_key, size, mime_type, metadata)
     values ($1,$2,$3,'HTML Cell','text','','',0,'text/html','{}'::jsonb),
            ($4,$2,$3,'Notes','text','','',0,'text/markdown','{}'::jsonb),
            ($5,$2,$3,'Plain','text','','',0,'text/plain','{}'::jsonb)`,
    [EMBED, A, WA, NOTE, PLAIN]
  );
}, 120_000);

describe("a cell that declares its reads", () => {
  const surface = { kind: "cell", typeKey: "cell:pkg:declared" };

  it("an undeclared op (documents.get): 403 FRAME_READ_UNDECLARED, logged refused", async () => {
    const res = await read({
      surface,
      op: "documents.get",
      params: { documentId: PAGE },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "FRAME_READ_UNDECLARED" });
    expect(await lastLog()).toMatchObject({
      surface_kind: "cell",
      surface_key: "cell:pkg:declared",
      op: "documents.get",
      allowed: false,
      declared: true,
      user_id: A,
    });
  });

  it("the declared op with another pinned value: 403", async () => {
    const res = await read({
      surface,
      op: "entities.list",
      params: { profileSlug: "person" },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "FRAME_READ_UNDECLARED" });
    expect(await lastLog()).toMatchObject({ allowed: false, declared: true });
  });

  it("the declared read: answered as the viewer (another person's deal is not returned), logged allowed", async () => {
    const res = await read({
      surface,
      op: "entities.list",
      params: { profileSlug: "deal", limit: 50 },
    });
    expect(res.status).toBe(200);
    const ids = idsOf(await res.json());
    expect(ids).toContain(D_A);
    expect(ids).not.toContain(D_B);
    expect(ids).not.toContain(P_A);
    expect(await lastLog()).toMatchObject({
      op: "entities.list",
      allowed: true,
      declared: true,
    });
  });
});

describe("an html page that declares its reads (documents.metadata.reads)", () => {
  const surface = { kind: "document", id: PAGE };

  it("an undeclared op: 403, logged as a document surface", async () => {
    const res = await read({
      surface,
      op: "documents.get",
      params: { documentId: PAGE },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "FRAME_READ_UNDECLARED" });
    expect(await lastLog()).toMatchObject({
      surface_kind: "document",
      surface_key: PAGE,
      allowed: false,
      declared: true,
      workspace_id: WA,
    });
  });

  it("the declared read: answered in the page's own space, whatever lens the host names", async () => {
    const res = await read({
      surface,
      op: "entities.list",
      params: { profileSlug: "deal" },
      workspaceId: WB,
    });
    expect(res.status).toBe(200);
    expect(idsOf(await res.json())).toEqual([D_A]);
    expect(await lastLog()).toMatchObject({
      surface_kind: "document",
      allowed: true,
      workspace_id: WA,
    });
  });

  it("a page the viewer cannot read: 404, nothing logged", async () => {
    const before = await logCount();
    const res = await read({
      surface: { kind: "document", id: B_PAGE },
      op: "entities.list",
      params: { profileSlug: "deal" },
    });
    expect(res.status).toBe(404);
    expect(await logCount()).toBe(before);
  });
});

describe("an html-embed cell's source document (text, mime text/html)", () => {
  it("reads as a page: answered in its own space, logged as a document surface", async () => {
    const res = await read({
      surface: { kind: "document", id: EMBED },
      op: "entities.list",
      params: { profileSlug: "deal" },
      workspaceId: WB,
    });
    expect(res.status).toBe(200);
    expect(idsOf(await res.json())).toEqual([D_A]);
    expect(await lastLog()).toMatchObject({
      surface_kind: "document",
      surface_key: EMBED,
      allowed: true,
      declared: false,
      workspace_id: WA,
    });
  });

  it("a markdown or plain-text document is not a page: 404, nothing logged", async () => {
    for (const id of [NOTE, PLAIN]) {
      const before = await logCount();
      const res = await read({
        surface: { kind: "document", id },
        op: "entities.list",
        params: { profileSlug: "deal" },
      });
      expect(res.status, id).toBe(404);
      expect(await logCount()).toBe(before);
    }
  });
});

describe("a cell that declares nothing (the default, founder-overridable)", () => {
  it("answered, logged declared=false", async () => {
    const res = await read({
      surface: { kind: "cell", typeKey: "cell:pkg:open" },
      op: "entities.list",
      params: { profileSlug: "person" },
    });
    expect(res.status).toBe(200);
    expect(idsOf(await res.json())).toEqual([P_A]);
    expect(await lastLog()).toMatchObject({
      surface_key: "cell:pkg:open",
      allowed: true,
      declared: false,
    });
  });
});

describe("a person's own unsaved draft (a preview)", () => {
  const DRAFT = randomUUID();
  const surface = { kind: "draft", draftId: DRAFT };

  it("answered with the person's access in the host's lens, logged as a draft", async () => {
    const res = await read({
      surface,
      op: "entities.list",
      params: { profileSlug: "deal" },
      workspaceId: WA,
    });
    expect(res.status).toBe(200);
    const ids = idsOf(await res.json());
    expect(ids).toEqual([D_A]);
    expect(await lastLog()).toMatchObject({
      surface_kind: "draft",
      surface_key: DRAFT,
      op: "entities.list",
      allowed: true,
      declared: false,
      user_id: A,
      workspace_id: WA,
    });
  });

  it("another person naming the same draft: 403 FRAME_DRAFT_NOT_YOURS, logged refused", async () => {
    const res = await read(
      { surface, op: "entities.list", params: { profileSlug: "deal" } },
      B
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "FRAME_DRAFT_NOT_YOURS" });
    expect(await lastLog()).toMatchObject({
      surface_kind: "draft",
      surface_key: DRAFT,
      allowed: false,
      declared: false,
      user_id: B,
    });
  });

  it("the refused claim does not take it: its person still reads", async () => {
    const res = await read({
      surface,
      op: "entities.list",
      params: { profileSlug: "person" },
      workspaceId: WA,
    });
    expect(res.status).toBe(200);
    expect(idsOf(await res.json())).toEqual([P_A]);
  });

  it("a draft read in a space the viewer cannot read: 403", async () => {
    const res = await read({
      surface: { kind: "draft", draftId: randomUUID() },
      op: "entities.list",
      workspaceId: WB,
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "FRAME_SPACE_FORBIDDEN" });
  });
});

describe("refusals before any read", () => {
  it("an op outside the ceiling: 400", async () => {
    const res = await read({
      surface: { kind: "cell", typeKey: "cell:pkg:open" },
      op: "users.list",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "FRAME_READ_UNKNOWN_OP" });
  });

  it("an unknown cell: 404", async () => {
    const res = await read({
      surface: { kind: "cell", typeKey: "cell:pkg:nope" },
      op: "entities.list",
    });
    expect(res.status).toBe(404);
  });

  it("a cell read in a space the viewer cannot read: 403", async () => {
    const res = await read({
      surface: { kind: "cell", typeKey: "cell:pkg:open" },
      op: "entities.list",
      workspaceId: WB,
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "FRAME_SPACE_FORBIDDEN" });
  });
});
