/**
 * A re-applied definition that WIDENS an approved skill's `requires` demotes it
 * (review of #199, R2).
 *
 * `skill → requires → tool` edges are a scope: a code skill's own provider
 * calls to those tools run under its decision with no second review
 * (`verbAct`, execute-capability.ts). `POST /api/hub/capabilities/apply`
 * (key auth, inline definition) reaches the applier's existing-skill branch,
 * which rewrote those edges with no proposal while only an execution-content
 * change demoted approval: an approved `score_handle` could gain
 * `requires → stripe_api` silently. A tool the skill does not already require
 * is now an execution change; a replay or a narrowing keeps the approval.
 *
 * Driven through the real `createCapabilityFromDefinition` and the real
 * `skillsRouter` (create + setRequiredTools) against PGlite tables generated
 * from the Drizzle schema, asserting the ROW. The links service is an
 * in-memory edge store so the edges the writer leaves are asserted too.
 *
 * Negative control (2026-10-26, negctl/tickets-1025-8): without the
 * `requiresWidened` demotion the widening cases are red.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";

type Edge = {
  id: string;
  fromType: string;
  fromId: string;
  toType: string;
  toId: string;
  linkType: string;
  workspaceId: string | null;
};

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  edges: [] as Edge[],
  nextEdge: 0,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema });
  return { ...actual, db, getDb: async () => db };
});
vi.mock("../../utils/permission-check.js", () => ({
  checkPermissionOrPropose: vi.fn(async () => ({ granted: true })),
  createPendingProposal: vi.fn(),
}));
vi.mock("../../utils/workspace-write-access.js", () => ({
  assertWorkspaceWrite: vi.fn(async () => undefined),
}));
vi.mock("./cp-template-client.js", () => ({
  fetchCPCapabilityTemplate: vi.fn(async () => null),
}));
vi.mock("../links/links-service.js", () => ({
  createLinks: vi.fn(async (rows: Omit<Edge, "id">[]) => {
    for (const r of rows) h.edges.push({ ...r, id: `edge-${++h.nextEdge}` });
    return [];
  }),
  getLinksFor: vi.fn(async (_userId: string, type: string, id: string) =>
    h.edges.filter(
      (e) =>
        (e.fromType === type && e.fromId === id) ||
        (e.toType === type && e.toId === id)
    )
  ),
  deleteLink: vi.fn(async (id: string) => {
    h.edges = h.edges.filter((e) => e.id !== id);
  }),
}));
vi.mock("../../routers/capability-containers.js", () => ({
  capabilityContainersRouter: {
    createCaller: () => ({
      create: vi.fn(async () => ({
        capability: { id: "33333333-3333-3333-3333-333333333333" },
      })),
      addPart: vi.fn(async () => ({ ok: true })),
    }),
  },
}));
vi.mock("../../utils/split-brain-service.js", () => ({
  isPodReadOnly: async () => false,
  getSyncGenerationState: async () => ({ generation: 1, isPrimary: true }),
  invalidateSyncGenerationCache: vi.fn(),
}));
vi.mock("@synap/events", () => ({ emitSideEffects: vi.fn() }));
vi.mock("../../utils/audit-log.js", () => ({ auditLog: vi.fn() }));

import { createCapabilityFromDefinition } from "./create-from-definition.js";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const pk =
      c.primary && type === "uuid"
        ? " primary key default gen_random_uuid()"
        : c.primary
          ? " primary key"
          : "";
    const def =
      c.name === "approved"
        ? " default false"
        : c.name === "created_at" || c.name === "updated_at"
          ? " default now()"
          : "";
    return `"${c.name}" ${type}${pk}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const UID = "22222222-2222-4222-8222-222222222222";
const WS = "11111111-1111-4111-8111-111111111111";
const APIFY = "55555555-0000-4000-8000-000000000001";
const STRIPE = "55555555-0000-4000-8000-000000000002";
const SKILL = "score_handle";

/** The key's inline definition: the tools it names + one code skill. */
function apply(requires: string[]) {
  return createCapabilityFromDefinition(
    {
      key: "handle-scoring",
      name: "Handle scoring",
      vault: [],
      tools: [{ name: "apify_api" }, { name: "stripe_api" }],
      skills: [
        {
          name: SKILL,
          kind: "code",
          // Workspace-scoped, so the applier resolves the tools in WS (a pod
          // skill looks them up pod-wide).
          scope: "workspace",
          description: "Score a social handle",
          code: "return 1;",
          requires,
        },
      ],
      playbooks: [],
    } as never,
    {},
    { userId: UID, workspaceId: WS, authenticated: true } as never
  );
}
const theSkill = async () =>
  (
    await h.client!.query<{ id: string; approved: boolean }>(
      `select id, approved from skills where name = $1`,
      [SKILL]
    )
  ).rows;
/** The owner approved it under Settings (the router's setApproved). */
const ownerApproves = () =>
  h.client!.query(`update skills set approved = true where name = $1`, [SKILL]);
const requiredToolIds = async () => {
  const [skill] = await theSkill();
  return h.edges
    .filter(
      (e) =>
        e.fromId === skill!.id &&
        e.linkType === "requires" &&
        e.toType === "tool"
    )
    .map((e) => e.toId)
    .sort();
};

beforeAll(async () => {
  const schema = await import("@synap/database/schema");
  const seen = new Set<string>();
  for (const v of Object.values(schema)) {
    if (!is(v, PgTable)) continue;
    const name = getTableConfig(v).name;
    if (seen.has(name)) continue;
    seen.add(name);
    await h.client!.exec(ddlFor(v));
  }
  expect(seen.has("skills")).toBe(true);
  await h.client!.query(
    `insert into workspaces (id, name, system_slug) values ($1, 'WS', null)`,
    [WS]
  );
  await h.client!.query(
    `insert into workspace_members (id, workspace_id, user_id, role) values
       (gen_random_uuid(), $1, $2, 'owner')`,
    [WS, UID]
  );
}, 120_000);

beforeEach(async () => {
  await h.client!.exec(`delete from skills; delete from tools;`);
  // The tools the key names already exist in the space (installed earlier).
  await h.client!.query(
    `insert into tools (id, name, kind, workspace_id, created_by) values ($1, 'apify_api', 'api', $3, $4), ($2, 'stripe_api', 'api', $3, $4)`,
    [APIFY, STRIPE, WS, UID]
  );
  h.edges = [];
});

describe("applier re-apply vs an approved skill's `requires`", () => {
  it("a re-apply that ADDS a required tool demotes the approved skill", async () => {
    await apply(["apify_api"]);
    await ownerApproves();
    expect(await requiredToolIds()).toEqual([APIFY]);

    await apply(["apify_api", "stripe_api"]);

    const rows = await theSkill();
    expect(rows).toHaveLength(1); // reconciled in place, not a second skill
    expect(rows[0]!.approved).toBe(false);
    expect(await requiredToolIds()).toEqual([APIFY, STRIPE].sort());
  });

  it("a FIRST `requires` on an approved skill that declared none demotes it", async () => {
    await apply([]);
    await ownerApproves();

    await apply(["stripe_api"]);

    expect((await theSkill())[0]!.approved).toBe(false);
  });

  it("a REPLAY of the same `requires` keeps the approval (change, not presence)", async () => {
    await apply(["apify_api", "stripe_api"]);
    await ownerApproves();

    await apply(["stripe_api", "apify_api"]);

    expect((await theSkill())[0]!.approved).toBe(true);
  });

  it("a NARROWING keeps the approval and drops the edge", async () => {
    await apply(["apify_api", "stripe_api"]);
    await ownerApproves();

    await apply(["apify_api"]);

    expect((await theSkill())[0]!.approved).toBe(true);
    expect(await requiredToolIds()).toEqual([APIFY]);
  });
});
