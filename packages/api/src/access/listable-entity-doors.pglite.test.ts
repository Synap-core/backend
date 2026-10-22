/**
 * THE LISTING RULE reaches every listing door (FB1020 B5).
 *
 * `listableEntityWhere` (@synap/database utils/listable-entity.ts) leaves two
 * kinds of rows out of every list, count and search: probe-key rows (D8) and
 * SAMPLE (demo) rows — an entity filed into, or the subject of, a project with
 * `projects.sample`, and in no real project. The project lens is the toggle:
 * lensed on the demo project, its rows show. By-id reads stay open.
 *
 * DERIVED, BEHAVIOURAL — three nets:
 *
 *  1. Every QUERY procedure of the served `entitiesRouter` (read from
 *     `_def.procedures`, filtered on `_def.type`, never hand-listed) must be
 *     CLASSIFIED: a LISTING door with a fixture that is CALLED on PGlite
 *     through the real procedure, or WITHHELD with the reason it is not a
 *     listing. A new query procedure fails here until someone decides.
 *  2. Named behavioural checks for the doors outside that router the founder
 *     named: views (`views.execute`, the CRM lists), raw search hits (relay
 *     phone search, Hub search), the automation matcher's sample fact, and the
 *     project update door that SETS the flag.
 *  3. A source scan over `packages/api/src` (globbed): every file that builds
 *     an entity read floor or calls raw search must either carry the listing
 *     rule or be WITHHELD here with a reason — so a new listing door in another
 *     file joins the scan by existing. The same scan runs over
 *     `packages/jobs/src` (automation steps, digests, scans), whose reads use
 *     their own floor (`entityQueryVisibilityWhere`) or a bare `.from(entities)`.
 *  2b. Behavioural checks for the doors FB1020 wave 2 named after the first
 *     cut: pickers (`entities.search/searchAll` + `projectId`), the outputs
 *     scan (Library › Landed, Home › Produced, a project's outputs), the Hub
 *     workspace digest + pod-wide count, the automation `query` step (+ a rule
 *     scoped to the demo project), and `revealSampleOf` itself.
 *
 * Fixture (the discriminating rows): REAL (no project), REAL_F (real project),
 * DOUBLE (real AND demo project — real membership wins, stays VISIBLE),
 * DEMO_F (filed into the demo project), DEMO_S (the demo project's SUBJECT
 * only — no filing edge, so a filing-only rule would miss it), PROBE
 * (probe-key row), REAL_P / DEMO_P (pod-personal twins for `listGlobal`).
 *
 * NOT COVERED (measured by reading, stated so nobody assumes it):
 *  - the jobs half of net 3 matches `.from(entities)` / `query.entities
 *    .findMany(` / `entityQueryVisibilityWhere(` only; a jobs read through a
 *    raw SQL string or a repository is not seen. FILE granularity, as below.
 *  - net 3 is FILE granularity: a file that already carries the rule at one
 *    door passes even if a second listing door in it does not; and a listing
 *    door that floors with a bare `eq(entities.userId, …)` is not matched by
 *    the floor regex (retrieve.ts `fetchOrdered` and graph `getStats` are such
 *    doors; both carry the rule today).
 *  - Typesense itself is not run: raw hits are hand-built here and only the
 *    database intersect (`withoutUnlistableEntityHits`) is real.
 *  - Production Postgres plans (the rule is uncorrelated subqueries; sizes on
 *    a real pod are not measured here).
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const schema = await import("@synap/database/schema");
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema });
  h.db = db;
  return {
    ...actual,
    db,
    getDb: async () => db,
    eventRepository: {
      append: async () => undefined,
      emitCompleted: async () => undefined,
    },
    EventRepository: class {
      async append() {
        return undefined;
      }
    },
  };
});
vi.mock("../utils/audit-log.js", () => ({ auditLog: vi.fn() }));
vi.mock("../utils/split-brain-service.js", () => ({
  isPodReadOnly: vi.fn().mockResolvedValue(false),
}));
vi.mock("@synap/events", () => ({
  emitSideEffects: async () => {},
  getBoss: () => ({ send: async () => null }),
}));
// The project update door is governed by the one gate; the gate itself is
// not under test here (a human owner write is granted).
vi.mock("../utils/permission-check.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  checkPermissionOrPropose: async () => ({ granted: true }),
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import {
  classifySampleMembership,
  sampleEntityWhere,
  sampleProjectIdsOfEntity,
} from "@synap/database";
import { entities } from "@synap/database/schema";
import { and, inArray } from "drizzle-orm";
import { entitiesRouter } from "../routers/entities.js";
import { viewsRouter } from "../routers/views.js";
import { projectsRouter } from "../routers/projects.js";
import { withoutUnlistableEntityHits } from "../services/retrieval/listable-search-hits.js";
import {
  matchRuleScopeFilters,
  resolveEventProjectIds,
  resolveEventSampleProjectIds,
} from "@synap/jobs/workers/automation-trigger-matcher.js";

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
          : // Literal defaults (e.g. `entities.version` = 1): without them a
            // seeded row is NULL where a real one never is, and an output
            // schema (EntitySchema.version: number) rejects the listing.
            typeof c.default === "number" || typeof c.default === "boolean"
            ? ` default ${c.default}`
            : "";
    return `"${c.name}" ${type}${pk}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const A = randomUUID();
const W = randomUUID();
const DEAL = randomUUID(); // kind
const CLIENT = randomUUID(); // role
const REAL_PROJ = randomUUID();
const DEMO_PROJ = randomUUID();
const VIEW = randomUUID();

const REAL = randomUUID();
const REAL_F = randomUUID();
const DOUBLE = randomUUID();
const DEMO_F = randomUUID();
const DEMO_S = randomUUID();
const PROBE = randomUUID();
const REAL_P = randomUUID();
const DEMO_P = randomUUID();

const SEEDED = [REAL, REAL_F, DOUBLE, DEMO_F, DEMO_S, PROBE, REAL_P, DEMO_P];
const VISIBLE = new Set([REAL, REAL_F, DOUBLE, REAL_P]);
const HIDDEN = new Set([DEMO_F, DEMO_S, PROBE, DEMO_P]);
/** Members of the demo project (filed) — what its lens must show. */
const DEMO_MEMBERS = new Set([DEMO_F, DOUBLE, DEMO_P]);

const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);

type Caller = Record<string, (input?: unknown) => Promise<unknown>>;
const podCtx = { authenticated: true, userId: A, workspaceId: null };
const wsCtx = { authenticated: true, userId: A, workspaceId: W };
const entitiesCaller = (ctx = podCtx) =>
  entitiesRouter.createCaller(ctx as never) as unknown as Caller;

function idsOf(rows: unknown): string[] {
  const list = Array.isArray(rows)
    ? rows
    : ((rows as { items?: unknown[]; entities?: unknown[] }).items ??
      (rows as { entities?: unknown[] }).entities ??
      []);
  return (list as Array<{ id: string }>)
    .map((r) => r.id)
    .filter((id) => SEEDED.includes(id));
}

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));

  await q(`insert into users (id, email) values ($1, $2)`, [
    A,
    `${A}@example.test`,
  ]);
  await q(
    `insert into workspaces (id, name, owner_id, settings) values ($1,'w',$2,'{}'::jsonb)`,
    [W, A]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
    [randomUUID(), W, A]
  );
  await q(
    `insert into profiles (id, slug, display_name, profile_kind, scope, entity_scope, is_active, ui_hints, workspace_id)
     values ($1,'deal','Deal','kind','system','workspace',true,'{}'::jsonb,null),
            ($2,'client','Client','role','workspace','workspace',true,'{}'::jsonb,$3)`,
    [DEAL, CLIENT, W]
  );
  for (const [id, sample] of [
    [REAL_PROJ, false],
    [DEMO_PROJ, true],
  ] as const) {
    await q(
      `insert into projects (id, user_id, workspace_id, name, status, sample, settings, metadata)
       values ($1,$2,$3,$4,'active',$5,'{}'::jsonb,'{}'::jsonb)`,
      [id, A, W, sample ? "Demo" : "Real", sample]
    );
  }
  const entity = async (
    id: string,
    ws: string | null,
    systemData: Record<string, unknown> = {}
  ) => {
    await q(
      `insert into entities (id, user_id, workspace_id, profile_id, type, title, properties, system_data)
       values ($1,$2,$3,$4,'deal','Deal row','{}'::jsonb,$5::jsonb)`,
      [id, A, ws, DEAL, JSON.stringify(systemData)]
    );
    if (ws) {
      await q(
        `insert into entity_facets (id, entity_id, profile_id, user_id, workspace_id, status, properties, metadata)
         values ($1,$2,$3,$4,$5,'active','{}'::jsonb,'{}'::jsonb)`,
        [randomUUID(), id, CLIENT, A, ws]
      );
    }
  };
  const file = async (entityId: string, projectId: string) =>
    q(
      `insert into relations (id, user_id, workspace_id, source_entity_id, target_entity_id, type)
       values ($1,$2,$3,$4,$5,'belongs_to_project')`,
      [randomUUID(), A, W, entityId, projectId]
    );
  for (const id of [REAL, REAL_F, DOUBLE, DEMO_F, DEMO_S]) await entity(id, W);
  await entity(PROBE, W, { probe: true });
  await entity(REAL_P, null);
  await entity(DEMO_P, null);
  await file(REAL_F, REAL_PROJ);
  await file(DOUBLE, REAL_PROJ);
  await file(DOUBLE, DEMO_PROJ);
  await file(DEMO_F, DEMO_PROJ);
  await file(DEMO_P, DEMO_PROJ);
  // The demo project's SUBJECT — a links edge, not a filing.
  await q(
    `insert into links (id, workspace_id, from_type, from_id, to_type, to_id, link_type, metadata)
     values ($1,$2,'project',$3,'entity',$4,'targets','{}'::jsonb)`,
    [randomUUID(), W, DEMO_PROJ, DEMO_S]
  );
  await q(
    `insert into views (id, user_id, workspace_id, type, name, scope_profile_ids, query, config)
     values ($1,$2,$3,'table','Deals',ARRAY[$4]::uuid[],'{}'::jsonb,'{}'::jsonb)`,
    [VIEW, A, W, DEAL]
  );
}, 120_000);

// ── Net 1: every query procedure of the entities router ───────────────────

type Fixture =
  | {
      ids: (c: Caller) => Promise<unknown>;
      lensed?: (c: Caller) => Promise<unknown>;
    }
  | { count: (c: Caller) => Promise<number>; expected: number };

/** LISTING doors, each with the call that exercises it. */
const LISTING: Record<string, Fixture> = {
  list: {
    ids: (c) => c.list!({ limit: 50 }),
    lensed: (c) => c.list!({ limit: 50, projectId: DEMO_PROJ }),
  },
  listMulti: {
    ids: (c) => c.listMulti!({ includeGlobal: true, limit: 50 }),
    lensed: (c) =>
      c.listMulti!({ includeGlobal: true, limit: 50, projectId: DEMO_PROJ }),
  },
  listGlobal: { ids: (c) => c.listGlobal!({ limit: 50 }) },
  search: { ids: (c) => c.search!({ query: "Deal", limit: 50 }) },
  searchAll: { ids: (c) => c.searchAll!({ query: "Deal", limit: 50 }) },
  groupByFacetStatus: {
    ids: async (c) => {
      const r = (await c.groupByFacetStatus!({
        roleSlug: "client",
        firstN: 50,
      })) as { groups: Array<{ ids: string[] }> };
      return r.groups.flatMap((g) => g.ids.map((id) => ({ id })));
    },
    lensed: async (c) => {
      const r = (await c.groupByFacetStatus!({
        roleSlug: "client",
        firstN: 50,
        projectId: DEMO_PROJ,
      })) as { groups: Array<{ ids: string[] }> };
      return r.groups.flatMap((g) => g.ids.map((id) => ({ id })));
    },
  },
  // Counts: REAL, REAL_F, DOUBLE, REAL_P are deals (4); the role half counts
  // the three visible facet wearers in W.
  countByProfile: {
    count: async () => {
      const r = (await entitiesCaller(wsCtx as never).countByProfile!()) as {
        counts: Record<string, number>;
      };
      return (r.counts.deal ?? 0) * 10 + (r.counts.client ?? 0);
    },
    expected: 43,
  },
  countByProfileAll: {
    count: async (c) => {
      const r = (await c.countByProfileAll!({})) as {
        counts: Record<string, number>;
      };
      return (r.counts.deal ?? 0) * 10 + (r.counts.client ?? 0);
    },
    expected: 43,
  },
  // Not in a project: REAL and REAL_P. DEMO_S is in no filing (only a subject
  // link), so only the sample half of the rule keeps it out of this inbox.
  countWithoutProject: {
    count: async (c) =>
      ((await c.countWithoutProject!()) as { total: number }).total,
    expected: 2,
  },
};

/** Query procedures that are NOT listings — each with the reason. */
const WITHHELD: Record<string, string> = {
  get: "by id — a demo record stays openable",
  getByDocumentId: "by id (reverse lookup from a document)",
  adminGet: "by id (operator)",
  adminList:
    "operator data tool: shows every row, probe and demo included, so they can be inspected and deleted",
  adminListProfiles: "lists profiles, not entities",
  listSavedUrls:
    "the browser's saved-URL dedup index: a saved demo page must still read as saved (dedup, not a listing)",
};

type AnyProcedure = { _def: { type?: string } };
const queries = Object.entries(
  entitiesRouter._def.procedures as unknown as Record<string, AnyProcedure>
)
  .filter(([, p]) => p._def.type === "query")
  .map(([path]) => path)
  .sort();

describe("net 1 — every entities query procedure is classified", () => {
  it("the derived set is plausible (non-vacuity)", () => {
    expect(queries.length).toBeGreaterThanOrEqual(10);
    expect(queries).toContain("list");
    expect(queries).toContain("countByProfile");
  });

  it("each query is a LISTING door or WITHHELD, never both, never neither", () => {
    const unclassified = queries.filter(
      (p) => !(p in LISTING) && !(p in WITHHELD)
    );
    const both = queries.filter((p) => p in LISTING && p in WITHHELD);
    const stale = [...Object.keys(LISTING), ...Object.keys(WITHHELD)].filter(
      (p) => !queries.includes(p)
    );
    expect({ unclassified, both, stale }).toEqual({
      unclassified: [],
      both: [],
      stale: [],
    });
  });

  for (const [path, fx] of Object.entries(LISTING)) {
    if ("count" in fx) {
      it(`${path}: counts leave demo and probe rows out`, async () => {
        expect(await fx.count(entitiesCaller())).toBe(fx.expected);
      });
      continue;
    }
    it(`${path}: lists no demo or probe row, keeps the double-filed one`, async () => {
      const ids = idsOf(await fx.ids(entitiesCaller()));
      expect(ids.filter((id) => HIDDEN.has(id))).toEqual([]);
      // Non-vacuity: the door returned real rows, incl. the double-filed one
      // (real membership wins) wherever the door's scope can see it.
      expect(ids.some((id) => VISIBLE.has(id))).toBe(true);
      if (path !== "listGlobal") expect(ids).toContain(DOUBLE);
    });
    if (fx.lensed) {
      it(`${path}: the demo project lens shows the demo`, async () => {
        const ids = idsOf(await fx.lensed!(entitiesCaller()));
        expect(ids).toContain(DEMO_F);
        expect(ids).not.toContain(PROBE);
        for (const id of ids) expect(DEMO_MEMBERS.has(id)).toBe(true);
      });
    }
  }
});

// ── Net 2: the named doors outside the entities router ────────────────────

describe("net 2 — views, raw search, matcher, the update door", () => {
  const viewsCaller = () =>
    viewsRouter.createCaller(podCtx as never) as unknown as Caller;

  it("views.execute (CRM lists, boards, dashboards) leaves demo rows out", async () => {
    const ids = idsOf(await viewsCaller().execute!({ id: VIEW }));
    expect(ids.filter((id) => HIDDEN.has(id))).toEqual([]);
    expect(ids).toContain(REAL);
    expect(ids).toContain(DOUBLE);
  });

  it("views.execute lensed on the demo project shows it", async () => {
    const ids = idsOf(
      await viewsCaller().execute!({ id: VIEW, projectId: DEMO_PROJ })
    );
    expect(ids).toContain(DEMO_F);
    expect(ids).not.toContain(REAL);
  });

  it("raw search hits (relay phone search, Hub search) drop demo and probe", async () => {
    const hit = (id: string) => ({
      id,
      collection: "entities",
      document: { id },
      textMatch: 1,
    });
    const doc = {
      id: "d1",
      collection: "documents",
      document: {},
      textMatch: 1,
    };
    const res = await withoutUnlistableEntityHits({
      results: [...SEEDED.map(hit), doc, hit("not-a-uuid")],
      found: SEEDED.length + 2,
      searchTimeMs: 1,
    });
    const kept = res.results.map((r) => r.id);
    expect(new Set(kept)).toEqual(new Set([...VISIBLE, "d1"]));
    expect(res.hiddenFromListing).toBe(5);
    expect(res.found).toBe(SEEDED.length + 2 - 5);
  });

  it("the SQL rule and the per-entity read agree on every seeded row", async () => {
    const db = h.db as {
      select: (c: unknown) => {
        from: (t: unknown) => {
          where: (w: unknown) => Promise<Array<{ id: string }>>;
        };
      };
    };
    const sqlSample = new Set(
      (
        await db
          .select({ id: entities.id })
          .from(entities)
          .where(and(inArray(entities.id, SEEDED), sampleEntityWhere()))
      ).map((r) => r.id)
    );
    for (const id of SEEDED) {
      const viaRead = await sampleProjectIdsOfEntity(h.db as never, id);
      expect([id, viaRead.size > 0]).toEqual([id, sqlSample.has(id)]);
    }
    expect(sqlSample).toEqual(new Set([DEMO_F, DEMO_S, DEMO_P]));
    expect(classifySampleMembership([])).toEqual(new Set());
  });

  it("matcher: a demo record fires only a rule scoped to the demo project", async () => {
    const decide = async (entityId: string, projectId?: string) => {
      const eventType = "entity.updated";
      return matchRuleScopeFilters(
        eventType,
        {
          eventPattern: "entity.*",
          ...(projectId ? { projectId } : {}),
        } as never,
        {
          entityId,
          projectIds: await resolveEventProjectIds({
            eventType,
            subjectId: entityId,
            data: {},
            entityId,
          }),
          sampleProjectIds: await resolveEventSampleProjectIds(
            eventType,
            entityId
          ),
        }
      );
    };
    // The "Win a deal" shape: an unscoped rule.
    expect(await decide(DEMO_F)).toBe(false);
    expect(await decide(DEMO_S)).toBe(false);
    expect(await decide(REAL)).toBe(true);
    expect(await decide(DOUBLE)).toBe(true);
    // A rule built for the demo still works in a live demo.
    expect(await decide(DEMO_F, DEMO_PROJ)).toBe(true);
    // ...and a real project's rule never fires on demo data.
    expect(await decide(DEMO_F, REAL_PROJ)).toBe(false);
  });

  it("projects.update sets the flag; listings follow it both ways", async () => {
    const projects = projectsRouter.createCaller(
      podCtx as never
    ) as unknown as Caller;
    const listed = async () =>
      idsOf(await entitiesCaller().list!({ limit: 50 }));

    expect(await projects.update!({ id: REAL_PROJ, sample: true })).toEqual({
      status: "updated",
    });
    const flipped = await listed();
    expect(flipped).not.toContain(REAL_F);
    expect(flipped).not.toContain(DOUBLE); // both its projects are demo now
    expect(flipped).toContain(REAL);

    await projects.update!({ id: REAL_PROJ, sample: false });
    const back = await listed();
    expect(back).toContain(REAL_F);
    expect(back).toContain(DOUBLE);
  });
});

// ── Net 2b: pickers, outputs, Hub digest + pod count, the query step ──────

describe("net 2b — the doors named after the first cut", () => {
  it("revealSampleOf lists ONE project's demo rows beside the real ones, never probe", async () => {
    const db = h.db as {
      select: (c: unknown) => {
        from: (t: unknown) => {
          where: (w: unknown) => Promise<Array<{ id: string }>>;
        };
      };
    };
    const { listableEntityWhere } = await import("@synap/database");
    const read = async (reveal: string | null) =>
      new Set(
        (
          await db
            .select({ id: entities.id })
            .from(entities)
            .where(
              and(
                inArray(entities.id, SEEDED),
                listableEntityWhere({ revealSampleOf: reveal })
              )
            )
        ).map((r) => r.id)
      );
    expect(await read(DEMO_PROJ)).toEqual(
      new Set([...VISIBLE, DEMO_F, DEMO_S, DEMO_P])
    );
    // A real project reveals nothing; a non-uuid is ignored, never an error.
    expect(await read(REAL_PROJ)).toEqual(VISIBLE);
    expect(await read("not-a-uuid")).toEqual(VISIBLE);
    expect(await read(null)).toEqual(VISIBLE);
  });

  for (const door of ["search", "searchAll"] as const) {
    it(`${door} (pickers) in the demo project's lens finds its demo records`, async () => {
      const ids = idsOf(
        await entitiesCaller()[door]!({
          query: "Deal",
          limit: 50,
          projectId: DEMO_PROJ,
        })
      );
      expect(ids).toContain(DEMO_F);
      expect(ids).toContain(REAL);
      expect(ids).not.toContain(PROBE);
    });
  }

  it("the outputs scan (Landed, Home Produced, project outputs) drops demo + probe; the lens shows the demo", async () => {
    const { scanSessionOutputs } =
      await import("../services/projects/project-outputs.js");
    const { focusSessions } = schema;
    const { eq } = await import("drizzle-orm");
    const S = randomUUID();
    await q(
      `insert into focus_sessions (id, user_id, workspace_id, goal, status, expected_outputs, metadata, started_at, updated_at, created_at)
       values ($1,$2,$3,'g','active','[]'::jsonb,'{}'::jsonb, now(), now(), now())`,
      [S, A, W]
    );
    for (const id of [REAL, DEMO_F, PROBE]) {
      await q(
        `insert into links (id, workspace_id, from_type, from_id, to_type, to_id, link_type, metadata, created_at)
         values ($1,$2,'session',$3,'entity',$4,'produced','{}'::jsonb, now())`,
        [randomUUID(), W, S, id]
      );
    }
    const refs = async (projectLens?: string) =>
      (
        await scanSessionOutputs(
          h.db as never,
          [eq(focusSessions.id, S)],
          projectLens ? { projectLens } : {}
        )
      ).items
        .filter((i) => i.kind === "entity")
        .map((i) => i.ref.id)
        .sort();
    // Non-vacuity: the scan reads the real row at all.
    expect(await refs()).toEqual([REAL]);
    expect(await refs(DEMO_PROJ)).toEqual([REAL, DEMO_F].sort());
  });

  it("Hub GET /workspaces/:id/digest neither counts nor names demo or probe rows", async () => {
    const { OpenAPIHono } = await import("@hono/zod-openapi");
    const { registerWorkspacesRoutes } =
      await import("../routers/hub-protocol/rest/workspaces.js");
    const app = new OpenAPIHono();
    app.use("*", async (c, next) => {
      c.set("userId" as never, A as never);
      c.set("scopes" as never, ["hub-protocol.read"] as never);
      await next();
    });
    registerWorkspacesRoutes(app as never);
    const res = await app.request(`/workspaces/${W}/digest`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      counts: Record<string, number>;
      keyEntities: Array<{ id: string }>;
    };
    // W's deals: REAL, REAL_F, DOUBLE listable; DEMO_F, DEMO_S, PROBE not.
    expect(body.counts.deal).toBe(3);
    const named = body.keyEntities.map((e) => e.id);
    expect(named.filter((id) => HIDDEN.has(id))).toEqual([]);
    expect(named).toContain(DOUBLE);

    const list = await app.request(`/workspaces`);
    expect(list.status).toBe(200);
    // Pod-wide rows: REAL_P (real) and DEMO_P (demo).
    expect(
      ((await list.json()) as { podEntityCount: number }).podEntityCount
    ).toBe(1);
  });

  it("the automation query step leaves demo + probe out, unless the rule is scoped to the demo project", async () => {
    const { executeQueryStep } =
      await import("@synap/jobs/workers/steps/query.js");
    const context = {
      trigger: { payload: {}, subject: null },
      steps: {},
      automation: { id: "", state: {} },
    };
    const run = async (ruleProjectId?: string) =>
      idsOf(
        (await executeQueryStep(
          { profileSlug: "deal", limit: 100 },
          context as never,
          W,
          A,
          ruleProjectId ?? null
        )) as { entities: unknown[] }
      );
    const plain = await run();
    expect(plain.filter((id) => HIDDEN.has(id))).toEqual([]);
    expect(plain).toContain(REAL);
    const scoped = await run(DEMO_PROJ);
    expect(scoped).toContain(DEMO_F);
    expect(scoped).not.toContain(PROBE);
  });
});

// ── Net 3: every api file that builds an entity floor or searches raw ─────

const FLOOR_RE =
  /entityReadVisibleWhere\(|entityLensWhere\(|entityLensWhereForViews\(|\.predicate\(entities\)|entityWriteVisibleWhere\(|ownerPrivateVisibleWhere\(\s*entities\.workspaceId|accessScopeWhere\(\{[\s\S]{0,600}?entityIdColumn:\s*entities\.id|searchService\.search(?:Collection)?\(/;
const MARK_RE =
  /listableEntityWhere\(|unlistableEntityIds\(|withoutUnlistableEntityHits\(/;

/** Files that build an entity floor for something that is not a listing. */
const WITHHELD_FILES: Record<string, string> = {
  "access/entity-read-floor.ts": "defines the access floor (never filtered)",
  "access/registry.ts": "the entities VisibilityRule: by-id + writes too",
  "routers/artifacts.ts": "kind label for artifacts already listed",
  "routers/capture.ts": "searchCollection for capture dedup",
  "routers/channels/messaging.ts": "messages collection, not entities",
  "routers/entities.ts": "`get` — by id",
  "routers/entities/create.ts": "create: replay + identity dedup",
  "routers/entities/facets.ts": "facet writes: target gates",
  "routers/entities/mutate.ts": "write targets",
  "routers/hub-protocol/rest/identity.ts": "identity resolution (dedup)",
  "routers/hub-protocol/rest/knowledge.ts":
    "graph traversal FROM a seed object: its neighbours are part of opening it",
  "routers/hub-protocol/rest/link-endpoint-visibility.ts": "link write gate",
  "routers/hub-protocol/rest/messaging.ts": "one entity's conversation gate",
  "routers/mcp/handlers/capture.ts": "identity candidates (dedup)",
  "routers/mcp/handlers/entity.ts": "synap_resolve_identity (dedup)",
  "routers/playbooks.ts": "matchForEntity — reads one subject",
  "routers/projects.ts": "forEntity — one entity's projects",
  "routers/proposals/display.ts": "names entities on proposal cards",
  "routers/proposals/executors/entity.ts": "comment only",
  "routers/proposals/object-refs.ts": "resolves names of references",
  "routers/relations.ts":
    "a focal object's connections + relation write gates (opening it)",
  "routers/resource-state.ts": "the person's own pinned/recent items, by id",
  "routers/subscriptions.ts": "names subjects of reactions",
  "services/capabilities/builtin-verbs.ts": "searchCollection for dedup",
  "services/capabilities/capability-run-subject.ts": "proposal title",
  "services/capabilities/verb-write-back.ts": "write target",
  "services/entities/update-entities.ts": "batch-update targets",
  "services/entity-body/body-replace-guard.ts": "write target",
  "services/entity-body/promote-property-to-body.ts": "row lock for a write",
  "services/entity-resolution.ts": "name → id resolution (dedup)",
  "services/library/read-text-search.ts": "documents collection",
  "services/lifecycle/homes.ts":
    "its listings go through status-groups (which carries the rule)",
  "services/links/dependency-links.ts": "dependency endpoint state",
  "services/links/dependency-relation-read.ts":
    "edges of a focal object (opening it), not an entity listing",
  "services/object-graph/graph-service.ts":
    "a focal object's graph neighbourhood (opening it) + name resolution",
  "services/postiz/record-postiz-published.ts": "match by external id",
  "services/projects/create-project.ts": "validates evidence ids",
  "services/runs/index.ts": "one run's produced records, by id",
  "utils/project-subject.ts": "a project's subject name + bind gate",
};

const API_SRC = join(__dirname, "..");
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (
      name.endsWith(".ts") &&
      !name.endsWith(".test.ts") &&
      !name.endsWith(".d.ts")
    )
      out.push(p);
  }
  return out;
}

describe("net 3 — every api file with an entity floor carries the rule or says why not", () => {
  const scanned = walk(API_SRC)
    .map((p) => ({ rel: relative(API_SRC, p), src: readFileSync(p, "utf8") }))
    .filter((f) => FLOOR_RE.test(f.src));

  it("the scan sees a plausible set, incl. a literal sample (non-vacuity)", () => {
    expect(scanned.length).toBeGreaterThanOrEqual(40);
    const rels = scanned.map((f) => f.rel);
    expect(rels).toContain("routers/entities/read.ts");
    expect(rels).toContain("routers/views.ts");
    expect(FLOOR_RE.test("x.predicate(entities)")).toBe(true);
    expect(MARK_RE.test("listableEntityWhere({})")).toBe(true);
  });

  it("each matched file carries the listing rule or is WITHHELD with a reason", () => {
    const missing = scanned
      .filter((f) => !MARK_RE.test(f.src) && !(f.rel in WITHHELD_FILES))
      .map((f) => f.rel);
    expect(missing).toEqual([]);
  });

  it("no WITHHELD entry is stale (gone, no floor, or already carrying the rule)", () => {
    const byRel = new Map(scanned.map((f) => [f.rel, f]));
    const stale = Object.keys(WITHHELD_FILES).filter((rel) => {
      const f = byRel.get(rel);
      return !f || MARK_RE.test(f.src);
    });
    expect(stale).toEqual([]);
  });
});

// ── Net 3 (jobs): every jobs file that reads entities carries the rule or says why not

const JOBS_READ_RE =
  /\.from\(entities\)|query\.entities\.findMany\(|entityQueryVisibilityWhere\(/;

/** Jobs files that read entities for something that is not a listing. */
const WITHHELD_JOBS_FILES: Record<string, string> = {
  "utils/automation-governance.ts": "names / targets by id",
  "utils/process-sync.ts": "one subject, by id",
  "workers/ai-workers.ts": "one entity, by id",
  "workers/cross-channel-notifier.ts": "one subject, by id",
  "workers/entity-embedding.ts": "indexes one row, by id",
  "workers/entity-query-scope.ts": "defines the jobs-local access floor",
  "workers/pagerank-centrality.ts":
    "graph maintenance over ids — scores rows, shows nobody a list",
  "workers/pod-hygiene-near-dup.ts":
    "duplicate detection — identity is pod-wide (dedup sees demo rows)",
  "workers/relation-backfill.ts": "maintenance write over a profile's rows",
  "workers/steps/entity-lookup.ts":
    "entity_read by id + related_entities: a focal record's neighbourhood",
  "workers/steps/messages-query.ts": "names entities messages reference, by id",
  "workers/steps/output.ts": "write target: dedupe-by + existence by id",
  "workers/tool-demand-forward.ts":
    "tool-request bookkeeping rows, not a listing of the person's data",
};

const JOBS_SRC = join(__dirname, "..", "..", "..", "jobs", "src");

describe("net 3 (jobs) — every jobs file reading entities carries the rule or says why not", () => {
  const scanned = walk(JOBS_SRC)
    .map((p) => ({ rel: relative(JOBS_SRC, p), src: readFileSync(p, "utf8") }))
    .filter((f) => JOBS_READ_RE.test(f.src));

  it("the scan sees a plausible set, incl. a literal sample (non-vacuity)", () => {
    expect(scanned.length).toBeGreaterThanOrEqual(12);
    const rels = scanned.map((f) => f.rel);
    expect(rels).toContain("workers/steps/query.ts");
    expect(rels).toContain("workers/crm-daily-digest.ts");
    expect(JOBS_READ_RE.test("db.select().from(entities)")).toBe(true);
  });

  it("each matched file carries the listing rule or is WITHHELD with a reason", () => {
    const missing = scanned
      .filter((f) => !MARK_RE.test(f.src) && !(f.rel in WITHHELD_JOBS_FILES))
      .map((f) => f.rel);
    expect(missing).toEqual([]);
  });

  it("no WITHHELD jobs entry is stale (gone, no read, or already carrying the rule)", () => {
    const byRel = new Map(scanned.map((f) => [f.rel, f]));
    const stale = Object.keys(WITHHELD_JOBS_FILES).filter((rel) => {
      const f = byRel.get(rel);
      return !f || MARK_RE.test(f.src);
    });
    expect(stale).toEqual([]);
  });
});
