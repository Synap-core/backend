/**
 * GET /files/{entityId}/url for a SCOPED key — through the REAL hub auth door
 * (its W1 fence + `runWithGrant`), the REAL route, the REAL
 * `signFileEntityUrl` → `loadSignableFileEntity` → `scopedDb(entities)` (which
 * ANDs `grantReadPredicate`), compiled and run as SQL on PGlite. Stubbed: the
 * key lookup (`apiKeyService`), the guest check, and the object-store signer
 * (`storage.getSignedUrl` — signing needs no store; the stub echoes its key so
 * the test can see WHICH blob was signed).
 *
 * Why: an app holding a key with a per-workspace read grant must be able to
 * show a stored file (the Kratos-only `GET /api/files/:entityId/url` refuses
 * any key), and must NOT be able to sign a file in a workspace its grant does
 * not cover.
 *
 * Rows rule out: a door the fence still refuses (the allowed case would be a
 * 403 GRANT_DOOR_UNSUPPORTED), a read that skips the grant (the out-of-grant
 * file would be signed), a 403 that leaks the URL, a non-uuid id reaching
 * Postgres as a 500, and a missing read scope passing.
 *
 * Cannot see: production Postgres, a real signer (the attachment disposition
 * is the `active-mime-needs-attachment-disposition` tripwire's job).
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
  scopes: ["hub-protocol.read"] as string[],
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
vi.mock("@synap/storage", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  storage: {
    getSignedUrl: async (key: string, expiresIn: number) =>
      `https://signed.test/${key}?expires=${expiresIn}`,
  },
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
// Registers the grant read provider the database floors call (as the API does
// at load) — otherwise a scoped grant reads deny-all, not narrowed.
import "../../../access/grant-read.js";
import { hubAuthMiddleware } from "../_middleware/auth.js";
import { registerEntitiesRoutes } from "./entities.js";
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

const OWNER = randomUUID(); // the human whose pod it is
const AGENT = randomUUID(); // the key principal (an agent user, linked to OWNER)
const WS_A = randomUUID(); // the workspace the app's grant covers
const WS_B = randomUUID(); // another of the owner's workspaces — NOT granted
const FILE_PROFILE = randomUUID();
const FILE_A = randomUUID();
const FILE_B = randomUUID();
const DOC_A = randomUUID();
const DOC_B = randomUUID();

/** Keys by bearer: each one's grant is a real `grants` row. */
const KEYS = {
  // The app-connect shape: read-only, pinned to one workspace.
  pinned: {
    id: randomUUID(),
    permissions: ["entity.*.read"],
    workspaceIds: [WS_A] as string[] | null,
  },
  full: { id: randomUUID(), permissions: ["*"], workspaceIds: null },
} as const;
type KeyName = keyof typeof KEYS;

const q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));

  await q(`insert into users (id, email, user_type) values ($1,$2,'human')`, [
    OWNER,
    "owner@example.test",
  ]);
  await q(
    `insert into users (id, email, user_type, created_by_user_id) values ($1,$2,'agent',$3)`,
    [AGENT, "agent@example.test", OWNER]
  );
  for (const ws of [WS_A, WS_B]) {
    await q(
      `insert into workspaces (id, name, owner_id, settings) values ($1,$2,$3,'{}'::jsonb)`,
      [ws, `ws-${ws.slice(0, 4)}`, OWNER]
    );
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
      [randomUUID(), ws, OWNER]
    );
  }
  await q(
    `insert into profiles (id, slug, display_name, profile_kind, scope, entity_scope, is_active, ui_hints, workspace_id)
     values ($1,'file','File','kind','system','workspace',true,'{}'::jsonb,null)`,
    [FILE_PROFILE]
  );
  for (const [entityId, docId, ws, key] of [
    [FILE_A, DOC_A, WS_A, "users/owner/a.png"],
    [FILE_B, DOC_B, WS_B, "users/owner/b.png"],
  ] as const) {
    await q(
      `insert into documents (id, user_id, workspace_id, title, type, storage_key, mime_type)
       values ($1,$2,$3,'f','file',$4,'image/png')`,
      [docId, OWNER, ws, key]
    );
    await q(
      `insert into entities (id, user_id, workspace_id, profile_id, type, title, properties, system_data, document_id)
       values ($1,$2,$3,$4,'file','f','{}'::jsonb,'{}'::jsonb,$5)`,
      [entityId, OWNER, ws, FILE_PROFILE, docId]
    );
  }
  for (const k of Object.values(KEYS)) {
    await q(
      `insert into grants (id, api_key_id, principal_user_id, on_behalf_of, permissions, workspace_ids, created_by)
       values ($1,$2,$3,$4,$5::text[],$6::uuid[],$4)`,
      [
        randomUUID(),
        k.id,
        AGENT,
        OWNER,
        `{${k.permissions.join(",")}}`,
        k.workspaceIds ? `{${k.workspaceIds.join(",")}}` : null,
      ]
    );
  }
}, 120_000);

beforeEach(() => {
  h.scopes = ["hub-protocol.read"];
  h.getApiKeyStatus.mockImplementation(async (bearer: string) => {
    const name = bearer.replace(/^synap_/, "") as KeyName;
    return {
      status: "valid",
      record: {
        id: KEYS[name].id,
        userId: AGENT,
        linkedUserId: OWNER,
        parentKeyId: null,
        scope: h.scopes,
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
  const root = new Hono();
  root.route("/api/hub", hub);
  return root;
}

const get = (key: KeyName, entityId: string) =>
  app().request(`/api/hub/files/${entityId}/url`, {
    headers: { authorization: `Bearer synap_${key}` },
  });

type Body = {
  url?: string;
  expiresAt?: string;
  mimeType?: string | null;
  error?: string;
  code?: string;
};

describe("GET /files/{entityId}/url — a signed URL bounded by the key's grant", () => {
  it("in-grant file ⇒ 200 with the Kratos door's shape, signing THAT file's blob", async () => {
    const res = await get("pinned", FILE_A);
    const body = (await res.json()) as Body;
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.url).toBe("https://signed.test/users/owner/a.png?expires=3600");
    expect(body.mimeType).toBe("image/png");
    expect(Number.isNaN(Date.parse(body.expiresAt!))).toBe(false);
    expect(Object.keys(body).sort()).toEqual(["expiresAt", "mimeType", "url"]);
  });

  it("a file in a workspace the grant does NOT cover ⇒ 403, no URL", async () => {
    const res = await get("pinned", FILE_B);
    const body = (await res.json()) as Body;
    expect(res.status, JSON.stringify(body)).toBe(403);
    expect(body.url).toBeUndefined();
    // Refused by the READ FLOOR (the grant), not by the fence.
    expect(body.code).not.toBe("GRANT_DOOR_UNSUPPORTED");
  });

  it("control: the same file IS signed for a full-access key (the floor alone admits it)", async () => {
    const res = await get("full", FILE_B);
    expect(res.status).toBe(200);
    expect(((await res.json()) as Body).url).toBe(
      "https://signed.test/users/owner/b.png?expires=3600"
    );
  });

  it("an unknown file ⇒ 404; a non-uuid id ⇒ 400 (never a 500)", async () => {
    expect((await get("pinned", randomUUID())).status).toBe(404);
    expect((await get("pinned", "not-a-uuid")).status).toBe(400);
  });

  it("a key without hub-protocol.read ⇒ 403, no URL", async () => {
    h.scopes = ["hub-protocol.write"];
    const res = await get("full", FILE_A);
    expect(res.status).toBe(403);
    expect(((await res.json()) as Body).url).toBeUndefined();
  });
});
