/**
 * GET /entities?includeFacets=true — a pod-app reads each listed row's role
 * facets (a lead's `leadStage`) in ONE batched read, through the REAL hub auth
 * door (its fence + `runWithGrant`), the REAL route, the REAL `getCaller` → hub
 * `entities.getEntities` → `entities.list` → `toApiEntitiesWithFacetRows`, and
 * the REAL facet lens, compiled and run as SQL on PGlite. Only the key lookup
 * (`apiKeyService`) and the guest check are stubbed; each key's grant is a
 * real `grants` row.
 *
 * Rows rule out: a default response that starts carrying facets (the list
 * annotates `facetSlugs` on every call; only an asking caller may see them), a
 * flag the Hub forwarder strips (zod whitelists its input), a branch that drops
 * the flag (single workspace, facetSlug, scope=all), a scope=all merge that
 * keeps only the first lens's facets of a pod-wide row, a per-row facet load,
 * and a space-limited key that reads more facets than a member of its spaces:
 * one stamped in another space, or a pod-wide one whose role is granted only
 * to another space (the facet loaders read with raw `db`, so the grant seam
 * never reached them). Stacked on the space reach (be-reach): the key's rows
 * include the pod-wide people wearing a role in its space.
 *
 * Cannot see: production Postgres (no FKs/enums/defaults here), Typesense.
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
  loadFacetRowsBatch: vi.fn(),
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const schema = await import("@synap/database/schema");
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema });
  h.loadFacetRowsBatch.mockImplementation(
    actual.loadFacetRowsBatch as (...a: unknown[]) => unknown
  );
  return {
    ...actual,
    db,
    getDb: async () => db,
    loadFacetRowsBatch: h.loadFacetRowsBatch,
  };
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
const CRM = randomUUID(); // inserted first: scope=all reads it first
const OTHER = randomUUID();
const PERSON = randomUUID(); // kind profile
const LEAD = randomUUID(); // shared role granted to CRM: facets stored pod-wide (NULL)
const INVESTOR = randomUUID(); // shared role granted to OTHER only: facets NULL
const HOT = randomUUID(); // CRM's own role: facets stamped CRM
const VIP = randomUUID(); // OTHER's own role: facets stamped OTHER
const IN_CRM = randomUUID(); // CRM person: lead (NULL) + vip (OTHER) + investor (NULL)
const PLAIN = randomUUID(); // CRM person wearing no role
const POD_WIDE = randomUUID(); // pod-wide person: lead (NULL) + hot (CRM) + vip (OTHER)
const IN_CRM_LEAD = randomUUID(); // facet ids
const POD_WIDE_LEAD = randomUUID();

const KEYS = {
  full: { id: randomUUID(), permissions: ["*"], workspaceIds: null },
  space: {
    id: randomUUID(),
    permissions: ["entity.*.read"],
    workspaceIds: [CRM],
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
  for (const [id, slug, kind, scope, ws] of [
    [PERSON, "person", "kind", "system", null],
    [LEAD, "lead", "role", "shared", null],
    [INVESTOR, "investor", "role", "shared", null],
    [HOT, "hot", "role", "workspace", CRM],
    [VIP, "vip", "role", "workspace", OTHER],
  ] as const) {
    await q(
      `insert into profiles (id, slug, display_name, profile_kind, scope, entity_scope, is_active, ui_hints, workspace_id)
       values ($1,$2,$2,$3,$4,'workspace',true,'{}'::jsonb,$5)`,
      [id, slug, kind, scope, ws]
    );
  }
  for (const [role, ws] of [
    [LEAD, CRM],
    [INVESTOR, OTHER],
  ] as const) {
    await q(
      `insert into profile_workspace_access (profile_id, workspace_id) values ($1,$2)`,
      [role, ws]
    );
  }
  for (const [id, ws] of [
    [IN_CRM, CRM],
    [PLAIN, CRM],
    [POD_WIDE, null],
  ] as const) {
    await q(
      `insert into entities (id, user_id, workspace_id, profile_id, type, title, properties, system_data)
       values ($1,$2,$3,$4,'person','p','{}'::jsonb,'{}'::jsonb)`,
      [id, OWNER, ws, PERSON]
    );
  }
  for (const [id, entity, role, ws, status, props] of [
    [IN_CRM_LEAD, IN_CRM, LEAD, null, "active", { leadStage: "prospect" }],
    [randomUUID(), IN_CRM, VIP, OTHER, null, {}],
    [randomUUID(), IN_CRM, INVESTOR, null, null, { ticket: 50000 }],
    [POD_WIDE_LEAD, POD_WIDE, LEAD, null, "active", { leadStage: "qualified" }],
    [randomUUID(), POD_WIDE, HOT, CRM, null, {}],
    [randomUUID(), POD_WIDE, VIP, OTHER, null, {}],
  ] as const) {
    await q(
      `insert into entity_facets (id, entity_id, profile_id, user_id, workspace_id, status, properties, metadata)
       values ($1,$2,$3,$4,$5,$6,$7::jsonb,'{}'::jsonb)`,
      [id, entity, role, OWNER, ws, status, JSON.stringify(props)]
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
  h.loadFacetRowsBatch.mockClear();
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

type Row = {
  id: string;
  facetSlugs?: string[];
  facets?: Array<{
    facetId: string;
    slug: string;
    properties: Record<string, unknown>;
    status: string | null;
  }>;
};

async function list(key: KeyName, query: string): Promise<Row[]> {
  const res = await app().request(`/api/hub/entities?limit=50&${query}`, {
    headers: { authorization: `Bearer synap_${key}` },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Row[];
}

const byId = (rows: Row[]) => new Map(rows.map((r) => [r.id, r]));
const slugsOf = (row: Row | undefined) => [...(row?.facetSlugs ?? [])].sort();

describe("GET /entities — the default response carries no facets", () => {
  it("rows wearing roles come back without facetSlugs/facets, as before", async () => {
    const rows = await list("full", `workspaceId=${CRM}`);
    expect(rows.map((r) => r.id).sort()).toEqual(
      [IN_CRM, PLAIN, POD_WIDE].sort()
    );
    for (const row of rows) {
      expect(row).not.toHaveProperty("facetSlugs");
      expect(row).not.toHaveProperty("facets");
    }
    expect(h.loadFacetRowsBatch).not.toHaveBeenCalled();
  });

  it("includeFacets=false answers the default body exactly", async () => {
    expect(
      await list("full", `workspaceId=${CRM}&includeFacets=false`)
    ).toEqual(await list("full", `workspaceId=${CRM}`));
  });
});

describe("GET /entities?includeFacets=true — each row wears its role facets", () => {
  it("a workspace lens: the tRPC shape, only on rows wearing a role, under that lens", async () => {
    const rows = byId(
      await list("full", `workspaceId=${CRM}&includeFacets=true`)
    );
    // vip is stamped in OTHER: not in the CRM lens. investor is pod-wide and
    // the person owns it: in every lens.
    expect(slugsOf(rows.get(IN_CRM))).toEqual(["investor", "lead"]);
    expect(rows.get(IN_CRM)!.facets!.find((f) => f.slug === "lead")).toEqual({
      facetId: IN_CRM_LEAD,
      slug: "lead",
      properties: { leadStage: "prospect" },
      status: "active",
    });
    expect(slugsOf(rows.get(POD_WIDE))).toEqual(["hot", "lead"]);
    expect(rows.get(PLAIN)).not.toHaveProperty("facetSlugs");
    expect(rows.get(PLAIN)).not.toHaveProperty("facets");
  });

  it("one batched facet load for the page, never one per row", async () => {
    const rows = await list("full", `workspaceId=${CRM}&includeFacets=true`);
    expect(h.loadFacetRowsBatch).toHaveBeenCalledTimes(1);
    const loadedIds = h.loadFacetRowsBatch.mock.calls[0]![1] as string[];
    expect(loadedIds).toEqual(expect.arrayContaining(rows.map((r) => r.id)));
  });

  it("facetSlug=lead returns the lead overlay (leadStage) on each lead, pod-wide rows included", async () => {
    const rows = await list("full", "facetSlug=lead&includeFacets=true");
    expect(rows.map((r) => r.id).sort()).toEqual([IN_CRM, POD_WIDE].sort());
    const lead = (r: Row | undefined) =>
      r?.facets?.find((f) => f.slug === "lead");
    const m = byId(rows);
    expect(lead(m.get(IN_CRM))).toEqual({
      facetId: IN_CRM_LEAD,
      slug: "lead",
      properties: { leadStage: "prospect" },
      status: "active",
    });
    expect(lead(m.get(POD_WIDE))).toEqual({
      facetId: POD_WIDE_LEAD,
      slug: "lead",
      properties: { leadStage: "qualified" },
      status: "active",
    });
  });

  it("no lens: the user floor's facets (every readable space)", async () => {
    const m = byId(await list("full", "includeFacets=true"));
    expect(slugsOf(m.get(IN_CRM))).toEqual(["investor", "lead", "vip"]);
    expect(slugsOf(m.get(POD_WIDE))).toEqual(["hot", "lead", "vip"]);
  });

  it("scope=all: a pod-wide row read by several lenses wears the union of their facets", async () => {
    const rows = await list("full", "scope=all&includeFacets=true");
    const m = byId(rows);
    expect(rows.filter((r) => r.id === POD_WIDE)).toHaveLength(1);
    expect(slugsOf(m.get(POD_WIDE))).toEqual(["hot", "lead", "vip"]);
    expect(
      m
        .get(POD_WIDE)!
        .facets!.map((f) => f.slug)
        .sort()
    ).toEqual(["hot", "lead", "vip"]);
    expect(m.get(PLAIN)).not.toHaveProperty("facets");
  });

  it("with q: a 400, never a search silently answered without facets", async () => {
    const res = await app().request(
      "/api/hub/entities?q=p&includeFacets=true",
      { headers: { authorization: "Bearer synap_full" } }
    );
    expect(res.status).toBe(400);
  });
});

// A key granted CRM reads what a MEMBER of CRM reads (founder "option 1",
// be-reach): its rows include the pod-wide people wearing a role in CRM, and
// its facets are the ones stamped in CRM or pod-wide with a role granted to
// CRM — never vip (stamped OTHER) nor investor (a role granted to OTHER only).
describe("GET /entities?includeFacets=true — a space-limited key sees only its spaces' facets", () => {
  it("control: the full-access key sees the facets of OTHER (vip, investor)", async () => {
    const m = byId(await list("full", "includeFacets=true"));
    expect(slugsOf(m.get(IN_CRM))).toEqual(["investor", "lead", "vip"]);
  });

  it("a key granted CRM never sees a facet stamped in OTHER", async () => {
    const rows = await list("space", "includeFacets=true");
    const m = byId(rows);
    expect(m.get(IN_CRM)).toMatchObject({
      facetSlugs: ["lead"],
      facets: [{ slug: "lead", properties: { leadStage: "prospect" } }],
    });
    for (const row of rows) {
      expect(row.facetSlugs ?? []).not.toContain("vip");
      expect(row.facetSlugs ?? []).not.toContain("investor");
    }
  });

  it("a pod-wide row the space reach admits wears its CRM facets, never OTHER's", async () => {
    const m = byId(await list("space", "includeFacets=true"));
    expect(slugsOf(m.get(POD_WIDE))).toEqual(["hot", "lead"]);
    expect(
      m.get(POD_WIDE)!.facets!.find((f) => f.slug === "lead")!.properties
    ).toEqual({ leadStage: "qualified" });
  });

  it("the same with the CRM lens, facetSlug=lead and scope=all", async () => {
    for (const query of [
      `workspaceId=${CRM}&includeFacets=true`,
      "facetSlug=lead&includeFacets=true",
      "scope=all&includeFacets=true",
    ]) {
      const m = byId(await list("space", query));
      expect(slugsOf(m.get(IN_CRM))).toEqual(["lead"]);
      expect(slugsOf(m.get(POD_WIDE))).toEqual(["hot", "lead"]);
    }
  });
});
