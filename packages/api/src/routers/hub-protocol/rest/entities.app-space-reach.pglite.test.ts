/**
 * The door a pod app reads its CRM through — `GET /entities?workspaceId=S&
 * profileSlug=person` and `GET /entities/:id` — for a key granted space S
 * (founder "option 1", 2026-10-23): it returns the pod-wide people and
 * companies that carry a live role in S, as a member of S reads them.
 *
 * Through the REAL hub auth door (its W1 fence + `runWithGrant`), the REAL
 * routes, `getCaller` → hub `entities.getEntities` → `entities.list` and the
 * by-id read, with the grant read seam (`accessScopeWhere` ANDs
 * `grantReadPredicate`) compiled and run as SQL on PGlite. Only the key lookup
 * (`apiKeyService`) and the guest check are stubbed; the key's grant is a real
 * `grants` row (`workspace_ids = {CRM}`) read by `GrantRepository`, and the
 * key resolves as its owner (`linkedUserId`), like an app key (I3).
 *
 * Rows rule out: the workspace match alone (the CRM app saw zero people), a
 * facet in another space counting, an un-roled pod-wide person leaking, the
 * by-id door disagreeing with the list. The full-access control shows the
 * floor alone returns the rows the CRM key must not.
 *
 * Cannot see: production Postgres, a real minted app key (the identity the
 * mint yields is pinned by pod-app.invariants I3).
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

const OWNER = randomUUID(); // the person who connected the app
const AGENT = randomUUID(); // the app's own agent (the key principal)
const CRM = randomUUID();
const OTHER = randomUUID();
const PERSON_KIND = randomUUID();
const COMPANY_KIND = randomUUID();
const ROLE_LEAD = randomUUID(); // stamped per space
const ROLE_CLIENT = randomUUID(); // shared, granted to CRM (facet stored NULL)

const LEAD = randomUUID(); // pod-wide person, LEAD in CRM     → seen (a)
const ACME = randomUUID(); // pod-wide company, CLIENT          → seen (b)
const STRANGER = randomUUID(); // pod-wide person, no role      → not
const ELSEWHERE = randomUUID(); // pod-wide person, LEAD in OTHER → not

const KEYS = {
  crm: {
    id: randomUUID(),
    permissions: ["entity.*.read"],
    workspaceIds: [CRM] as string[] | null,
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
    [AGENT, "app-agent@example.test", OWNER]
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
  await q(
    `insert into profiles (id, slug, display_name, profile_kind, scope, entity_scope, is_active, ui_hints, workspace_id) values
       ($1,'person','Person','kind','system','pod',true,'{}'::jsonb,null),
       ($2,'company','Company','kind','system','pod',true,'{}'::jsonb,null),
       ($3,'lead','Lead','role','workspace','workspace',true,'{}'::jsonb,null),
       ($4,'client','Client','role','shared','pod',true,'{}'::jsonb,null)`,
    [PERSON_KIND, COMPANY_KIND, ROLE_LEAD, ROLE_CLIENT]
  );
  await q(
    `insert into profile_workspace_access (profile_id, workspace_id) values ($1,$2)`,
    [ROLE_CLIENT, CRM]
  );
  for (const [id, kind, kindId] of [
    [LEAD, "person", PERSON_KIND],
    [ACME, "company", COMPANY_KIND],
    [STRANGER, "person", PERSON_KIND],
    [ELSEWHERE, "person", PERSON_KIND],
  ] as const) {
    await q(
      `insert into entities (id, user_id, workspace_id, profile_id, type, title, properties, system_data)
       values ($1,$2,null,$3,$4,'e','{}'::jsonb,'{}'::jsonb)`,
      [id, OWNER, kindId, kind]
    );
  }
  for (const [entityId, role, ws] of [
    [LEAD, ROLE_LEAD, CRM],
    [ACME, ROLE_CLIENT, null],
    [ELSEWHERE, ROLE_LEAD, OTHER],
  ] as const) {
    await q(
      `insert into entity_facets (id, entity_id, profile_id, user_id, workspace_id, properties)
       values ($1,$2,$3,$4,$5,'{}'::jsonb)`,
      [randomUUID(), entityId, role, OWNER, ws]
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
  registerEntitiesRoutes(hub);
  const root = new Hono();
  root.route("/api/hub", hub);
  return root;
}

const get = (key: KeyName, path: string) =>
  app().request(`/api/hub${path}`, {
    headers: { authorization: `Bearer synap_${key}` },
  });

async function ids(res: Response): Promise<string[]> {
  expect(res.status).toBe(200);
  return ((await res.json()) as Array<{ id: string }>).map((r) => r.id).sort();
}

describe("GET /entities?workspaceId=CRM — the app sees the pod-wide records roled in CRM", () => {
  it("control: a full-access key sees every pod-wide person (the floor alone)", async () => {
    expect(
      await ids(
        await get("full", `/entities?workspaceId=${CRM}&profileSlug=person`)
      )
    ).toEqual([LEAD, STRANGER, ELSEWHERE].sort());
  });

  it("profileSlug=person: the person with a role stamped in CRM, not the un-roled one nor one roled elsewhere", async () => {
    expect(
      await ids(
        await get("crm", `/entities?workspaceId=${CRM}&profileSlug=person`)
      )
    ).toEqual([LEAD]);
  });

  it("profileSlug=company: the company wearing a shared role granted to CRM", async () => {
    expect(
      await ids(
        await get("crm", `/entities?workspaceId=${CRM}&profileSlug=company`)
      )
    ).toEqual([ACME]);
  });
});

describe("GET /entities/:id agrees with the list", () => {
  it("the roled person and company are returned", async () => {
    for (const id of [LEAD, ACME]) {
      const res = await get("crm", `/entities/${id}`);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { id: string }).id).toBe(id);
    }
  });

  it("the un-roled person and the one roled elsewhere are not found", async () => {
    for (const id of [STRANGER, ELSEWHERE]) {
      expect((await get("crm", `/entities/${id}`)).status).toBe(404);
    }
  });

  it("control: the full-access key reads the un-roled person", async () => {
    expect((await get("full", `/entities/${STRANGER}`)).status).toBe(200);
  });
});
