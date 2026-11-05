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
 * through the seamed `entities.getEntities`. It is listed now.
 *
 * `q` (finding cce86e6b, Raycast's Search Synap): Typesense ranks every match
 * the PERSON may see; `search.search` then re-reads the hits through the
 * entity floor with the key's grant ANDed (`withinGrantSearchHits`), so a
 * fenced key gets only in-grant hits, in relevance order. Typesense is mocked
 * at its boundary (`searchService.search`); everything after it is real: the
 * hub `search.search` procedure, the listing rule and the grant intersect,
 * compiled and run on PGlite.
 *
 * Rows rule out: listing the door without the seam narrowing (the control
 * shows the floor alone returns every row), a fence that sees only `/api/hub`
 * (alias rows), a search bound that skips a `*` pinned to a project, a bound
 * that loses relevance order, a bound that also re-reads (or widens) the
 * full-access answer, and a fenced search that does not widen its window.
 *
 * Cannot see: production Postgres, real Typesense ranking.
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
  search: vi.fn(),
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
// Typesense, at its boundary: it ranks what the PERSON may see, never the
// key's grant. Everything after it is real.
vi.mock("@synap/search", () => ({
  searchService: { search: (...a: unknown[]) => h.search(...a) },
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
import {
  GRANT_BOUNDED_SEARCH_WINDOW,
  registerEntitiesRoutes,
} from "./entities.js";
import { runWithGrant } from "@synap/database";
import { withinGrantSearchHits } from "../../../services/retrieval/grant-bounded-search-hits.js";
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

/**
 * Typesense's ranking: every row the person may see, out-of-grant rows ranked
 * FIRST and between, so a bound that keeps the wrong rows or loses the order
 * shows.
 */
const RANKED = [POD_OUT, IN_PROJECT, OUT_OF_PROJECT, POD_IN_PROJECT];
const hit = (id: string) => ({
  id,
  collection: "entities",
  document: { id, title: `n ${id}`, entityType: "note" },
  highlights: [{ field: "title", snippet: "<mark>n</mark>" }],
  textMatch: 1,
});

beforeEach(() => {
  h.search.mockReset();
  h.search.mockImplementation(async () => ({
    results: RANKED.map(hit),
    found: 42,
    searchTimeMs: 1,
    facetCounts: { entities: { "entityType.note": 42 } },
  }));
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

async function rankedIds(res: Response): Promise<string[]> {
  expect(res.status).toBe(200);
  return ((await res.json()) as Array<{ id: string }>).map((r) => r.id);
}

describe("GET /entities?q= — search is bounded by the key's grant", () => {
  for (const mount of ["/api/hub", "/api/hub-protocol"]) {
    it(`a project-limited key gets only in-grant hits, in relevance order (${mount})`, async () => {
      expect(
        await rankedIds(await get("project", `${mount}/entities?q=note`))
      ).toEqual([IN_PROJECT, POD_IN_PROJECT]);
    });
  }

  it("a `*` pinned to the project is bounded too (pinned is fenced)", async () => {
    expect(
      await rankedIds(await get("pinnedStar", "/api/hub/entities?q=note"))
    ).toEqual([IN_PROJECT, POD_IN_PROJECT]);
  });

  it("a fenced key ranks a wider window, then cuts to `limit` after the bound", async () => {
    expect(
      await rankedIds(await get("project", "/api/hub/entities?q=note&limit=1"))
    ).toEqual([IN_PROJECT]);
    expect(h.search).toHaveBeenCalledTimes(1);
    expect(h.search.mock.calls[0]![0]).toMatchObject({
      limit: GRANT_BOUNDED_SEARCH_WINDOW,
    });
  });

  it("control: an unbounded full-access key is answered unchanged (every hit, Typesense's order, its own limit)", async () => {
    expect(
      await rankedIds(await get("full", "/api/hub/entities?q=note&limit=7"))
    ).toEqual(RANKED);
    expect(h.search.mock.calls[0]![0]).toMatchObject({ limit: 7 });
  });
});

describe("withinGrantSearchHits — what a fenced key never sees", () => {
  const response = () => ({
    results: [
      ...RANKED.map(hit),
      { id: "d1", collection: "documents", document: { id: "d1" } },
    ],
    found: 42,
    facetCounts: { entities: { "entityType.note": 42 } },
  });
  const projectGrant = {
    scopes: [{ permissions: ["entity.*.read"], projectIds: [PROJECT] }],
    clientId: null,
  };

  it("drops out-of-grant and non-entity hits, the person-wide count and the facets", async () => {
    const out = await runWithGrant(projectGrant, () =>
      withinGrantSearchHits(response(), OWNER)
    );
    expect(out.results.map((r) => r.id)).toEqual([IN_PROJECT, POD_IN_PROJECT]);
    expect(out.found).toBe(2);
    expect(out.facetCounts).toBeUndefined();
    expect(out.boundedByGrant).toBe(true);
  });

  it("control: no grant (and the full `*`) returns the response untouched", async () => {
    const r = response();
    expect(await withinGrantSearchHits(r, OWNER)).toBe(r);
    const full = { scopes: [{ permissions: ["*"] }], clientId: null };
    expect(
      await runWithGrant(full, () => withinGrantSearchHits(r, OWNER))
    ).toBe(r);
  });
});
