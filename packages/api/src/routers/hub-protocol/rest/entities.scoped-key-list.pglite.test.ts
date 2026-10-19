/**
 * GET /entities for a SCOPED key (O2) — through the REAL hub auth door (its W1
 * fence + `runWithGrant`), the REAL route, the REAL `getCaller` → hub
 * `entities.getEntities` → `entities.list`, and the REAL grant read seam
 * (`accessScopeWhere` ANDs `grantReadPredicate`), compiled and run as SQL on
 * PGlite. Only the key lookup (`apiKeyService`) and the guest check are stubbed;
 * the key's grant is a real `grants` row read by `GrantRepository`.
 *
 * Why: a website reads its pod with a project-limited, read-only key. The list
 * door it needs (`GET /entities?projectId=&offset=`, hub-rest-client
 * `getRecentEntities`) answered 403 GRANT_DOOR_UNSUPPORTED for every scoped
 * key, because the fence did not list it — although every branch but `q` reads
 * through the seamed `entities.getEntities`. It is listed now, and the `q`
 * branch (Typesense, which no grant narrows) is refused for any key with a
 * limit.
 *
 * Rows rule out: listing the door without the seam narrowing (the control
 * shows the floor alone returns every row), a fence that sees only `/api/hub`
 * (alias rows), a `q` guard that trusts `isFencedGrant` (a `*` pinned to a
 * project is not "fenced" but search would escape the pin), and a guard that
 * refuses everyone (the full-access `q` control is not a fence refusal).
 *
 * Cannot see: production Postgres, Typesense (the full-access `q` control only
 * proves the refusal is grant-dependent, not that search answers).
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
const WS = randomUUID();
const PROJECT = randomUUID();
const NOTE = randomUUID();
const IN_PROJECT = randomUUID(); // WS, filed into PROJECT
const OUT_OF_PROJECT = randomUUID(); // WS, filed nowhere
const POD_IN_PROJECT = randomUUID(); // pod-wide, filed into PROJECT
const POD_OUT = randomUUID(); // pod-wide (a person, say), filed nowhere
const ALL = [IN_PROJECT, OUT_OF_PROJECT, POD_IN_PROJECT, POD_OUT].sort();
const IN_GRANT = [IN_PROJECT, POD_IN_PROJECT].sort();

/** Keys by bearer: each one's grant is a real `grants` row. */
const KEYS = {
  project: {
    id: randomUUID(),
    permissions: ["entity.*.read"],
    projectIds: [PROJECT],
  },
  pinnedStar: { id: randomUUID(), permissions: ["*"], projectIds: [PROJECT] },
  full: { id: randomUUID(), permissions: ["*"], projectIds: null },
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
    `insert into workspaces (id, name, owner_id, settings) values ($1,'Site','${OWNER}','{}'::jsonb)`,
    [WS]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
    [randomUUID(), WS, OWNER]
  );
  await q(
    `insert into profiles (id, slug, display_name, profile_kind, scope, entity_scope, is_active, ui_hints, workspace_id)
     values ($1,'note','Note','kind','system','workspace',true,'{}'::jsonb,null)`,
    [NOTE]
  );
  for (const [id, ws] of [
    [IN_PROJECT, WS],
    [OUT_OF_PROJECT, WS],
    [POD_IN_PROJECT, null],
    [POD_OUT, null],
  ] as const) {
    await q(
      `insert into entities (id, user_id, workspace_id, profile_id, type, title, properties, system_data)
       values ($1,$2,$3,$4,'note','n','{}'::jsonb,'{}'::jsonb)`,
      [id, OWNER, ws, NOTE]
    );
  }
  for (const source of [IN_PROJECT, POD_IN_PROJECT]) {
    await q(
      `insert into relations (id, user_id, workspace_id, source_entity_id, target_entity_id, type)
       values ($1,$2,$3,$4,$5,'belongs_to_project')`,
      [randomUUID(), OWNER, WS, source, PROJECT]
    );
  }
  await q(
    `insert into projects (id, name, user_id, workspace_id) values ($1,'Site project',$2,$3)`,
    [PROJECT, OWNER, WS]
  );
  for (const k of Object.values(KEYS)) {
    await q(
      `insert into grants (id, api_key_id, principal_user_id, on_behalf_of, permissions, project_ids, created_by)
       values ($1,$2,$3,$4,$5::text[],$6::uuid[],$4)`,
      [
        randomUUID(),
        k.id,
        AGENT,
        OWNER,
        `{${k.permissions.join(",")}}`,
        k.projectIds ? `{${k.projectIds.join(",")}}` : null,
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

/** Both production mounts (apps/api/src/index.ts: /api/hub + /api/hub-protocol). */
function app() {
  const hub: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  hub.use("/*", hubAuthMiddleware as never);
  registerEntitiesRoutes(hub);
  const root = new Hono();
  root.route("/api/hub", hub);
  root.route("/api/hub-protocol", hub);
  return root;
}

const get = (key: KeyName, path: string) =>
  app().request(path, { headers: { authorization: `Bearer synap_${key}` } });

async function ids(res: Response): Promise<string[]> {
  expect(res.status).toBe(200);
  return ((await res.json()) as Array<{ id: string }>).map((r) => r.id).sort();
}

describe("GET /entities — a project-limited key lists only in-grant rows", () => {
  it("control: a full-access key sees every row (the floor alone)", async () => {
    expect(await ids(await get("full", "/api/hub/entities?limit=50"))).toEqual(
      ALL
    );
  });

  it("?projectId= (the site's list) ⇒ only the project's rows", async () => {
    expect(
      await ids(
        await get("project", `/api/hub/entities?projectId=${PROJECT}&limit=50`)
      )
    ).toEqual(IN_GRANT);
  });

  it("no lens at all ⇒ still only the grant's rows (the grant, not the lens, bounds it)", async () => {
    expect(
      await ids(await get("project", "/api/hub/entities?limit=50"))
    ).toEqual(IN_GRANT);
  });

  it("paging keeps the bound (offset walks in-grant rows only)", async () => {
    const page1 = await ids(
      await get("project", "/api/hub/entities?limit=1&offset=0")
    );
    const page2 = await ids(
      await get("project", "/api/hub/entities?limit=1&offset=1")
    );
    const page3 = await ids(
      await get("project", "/api/hub/entities?limit=1&offset=2")
    );
    expect([...page1, ...page2].sort()).toEqual(IN_GRANT);
    expect(page3).toEqual([]);
  });

  it("workspaceId and scope=all branches stay bounded too", async () => {
    expect(
      await ids(
        await get("project", `/api/hub/entities?workspaceId=${WS}&limit=50`)
      )
    ).toEqual(IN_GRANT);
    expect(
      await ids(await get("project", "/api/hub/entities?scope=all&limit=50"))
    ).toEqual(IN_GRANT);
  });

  it("the /api/hub-protocol alias mount answers the same", async () => {
    expect(
      await ids(
        await get(
          "project",
          `/api/hub-protocol/entities?projectId=${PROJECT}&limit=50`
        )
      )
    ).toEqual(IN_GRANT);
  });

  it("the user-floor door agrees (/users/me/entities, already listed)", async () => {
    expect(
      await ids(await get("project", "/api/hub/users/me/entities?limit=50"))
    ).toEqual(IN_GRANT);
  });
});

describe("GET /entities?q= — search is refused for any key with a limit", () => {
  for (const mount of ["/api/hub", "/api/hub-protocol"]) {
    it(`a project-limited key ⇒ 403 GRANT_DOOR_UNSUPPORTED (${mount})`, async () => {
      const res = await get("project", `${mount}/entities?q=note`);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({
        code: "GRANT_DOOR_UNSUPPORTED",
      });
    });
  }

  it("a `*` pinned to the project is refused too (not 'fenced', still pinned)", async () => {
    const res = await get("pinnedStar", "/api/hub/entities?q=note");
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "GRANT_DOOR_UNSUPPORTED" });
  });

  it("control: an unbounded full-access key is not refused by the guard", async () => {
    const res = await get("full", "/api/hub/entities?q=note");
    // Typesense is absent here, so the search itself may fail — but never
    // with the fence's refusal.
    const body = (await res.json()) as { code?: string };
    expect(body.code).not.toBe("GRANT_DOOR_UNSUPPORTED");
  });
});
