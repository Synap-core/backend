/**
 * A pod app reads the cells of its spaces (design b199a3a4, Question 2,
 * slice 4): `GET /cells` and `GET /cells/:typeKey` through the REAL hub auth
 * door (its W1 fence + `runWithGrant`) and the REAL routes, on PGlite.
 *
 * Every app's grant is pinned to spaces. The doors used to be `READS("widget")`,
 * which no pinned key passes, so a client app could not read a single cell.
 * They are now `NARROWED("widget")`: admitted on `widget.read`, and the route
 * reads through the `widget` grant clause (`grantReadPredicate`).
 *
 * Rows rule out:
 *   - an app refused the cells of its own space (the old READS fence);
 *   - an app reading a cell of a space it was not granted, or a pod-wide cell
 *     (the grant clause reaches only the pinned spaces), through the list or
 *     by key;
 *   - a key without `widget.read` let through (403, never an empty list);
 *   - a narrowing that also hides cells from the person's own full key
 *     (control).
 *
 * Stubbed: the key lookup (`getApiKeyStatus`; the grant row is real), the guest
 * check. Cannot see: production Postgres, a real minted app token.
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

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import "../../../access/grant-read.js";
import { hubAuthMiddleware } from "../_middleware/auth.js";
import { registerCellsRoutes } from "./cells.js";
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

const OWNER = randomUUID();
const CRM = randomUUID();
const OTHER = randomUUID();

interface Key {
  id: string;
  keyType: string;
  permissions: string[];
  workspaceIds: string[] | null;
  clientId: string | null;
}
const KEYS = {
  /** The CRM app as the person, pinned to its space, reading cells. */
  crm: {
    id: randomUUID(),
    keyType: "app_person",
    permissions: ["widget.read", "view.read", "entity.*.read"],
    workspaceIds: [CRM],
    clientId: "crm-app",
  },
  /** The same app, never granted `widget.read`. */
  noWidget: {
    id: randomUUID(),
    keyType: "app_person",
    permissions: ["view.read", "entity.*.read"],
    workspaceIds: [CRM],
    clientId: "crm-app",
  },
  /** The owner, unbounded. */
  full: {
    id: randomUUID(),
    keyType: "hub_inbound",
    permissions: ["*"],
    workspaceIds: null,
    clientId: null,
  },
} satisfies Record<string, Key>;
type KeyName = keyof typeof KEYS;

const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);

async function cell(typeKey: string, workspaceId: string | null, on = true) {
  await q(
    `insert into widget_definitions (id, type_key, workspace_id, name, renderer_type, renderer_source, deps, is_active)
     values ($1,$2,$3,$4,'iframe','<!doctype html><p>hi</p>','{}'::jsonb,$5)`,
    [randomUUID(), typeKey, workspaceId, typeKey, on]
  );
}

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));

  await q(
    `insert into users (id, email, user_type, name) values ($1,$2,'human','Owner')`,
    [OWNER, "owner@example.test"]
  );
  await q(
    `insert into pod_members (id, user_id, pod_role) values ($1,$2,'owner')`,
    [randomUUID(), OWNER]
  );
  for (const [ws, name] of [
    [CRM, "CRM"],
    [OTHER, "Other"],
  ] as const) {
    await q(
      `insert into workspaces (id, name, owner_id, settings) values ($1,$2,$3,'{}'::jsonb)`,
      [ws, name, OWNER]
    );
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
      [randomUUID(), ws, OWNER]
    );
  }
  await cell("generated:health-replies", CRM);
  await cell("generated:health-retired", CRM, false);
  await cell("generated:other-secret", OTHER);
  await cell("generated:pod-wide", null);

  for (const k of Object.values(KEYS)) {
    await q(
      `insert into api_keys (id, user_id, linked_user_id, is_active) values ($1,$2,null,true)`,
      [k.id, OWNER]
    );
    await q(
      `insert into grants (id, api_key_id, principal_user_id, on_behalf_of, permissions, workspace_ids, created_by, client_id)
       values ($1,$2,$3,$3,$4::text[],$5::uuid[],$3,$6)`,
      [
        randomUUID(),
        k.id,
        OWNER,
        `{${k.permissions.join(",")}}`,
        k.workspaceIds ? `{${k.workspaceIds.join(",")}}` : null,
        k.clientId,
      ]
    );
  }
}, 120_000);

beforeEach(() => {
  h.getApiKeyStatus.mockImplementation(async (bearer: string) => {
    const key: Key = KEYS[bearer.replace(/^synap_/, "") as KeyName];
    return {
      status: "valid",
      record: {
        id: key.id,
        userId: OWNER,
        linkedUserId: null,
        parentKeyId: null,
        scope: ["hub-protocol.read", "hub-protocol.write"],
        keyType: key.keyType,
        workspaceId: null,
        expiresAt: null,
      },
    };
  });
});

function app() {
  const hub: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  hub.use("/*", hubAuthMiddleware as never);
  registerCellsRoutes(hub);
  const root = new Hono();
  root.route("/api/hub", hub);
  return root;
}
const get = (key: KeyName, path: string) =>
  app().request(`/api/hub${path}`, {
    headers: { authorization: `Bearer synap_${key}` },
  });
async function listKeys(key: KeyName, path: string): Promise<string[]> {
  const res = await get(key, path);
  expect(res.status, await res.clone().text()).toBe(200);
  const rows = (await res.json()) as Array<{ typeKey: string }>;
  return rows.map((r) => r.typeKey).sort();
}
const one = (typeKey: string, ws?: string) =>
  `/cells/${encodeURIComponent(typeKey)}${ws ? `?workspaceId=${ws}` : ""}`;

describe("GET /cells — a pinned app reads the cells of its spaces", () => {
  it("the CRM app with widget.read lists its space's active cells, and nothing else", async () => {
    expect(await listKeys("crm", `/cells?workspaceId=${CRM}`)).toEqual([
      "generated:health-replies",
    ]);
  });

  it("asked about another space, or pod-wide, it reads none of those cells", async () => {
    expect(await listKeys("crm", `/cells?workspaceId=${OTHER}`)).toEqual([]);
    expect(await listKeys("crm", "/cells")).toEqual([]);
  });

  it("without widget.read the door is refused (403), never an empty list", async () => {
    const res = await get("noWidget", `/cells?workspaceId=${CRM}`);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code?: string }).code).toBe(
      "GRANT_DOOR_UNSUPPORTED"
    );
  });

  it("CONTROL: the person's full key still reads the space's cells plus the pod-wide ones", async () => {
    expect(await listKeys("full", `/cells?workspaceId=${CRM}`)).toEqual([
      "generated:health-replies",
      "generated:pod-wide",
    ]);
  });
});

describe("GET /cells/:typeKey — one cell, same fence", () => {
  it("the CRM app reads a cell of its space by key", async () => {
    const res = await get("crm", one("generated:health-replies", CRM));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.typeKey).toBe("generated:health-replies");
    expect(body.rendererType).toBe("iframe");
    expect(body.rendererSource).toContain("<p>hi</p>");
  });

  it("a cell of another space, a pod-wide cell and a retired cell are 404 to it", async () => {
    expect(
      (await get("crm", one("generated:other-secret", OTHER))).status
    ).toBe(404);
    expect((await get("crm", one("generated:pod-wide"))).status).toBe(404);
    expect(
      (await get("crm", one("generated:health-retired", CRM))).status
    ).toBe(404);
  });

  it("without widget.read it is refused (403)", async () => {
    expect(
      (await get("noWidget", one("generated:health-replies", CRM))).status
    ).toBe(403);
  });

  it("CONTROL: the full key reads the pod-wide cell", async () => {
    expect((await get("full", one("generated:pod-wide"))).status).toBe(200);
  });
});
