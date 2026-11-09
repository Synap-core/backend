/**
 * GET /api/hub/documents/:id for a key LIMITED TO A SPACE reads the body of
 * an entity stored in that space, even when the body was stored pod-wide (a
 * part follows its whole, founder decision 22226da5, 2026-11-09).
 *
 * The live case: Content Studio's key, granted the Content OS space, got 404
 * not_found on document 9325d026, the pod-wide body of composition dfdfe429
 * stored in Content OS. The SDK's `getDocument` calls this door.
 *
 * Driven through the REAL hub auth door (W1 fence + identity remap +
 * `runWithGrant`), the REAL route, the hub tRPC `documents.getDocument` and
 * `documents.get` (the same chain MCP `synap_get_document` takes), and the
 * REAL floors, compiled and run as SQL on PGlite. Stubbed: the key lookup
 * (`apiKeyService`), the guest check, and the document diagnostics (not
 * under test).
 *
 * Rows rule out: the body unread (the bug), the body of an entity in another
 * space read, the body of a pod-wide entity read (the "Video · Free take v1"
 * case, 1f72fc19 / b4494a7a), a standalone pod-wide document read.
 *
 * Cannot see: production Postgres; the SDK client.
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
vi.mock(
  "../../../services/document-patch/read-document.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    currentDiagnostics: vi.fn(async () => ({ items: [] })),
  })
);

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
// Registers the grant read provider the database floors call (as the API does
// at load) — otherwise a scoped grant reads deny-all, not narrowed.
import "../../../access/grant-read.js";
import { hubAuthMiddleware } from "../_middleware/auth.js";
import { registerDocumentsRoutes } from "./documents.js";
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

const OWNER = randomUUID(); // the person the app's key acts for
const AGENT = randomUUID(); // the key principal, linked to OWNER
const CONTENT = randomUUID(); // "Content OS": the space the key is limited to
const OTHER = randomUUID();
const KIND = randomUUID();

const E_CONTENT = randomUUID(); // composition in Content OS
const E_OTHER = randomUUID(); // entity in another space
const E_POD = randomUUID(); // pod-wide entity ("Video · Free take v1")
const B_CONTENT = randomUUID(); // its pod-wide body (9325d026-like)
const B_OTHER = randomUUID();
const B_POD = randomUUID(); // b4494a7a-like
const D_LOOSE = randomUUID(); // pod-wide, attached to nothing

const KEYS = {
  // The app-connect shape: reads documents and entities, pinned to one space.
  content: {
    id: randomUUID(),
    permissions: ["document.read", "entity.read"],
    workspaceIds: [CONTENT] as string[] | null,
  },
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
  await q(
    `insert into workspaces (id, name, owner_id, settings) values ($1,'Content OS',$3,'{}'::jsonb),($2,'Other',$3,'{}'::jsonb)`,
    [CONTENT, OTHER, OWNER]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner'),($4,$5,$3,'owner')`,
    [randomUUID(), CONTENT, OWNER, randomUUID(), OTHER]
  );
  await q(
    `insert into profiles (id, slug, display_name, profile_kind, scope, entity_scope, is_active, ui_hints, workspace_id)
     values ($1,'content-composition','Composition','kind','system','workspace',true,'{}'::jsonb,null)`,
    [KIND]
  );
  for (const [id, ws, doc] of [
    [E_CONTENT, CONTENT, B_CONTENT],
    [E_OTHER, OTHER, B_OTHER],
    [E_POD, null, B_POD],
  ] as const) {
    await q(
      `insert into entities (id, user_id, workspace_id, profile_id, type, title, document_id, properties, system_data)
       values ($1,$2,$3,$4,'content-composition','Composition',$5,'{}'::jsonb,'{}'::jsonb)`,
      [id, OWNER, ws, KIND, doc]
    );
  }
  for (const id of [B_CONTENT, B_OTHER, B_POD, D_LOOSE]) {
    await q(
      `insert into documents (id, user_id, workspace_id, title, type, current_version, content_revision, metadata)
       values ($1,$2,null,'Carousel composition','markdown',1,1,'{}'::jsonb)`,
      [id, OWNER]
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
  h.getApiKeyStatus.mockImplementation(async (bearer: string) => {
    const name = bearer.replace(/^synap_/, "") as KeyName;
    return {
      status: "valid",
      record: {
        id: KEYS[name].id,
        userId: AGENT,
        linkedUserId: OWNER,
        parentKeyId: null,
        scope: ["hub-protocol.read"],
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
  registerDocumentsRoutes(hub);
  const root = new Hono();
  root.route("/api/hub", hub);
  return root;
}

const get = (key: KeyName, path: string) =>
  app().request(`/api/hub${path}`, {
    headers: { authorization: `Bearer synap_${key}` },
  });

type Body = { document?: { id?: string }; error?: string };

describe("GET /documents/:id — a key limited to Content OS", () => {
  it("THE LIVE CASE: reads the pod-wide body of a composition stored in Content OS", async () => {
    const res = await get("content", `/documents/${B_CONTENT}`);
    const body = (await res.json()) as Body;
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.document?.id).toBe(B_CONTENT);
  });

  it("NOT the body of an entity in another space, of a pod-wide entity, nor a loose pod-wide document", async () => {
    for (const id of [B_OTHER, B_POD, D_LOOSE]) {
      const res = await get("content", `/documents/${id}`);
      expect(res.status, `${id}: ${await res.clone().text()}`).toBe(404);
    }
  });
});
