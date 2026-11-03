/**
 * GET /entities?filters= and ?includeWorkspace=true (APP-ACCESS plan §3 R2,
 * R3) for a SCOPED key, through the REAL hub auth door (its fence +
 * `runWithGrant`), the REAL route, the REAL `getCaller` -> hub
 * `entities.getEntities` -> `entities.list`, the REAL filter compiler
 * (`ViewFilterCompiler`) and the REAL grant read seam (`accessScopeWhere` ANDs
 * the key's grant), compiled and run as SQL on PGlite. Only the key lookup and
 * the guest check are stubbed; each key's grant is a real `grants` row.
 *
 * Rows rule out:
 *   - a filter ORed with the floor, or applied before it: the space-pinned key
 *     filtering on a value only another space's row holds gets nothing new;
 *   - a filter param that is accepted and dropped (the forwarder is a
 *     whitelist): the full-access control sees the filter narrow;
 *   - an unknown property read as "no rows", a secret property used as an
 *     oracle, an unbounded clause list, a property filter without a kind;
 *   - space names read from the caller's memberships instead of from the rows
 *     returned: the pinned key never sees the other space's name.
 *
 * Cannot see: production Postgres, the indexed (`entity_property_index`) path
 * (no row is indexed here, so properties compile on the JSONB path).
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
const SALES = randomUUID(); // the space the pinned key reaches
const FINANCE = randomUUID(); // a space the owner has, the key does not
const DEAL = randomUUID(); // kind `deal`
const STAGE = randomUUID(); // deal.stage (string)
const TOKEN = randomUUID(); // deal.apiToken (secret)
const A_WON = randomUUID(); // Sales, stage won
const A_LOST = randomUUID(); // Sales, stage lost
const B_WON = randomUUID(); // Finance, stage won
const POD_WON = randomUUID(); // pod-wide, stage won

/** Keys by bearer: each one's grant is a real `grants` row. */
const KEYS = {
  pinned: {
    id: randomUUID(),
    permissions: ["entity.*.read"],
    workspaceIds: [SALES],
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
  for (const [id, name] of [
    [SALES, "Sales"],
    [FINANCE, "Finance"],
  ] as const) {
    await q(
      `insert into workspaces (id, name, owner_id, settings) values ($1,$2,$3,'{}'::jsonb)`,
      [id, name, OWNER]
    );
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
      [randomUUID(), id, OWNER]
    );
  }
  await q(
    `insert into profiles (id, slug, display_name, profile_kind, scope, entity_scope, is_active, ui_hints, workspace_id)
     values ($1,'deal','Deal','kind','system','workspace',true,'{}'::jsonb,null)`,
    [DEAL]
  );
  for (const [id, slug, valueType] of [
    [STAGE, "stage", "string"],
    [TOKEN, "apiToken", "secret"],
  ] as const) {
    await q(
      `insert into property_defs (id, slug, profile_id, value_type, constraints, ui_hints)
       values ($1,$2,$3,$4,'{}'::jsonb,'{}'::jsonb)`,
      [id, slug, DEAL, valueType]
    );
    await q(
      `insert into profile_properties (profile_id, property_def_id, required, display_order, is_lifecycle)
       values ($1,$2,false,0,false)`,
      [DEAL, id]
    );
  }
  for (const [id, ws, stage] of [
    [A_WON, SALES, "won"],
    [A_LOST, SALES, "lost"],
    [B_WON, FINANCE, "won"],
    [POD_WON, null, "won"],
  ] as const) {
    await q(
      `insert into entities (id, user_id, workspace_id, profile_id, type, title, properties, system_data)
       values ($1,$2,$3,$4,'deal','d',$5::jsonb,'{}'::jsonb)`,
      [id, OWNER, ws, DEAL, JSON.stringify({ stage, apiToken: "s3cr3t" })]
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
  app().request(path, { headers: { authorization: `Bearer synap_${key}` } });

/** `/api/hub/entities?…&filters=<json>` */
const list = (params: string, filters?: unknown) =>
  `/api/hub/entities?limit=50${params}${
    filters === undefined
      ? ""
      : `&filters=${encodeURIComponent(
          typeof filters === "string" ? filters : JSON.stringify(filters)
        )}`
  }`;

const WON = [{ field: "properties.stage", operator: "equals", value: "won" }];

async function ids(res: Response): Promise<string[]> {
  expect(res.status).toBe(200);
  return ((await res.json()) as Array<{ id: string }>).map((r) => r.id).sort();
}

async function refusal(res: Response): Promise<string> {
  expect(res.status).toBe(400);
  return ((await res.json()) as { error: string }).error;
}

describe("GET /entities?filters= — filters narrow, never widen", () => {
  it("control: a full-access key's filter narrows to the won deals of every space", async () => {
    expect(
      await ids(await get("full", list("&profileSlug=deal", WON)))
    ).toEqual([A_WON, B_WON, POD_WON].sort());
  });

  it("control: the pinned key without a filter reads Sales, never Finance", async () => {
    const unfiltered = await ids(
      await get("pinned", list("&profileSlug=deal"))
    );
    expect(unfiltered).toContain(A_WON);
    expect(unfiltered).toContain(A_LOST);
    expect(unfiltered).not.toContain(B_WON);
  });

  it("a space-pinned key filtering on what a Finance row holds gets only its own rows", async () => {
    const unfiltered = await ids(
      await get("pinned", list("&profileSlug=deal"))
    );
    const filtered = await ids(
      await get("pinned", list("&profileSlug=deal", WON))
    );
    expect(filtered).toContain(A_WON);
    expect(filtered).not.toContain(A_LOST);
    expect(filtered).not.toContain(B_WON);
    // A subset of what the key read without the filter.
    expect(filtered.every((id) => unfiltered.includes(id))).toBe(true);
  });

  it("scope=all forwards the filter to every lens, inside the grant", async () => {
    const filtered = await ids(
      await get("pinned", list("&profileSlug=deal&scope=all", WON))
    );
    expect(filtered).toContain(A_WON);
    expect(filtered).not.toContain(A_LOST);
    expect(filtered).not.toContain(B_WON);
  });

  it("a core-field filter needs no profileSlug", async () => {
    expect(
      await ids(
        await get(
          "full",
          list("", [{ field: "type", operator: "equals", value: "nothing" }])
        )
      )
    ).toEqual([]);
  });
});

describe("GET /entities?filters= — refusals (400)", () => {
  it("an unknown property", async () => {
    expect(
      await refusal(
        await get(
          "pinned",
          list("&profileSlug=deal", [
            { field: "properties.nope", operator: "equals", value: "x" },
          ])
        )
      )
    ).toMatch(/Unknown property "nope"/);
  });

  it("a secret property, for every key", async () => {
    for (const key of ["pinned", "full"] as const) {
      expect(
        await refusal(
          await get(
            key,
            list("&profileSlug=deal", [
              {
                field: "properties.apiToken",
                operator: "equals",
                value: "s3cr3t",
              },
            ])
          )
        )
      ).toMatch(/secret/);
    }
  });

  it("more than 10 clauses", async () => {
    const eleven = Array.from({ length: 11 }, () => WON[0]);
    expect(
      await refusal(await get("full", list("&profileSlug=deal", eleven)))
    ).toMatch(/At most 10 filters/);
    // Ten is the cap, not over it.
    expect(
      await ids(await get("full", list("&profileSlug=deal", eleven.slice(1))))
    ).toEqual([A_WON, B_WON, POD_WON].sort());
  });

  it("a property filter without profileSlug", async () => {
    expect(await refusal(await get("full", list("", WON)))).toMatch(
      /needs profileSlug/
    );
  });

  it("malformed JSON and an unknown operator", async () => {
    expect(
      await refusal(await get("full", list("&profileSlug=deal", "[{")))
    ).toMatch(/JSON array/);
    expect(
      await refusal(
        await get(
          "full",
          list("&profileSlug=deal", [
            { field: "properties.stage", operator: "between", value: "a" },
          ])
        )
      )
    ).toMatch(/Invalid filters/);
  });

  it("filters with q", async () => {
    expect(
      await refusal(await get("full", list("&profileSlug=deal&q=d", WON)))
    ).toMatch(/filters cannot be combined with q/);
  });
});

describe("GET /entities?includeWorkspace=true — names only the rows' spaces", () => {
  type Row = { id: string; workspace?: { id: string; name: string } | null };

  it("a Sales-pinned key gets Sales on its rows and never learns Finance's name", async () => {
    const res = await get(
      "pinned",
      list("&profileSlug=deal&includeWorkspace=true")
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("Finance");
    const rows = JSON.parse(text) as Row[];
    const sales = rows.filter((r) => r.id === A_WON || r.id === A_LOST);
    expect(sales).toHaveLength(2);
    for (const r of sales) {
      expect(r.workspace).toEqual({ id: SALES, name: "Sales" });
    }
    for (const r of rows) expect(r).toHaveProperty("workspace");
  });

  it("control: a full-access key gets each row's own space, null when pod-wide", async () => {
    const res = await get(
      "full",
      list("&profileSlug=deal&includeWorkspace=true", WON)
    );
    const rows = (await res.json()) as Row[];
    const byId = new Map(rows.map((r) => [r.id, r.workspace]));
    expect(byId.get(A_WON)).toEqual({ id: SALES, name: "Sales" });
    expect(byId.get(B_WON)).toEqual({ id: FINANCE, name: "Finance" });
    expect(byId.get(POD_WON)).toBeNull();
  });

  it("without it, rows carry no workspace", async () => {
    const rows = (await (
      await get("full", list("&profileSlug=deal"))
    ).json()) as Row[];
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r).not.toHaveProperty("workspace");
  });

  it("includeWorkspace with q is a 400", async () => {
    expect(
      await refusal(
        await get("full", "/api/hub/entities?q=d&includeWorkspace=true")
      )
    ).toMatch(/includeWorkspace cannot be combined with q/);
  });
});
