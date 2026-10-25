/**
 * 2d828af5 — a Hub write route needs the WRITE role in the space, not just a
 * membership row. Through the REAL hub auth door and the REAL routes, on
 * PGlite: a VIEWER's key gets 403 on every route that used to gate on
 * `verifyWorkspaceAccess` (any role); an EDITOR's key gets past that gate.
 *
 * Stubbed: the key lookup, the guest check, the storage/presign seams and the
 * governed file builders (recorded, so the JSON `/files` mode is proven to
 * reach the GOVERNED builder, never the direct `uploadBufferAsFileEntity`),
 * the whiteboard socket emit and the governance gate (granted). An editor's
 * request is asserted only to clear the role gate (`status !== 403`): what
 * the route does next is covered by its own tests.
 *
 * Cannot see: production Postgres, the real object store, the real
 * governance decision for an editor.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  getApiKeyStatus: vi.fn(),
  governed: [] as Array<Record<string, unknown>>,
  direct: [] as Array<Record<string, unknown>>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const schema = await import("@synap/database/schema");
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema });
  return { ...actual, db, getDb: async () => db };
});
vi.mock("../../create-governed-file-entity.js", async (importOriginal) => {
  const created = (p: Record<string, unknown>) => {
    h.governed.push(p);
    return {
      status: "created",
      fileEntityId: randomUUID(),
      documentId: randomUUID(),
    };
  };
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    createGovernedFileEntityFromBuffer: async (p: Record<string, unknown>) =>
      created(p),
    createGovernedFileEntityForStoredDocument: async (
      _s: unknown,
      p: Record<string, unknown>
    ) => created(p),
  };
});
vi.mock("../../file-upload.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  uploadBufferAsFileEntity: async (p: Record<string, unknown>) => {
    h.direct.push(p);
    return { entity: { id: randomUUID() }, document: { id: randomUUID() } };
  },
}));
vi.mock("../../file-upload-presign.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requestPresignedUpload: async () => ({
    ok: true,
    uploadUrl: "https://s3.test/put",
    method: "PUT",
    headers: { "Content-Type": "image/png" },
    uploadToken: "t",
    expiresAt: new Date().toISOString(),
    maxBytes: 1,
  }),
  storeDocumentFromPresignedUpload: async () => ({
    ok: true,
    stored: {},
    mimeType: "image/png",
    filename: "a.png",
    workspaceId: WS,
  }),
}));
vi.mock(
  "../../../services/capabilities/place-artboard-deck.js",
  async (io) => ({
    ...(await io<Record<string, unknown>>()),
    emitBoardPlace: vi.fn(),
  })
);
vi.mock("../../../utils/permission-check.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  checkPermissionOrPropose: async () => ({ granted: true }),
}));
vi.mock("../../../access/guest-containment.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isGuestPrincipal: vi.fn(async () => false),
}));
vi.mock("../../../services/api-keys.js", () => ({
  apiKeyService: {
    getApiKeyStatus: (...a: unknown[]) => h.getApiKeyStatus(...a),
    recordKeyUse: vi.fn(),
    checkRateLimit: () => true,
  },
}));
vi.mock("../../../services/external-user-mapping.js", () => ({
  isSubTokenFeatureEnabled: () => false,
  resolveExternalUserMapping: vi.fn(),
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import "../../../access/grant-read.js";
import { hubAuthMiddleware } from "../_middleware/auth.js";
import { registerEntitiesRoutes } from "./entities.js";
import { registerCellsRoutes } from "./cells.js";
import { registerWhiteboardsRoutes } from "./whiteboards.js";
import type { HubHono, HubVariables } from "./_shared.js";

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
        : c.name === "is_active"
          ? " default true"
          : "";
    return `"${c.name}" ${type}${pk}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const OWNER = randomUUID(); // owns the space
const VIEWER = randomUUID();
const EDITOR = randomUUID();
const WS = randomUUID();
const BOARD = randomUUID();
const TARGET = randomUUID(); // an entity in WS, readable by both members
const KEYS = { viewer: randomUUID(), editor: randomUUID() } as const;
type Who = keyof typeof KEYS;
const USER: Record<Who, string> = { viewer: VIEWER, editor: EDITOR };

const q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));

  for (const u of [OWNER, VIEWER, EDITOR]) {
    await q(`insert into users (id, email, user_type) values ($1,$2,'human')`, [
      u,
      `${u}@example.test`,
    ]);
  }
  await q(
    `insert into workspaces (id, name, owner_id, settings) values ($1,'W',$2,'{}'::jsonb)`,
    [WS, OWNER]
  );
  for (const [u, role] of [
    [OWNER, "owner"],
    [VIEWER, "viewer"],
    [EDITOR, "editor"],
  ] as const) {
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,$4)`,
      [randomUUID(), WS, u, role]
    );
  }
  await q(
    `insert into entities (id, user_id, workspace_id, type, title, properties, system_data)
     values ($1,$2,$3,'note','t','{}'::jsonb,'{}'::jsonb)`,
    [TARGET, OWNER, WS]
  );
  for (const who of ["viewer", "editor"] as const) {
    await q(
      `insert into grants (id, api_key_id, principal_user_id, on_behalf_of, permissions, created_by)
       values ($1,$2,$3,$3,'{*}'::text[],$3)`,
      [randomUUID(), KEYS[who], USER[who]]
    );
  }
}, 120_000);

beforeEach(() => {
  h.governed = [];
  h.direct = [];
  h.getApiKeyStatus.mockImplementation(async (bearer: string) => {
    const who = bearer.replace(/^synap_/, "") as Who;
    return {
      status: "valid",
      record: {
        id: KEYS[who],
        userId: USER[who],
        linkedUserId: null,
        parentKeyId: null,
        scope: ["hub-protocol.read", "hub-protocol.write"],
        keyType: "hub_inbound",
        workspaceId: null,
        expiresAt: null,
      },
    };
  });
});

function app() {
  const hub: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  hub.use("/*", hubAuthMiddleware as never);
  registerEntitiesRoutes(hub);
  registerCellsRoutes(hub);
  registerWhiteboardsRoutes(hub);
  const root = new Hono();
  root.route("/api/hub", hub);
  return root;
}

const png = Buffer.from("png-bytes").toString("base64");
const placement = {
  workspaceId: WS,
  resources: [{ kind: "entity", entityId: randomUUID() }],
};

/** Every Hub write route that gated on membership alone (2d828af5). */
const WRITES: Array<{
  name: string;
  method: string;
  path: string;
  body?: () => BodyInit;
  json?: boolean;
}> = [
  {
    name: "POST /files (JSON)",
    method: "POST",
    path: "/files",
    json: true,
    body: () =>
      JSON.stringify({
        workspaceId: WS,
        filename: "a.png",
        mimeType: "image/png",
        contentBase64: png,
      }),
  },
  {
    name: "POST /files (multipart)",
    method: "POST",
    path: "/files",
    body: () => {
      const form = new FormData();
      form.set("file", new File(["png-bytes"], "a.png", { type: "image/png" }));
      form.set("workspaceId", WS);
      return form;
    },
  },
  {
    name: "POST /files/uploads",
    method: "POST",
    path: "/files/uploads",
    json: true,
    body: () =>
      JSON.stringify({
        workspaceId: WS,
        filename: "a.png",
        mimeType: "image/png",
        size: 9,
      }),
  },
  {
    name: "POST /files/uploads/finalize",
    method: "POST",
    path: "/files/uploads/finalize",
    json: true,
    body: () =>
      JSON.stringify({
        uploadToken: `files/${WS}/uploads/u/${randomUUID()}/a.png`,
      }),
  },
  {
    name: "POST /entities/{id}/attachments",
    method: "POST",
    path: `/entities/${TARGET}/attachments`,
    json: true,
    body: () =>
      JSON.stringify({
        filename: "a.png",
        mimeType: "image/png",
        contentBase64: png,
      }),
  },
  {
    name: "POST /cells/install",
    method: "POST",
    path: "/cells/install",
    json: true,
    body: () =>
      JSON.stringify({ packageSlug: "p", cellKey: "c", workspaceId: WS }),
  },
  {
    name: "POST /cells/define",
    method: "POST",
    path: "/cells/define",
    json: true,
    body: () =>
      JSON.stringify({
        name: "My cell",
        rendererSource: "export default () => null",
        workspaceId: WS,
      }),
  },
  {
    name: "DELETE /cells/{typeKey}",
    method: "DELETE",
    path: `/cells/my-cell?workspaceId=${WS}`,
  },
  {
    name: "POST /whiteboards/{id}/placements/propose",
    method: "POST",
    path: `/whiteboards/${BOARD}/placements/propose`,
    json: true,
    body: () => JSON.stringify(placement),
  },
  {
    name: "POST /whiteboards/{id}/place",
    method: "POST",
    path: `/whiteboards/${BOARD}/place`,
    json: true,
    body: () => JSON.stringify(placement),
  },
];

function call(who: Who, route: (typeof WRITES)[number]) {
  return app().request(`/api/hub${route.path}`, {
    method: route.method,
    headers: {
      authorization: `Bearer synap_${who}`,
      ...(route.json ? { "content-type": "application/json" } : {}),
    },
    body: route.body?.(),
  });
}

describe("Hub write routes need the WRITE role (2d828af5)", () => {
  for (const route of WRITES) {
    it(`${route.name}: a viewer ⇒ 403, an editor clears the role gate`, async () => {
      const denied = await call("viewer", route);
      expect(denied.status, await denied.clone().text()).toBe(403);

      const allowed = await call("editor", route);
      expect(allowed.status, await allowed.clone().text()).not.toBe(403);
    });
  }

  it("JSON /files lands through the GOVERNED builder, never the direct write", async () => {
    const res = await call("editor", WRITES[0]!);
    expect(res.status, await res.clone().text()).toBe(200);
    expect(h.governed).toHaveLength(1);
    expect(h.governed[0]).toMatchObject({
      userId: EDITOR,
      workspaceId: WS,
      mimeType: "image/png",
      filename: "a.png",
    });
    expect(h.direct).toHaveLength(0);
  });
});
