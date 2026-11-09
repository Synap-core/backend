/**
 * The STATUS primitive of the list filter grammar (`status`, `statusCategory`)
 * through the REAL door: Hub `GET /entities?filters=` -> `entities.getEntities`
 * -> `entities.list` -> `entityListFiltersWhere` -> `ViewFilterCompiler`, run
 * as SQL on PGlite. A kind reads `entities.status`; a list whose `profileSlug`
 * names a ROLE reads that role's facet (`entity_facets.status`).
 *
 * Rows rule out:
 *   - the status filter dropped or compiled to "no condition" (the live bug:
 *     `filters:{status:"qualified"}` returned leads that are "new");
 *   - a role list filtering on the ENTITY's status: `C_TRAP` is a company whose
 *     own column says "qualified" while its lead facet says "new";
 *   - a negation that loses the unset rows ("is not qualified" keeps the lead
 *     with no stage);
 *   - an unknown category read as "no rows" (it is a 400); an unknown status
 *     VALUE matches nothing (a value is declared per lifecycle).
 *
 * Cannot see: production Postgres, the MCP door (its forwarder is another
 * lane's), the lean projection (unit test `entity-lean-list.test.ts`).
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

const OWNER = randomUUID();
const AGENT = randomUUID();
const SALES = randomUUID();
const FINDING = randomUUID(); // kind
const COMPANY = randomUUID(); // kind
const LEAD = randomUUID(); // role
const F_NEW = randomUUID();
const F_TRIAGED = randomUUID();
const F_FIXED = randomUUID();
const C_NEW = randomUUID(); // lead facet: new
const C_QUAL = randomUUID(); // lead facet: qualified
const C_TRAP = randomUUID(); // entity column qualified, lead facet new
const C_UNSET = randomUUID(); // lead facet with no stage
const C_PLAIN = randomUUID(); // a company wearing no lead facet

const KEY_ID = randomUUID();

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
    `insert into workspaces (id, name, owner_id, settings) values ($1,'Sales',$2,'{}'::jsonb)`,
    [SALES, OWNER]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
    [randomUUID(), SALES, OWNER]
  );
  for (const [id, slug, kind] of [
    [FINDING, "finding", "kind"],
    [COMPANY, "company", "kind"],
    [LEAD, "lead", "role"],
  ] as const) {
    await q(
      `insert into profiles (id, slug, display_name, profile_kind, scope, entity_scope, is_active, ui_hints, workspace_id)
       values ($1,$2,$2,$3,'system','workspace',true,'{}'::jsonb,null)`,
      [id, slug, kind]
    );
  }
  const entity = (
    id: string,
    profileId: string,
    type: string,
    status: string | null,
    category: string | null
  ) =>
    q(
      `insert into entities (id, user_id, workspace_id, profile_id, type, title, properties, system_data, status, status_category)
       values ($1,$2,$3,$4,$5,'t','{}'::jsonb,'{}'::jsonb,$6,$7)`,
      [id, OWNER, SALES, profileId, type, status, category]
    );
  await entity(F_NEW, FINDING, "finding", "new", "open");
  await entity(F_TRIAGED, FINDING, "finding", "triaged", "active");
  await entity(F_FIXED, FINDING, "finding", "fixed", "done");
  await entity(C_NEW, COMPANY, "company", null, null);
  await entity(C_QUAL, COMPANY, "company", null, null);
  await entity(C_TRAP, COMPANY, "company", "qualified", "active");
  await entity(C_UNSET, COMPANY, "company", null, null);
  await entity(C_PLAIN, COMPANY, "company", "qualified", "active");
  for (const [entityId, status, category] of [
    [C_NEW, "new", "open"],
    [C_QUAL, "qualified", "active"],
    [C_TRAP, "new", "open"],
    [C_UNSET, null, null],
  ] as const) {
    await q(
      `insert into entity_facets (id, entity_id, profile_id, user_id, workspace_id, status, status_category, properties, metadata)
       values ($1,$2,$3,$4,$5,$6,$7,'{}'::jsonb,'{}'::jsonb)`,
      [randomUUID(), entityId, LEAD, OWNER, SALES, status, category]
    );
  }
  await q(
    `insert into grants (id, api_key_id, principal_user_id, on_behalf_of, permissions, workspace_ids, created_by)
     values ($1,$2,$3,$4,'{*}'::text[],null,$4)`,
    [randomUUID(), KEY_ID, AGENT, OWNER]
  );
}, 120_000);

beforeEach(() => {
  h.getApiKeyStatus.mockImplementation(async () => ({
    status: "valid",
    record: {
      id: KEY_ID,
      userId: AGENT,
      linkedUserId: OWNER,
      parentKeyId: null,
      scope: ["hub-protocol.read"],
      keyType: "hub_inbound",
      workspaceId: null,
      expiresAt: null,
    },
  }));
});

function app() {
  const hub: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  hub.use("/*", hubAuthMiddleware as never);
  registerEntitiesRoutes(hub);
  const root = new Hono();
  root.route("/api/hub", hub);
  return root;
}

const get = (params: string, filters: unknown) =>
  app().request(
    `/api/hub/entities?limit=50${params}&filters=${encodeURIComponent(
      JSON.stringify(filters)
    )}`,
    { headers: { authorization: "Bearer synap_full" } }
  );

async function ids(res: Response): Promise<string[]> {
  expect(res.status).toBe(200);
  return ((await res.json()) as Array<{ id: string }>).map((r) => r.id).sort();
}

const sorted = (...xs: string[]) => [...xs].sort();

describe("status filter on a KIND reads entities.status", () => {
  it("status equals: only the matching findings", async () => {
    expect(
      await ids(
        await get("&profileSlug=finding", [
          { field: "status", operator: "equals", value: "new" },
        ])
      )
    ).toEqual([F_NEW]);
  });

  it("statusCategory in: the open and active findings, never the done one", async () => {
    expect(
      await ids(
        await get("&profileSlug=finding", [
          {
            field: "statusCategory",
            operator: "in",
            value: ["open", "active"],
          },
        ])
      )
    ).toEqual(sorted(F_NEW, F_TRIAGED));
  });

  it("an unknown status value matches nothing; an unknown category is a 400", async () => {
    expect(
      await ids(
        await get("&profileSlug=finding", [
          { field: "status", operator: "equals", value: "nonsense" },
        ])
      )
    ).toEqual([]);
    const res = await get("&profileSlug=finding", [
      { field: "statusCategory", operator: "equals", value: "closed" },
    ]);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(
      /statusCategory is one of open, active, paused, done, lost/
    );
  });
});

describe("status filter on a ROLE reads the role's facet", () => {
  it("control: the role list holds every company wearing the role", async () => {
    expect(
      await ids(
        await get("&profileSlug=lead", [
          { field: "type", operator: "equals", value: "company" },
        ])
      )
    ).toEqual(sorted(C_NEW, C_QUAL, C_TRAP, C_UNSET));
  });

  it("status equals reads the facet: the qualified lead, never the company whose own column says qualified", async () => {
    expect(
      await ids(
        await get("&profileSlug=lead", [
          { field: "status", operator: "equals", value: "qualified" },
        ])
      )
    ).toEqual([C_QUAL]);
  });

  it("statusCategory reads the facet too", async () => {
    expect(
      await ids(
        await get("&profileSlug=lead", [
          { field: "statusCategory", operator: "equals", value: "open" },
        ])
      )
    ).toEqual(sorted(C_NEW, C_TRAP));
  });

  it("a negation keeps the lead with no stage", async () => {
    expect(
      await ids(
        await get("&profileSlug=lead", [
          { field: "status", operator: "not_equals", value: "qualified" },
        ])
      )
    ).toEqual(sorted(C_NEW, C_TRAP, C_UNSET));
    expect(
      await ids(
        await get("&profileSlug=lead", [
          { field: "status", operator: "is_empty" },
        ])
      )
    ).toEqual([C_UNSET]);
  });

  it("listing the KIND company keeps the entity column", async () => {
    expect(
      await ids(
        await get("&profileSlug=company", [
          { field: "status", operator: "equals", value: "qualified" },
        ])
      )
    ).toEqual(sorted(C_TRAP, C_PLAIN));
  });
});
