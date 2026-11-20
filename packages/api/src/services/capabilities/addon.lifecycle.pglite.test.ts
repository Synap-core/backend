/**
 * Tool ADD-ONS through their whole life (finding f40e7783; design ac700298
 * §5): what a capability package `require`s is installed first, and a base
 * with add-ons installed cannot be removed.
 *
 *   - `market.install` of a capability resolves its dependencies through the
 *     ONE package-dependency resolver (an add-on's base derived from
 *     `extends`, a plain capability's declared `dependencies`): a missing one
 *     installs from the catalog first, one already installed for the pod or
 *     in the target space is `found`, and one that cannot be installed
 *     refuses the install, naming it, with nothing of the package written.
 *   - `uninstallCapability` refuses a base while add-ons extend it, naming
 *     them; removing an add-on removes its `extends` edge, after which the
 *     base can go.
 *
 * Real: `applyMarketInstall` (supplied definition, Synap's catalog), the
 * resolver, `createCapabilityFromDefinition`, `uninstallCapability`, against
 * PGlite tables generated from the Drizzle schema. Stubbed: the catalog
 * (`fetchCPCapabilityTemplate` serves `h.catalog`), the governance check
 * (granted), the hub caller context, webhook provisioning, and the links
 * service behind `requires` edges (an in-memory store).
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
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

const h = vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
  const state = {
    client: null as null | {
      exec: (sql: string) => Promise<unknown>;
      query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    },
    db: null as unknown,
    edges: [] as Edge[],
    nextEdge: 0,
    /** What the catalog serves by key (null: not in the catalog). */
    catalog: {} as Record<string, unknown>,
    catalogReads: [] as string[],
    async init(): Promise<unknown> {
      if (!state.db) {
        const { PGlite } = await import("@electric-sql/pglite");
        const { drizzle } = await import("drizzle-orm/pglite");
        const schema = await import("@synap/database/schema");
        const client = new PGlite();
        state.client = client as unknown as typeof state.client;
        state.db = drizzle(client, { schema });
      }
      return state.db;
    },
    async clientPgModule() {
      const db = await state.init();
      return {
        db,
        sql: undefined,
        getDb: async () => db,
        setCurrentUser: async () => undefined,
        clearCurrentUser: async () => undefined,
        closeDatabase: async () => undefined,
      };
    },
  };
  return state;
});

vi.mock("../../../../database/dist/client-pg.js", () => h.clientPgModule());
vi.mock("../../../../database/src/client-pg.js", () => h.clientPgModule());
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, db: await h.init(), getDb: async () => h.init() };
});
vi.mock("../../utils/permission-check.js", () => ({
  checkPermissionOrPropose: vi.fn(async () => ({ granted: true })),
  createPendingProposal: vi.fn(),
}));
vi.mock("../../utils/workspace-write-access.js", () => ({
  assertWorkspaceWrite: vi.fn(async () => undefined),
}));
vi.mock("./cp-template-client.js", () => ({
  fetchCPCapabilityTemplate: vi.fn(async (key: string) => {
    h.catalogReads.push(key);
    return h.catalog[key] ?? null;
  }),
}));
vi.mock("../../routers/hub-protocol/utils.js", () => ({
  createHubProtocolCallerContext: vi.fn(
    async (userId: string, _scopes: string[], workspaceId?: string | null) => ({
      userId,
      workspaceId: workspaceId ?? null,
      authenticated: true,
    })
  ),
}));
vi.mock("../webhooks/provision-inbound-webhook.js", () => ({
  provisionInstalledToolWebhooks: vi.fn(async () => []),
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
vi.mock("../../utils/split-brain-service.js", () => ({
  isPodReadOnly: async () => false,
  getSyncGenerationState: async () => ({ generation: 1, isPrimary: true }),
  invalidateSyncGenerationCache: vi.fn(),
}));
vi.mock("@synap/events", () => ({ emitSideEffects: vi.fn() }));
vi.mock("../../utils/audit-log.js", () => ({ auditLog: vi.fn() }));

import { applyMarketInstall } from "./marketplace-install.js";
import { createCapabilityFromDefinition } from "./create-from-definition.js";
import { uninstallCapability } from "./uninstall-capability.js";

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
          : c.name === "metadata"
            ? " default '{}'"
            : "";
    return `"${c.name}" ${type}${pk}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const UID = "22222222-2222-4222-8222-222222222222";
const WS = "11111111-1111-4111-8111-111111111111";
const CTX = { userId: UID, workspaceId: WS, authenticated: true } as never;

const skill = (
  name: string,
  scope: "pod" | "workspace" = "pod",
  requires = ["apify_api"]
) => ({
  name,
  kind: "code",
  scope,
  description: `${name} action`,
  code: `return "${name}";`,
  requires,
});

const APIFY = {
  key: "apify",
  name: "Apify",
  vault: [],
  tools: [{ name: "apify_api", kind: "api" }],
  skills: [skill("apify_search_actors")],
};
/** As the CP package serves it: wrapped, its base derived from `extends`. */
const LINKEDIN_PROFILES = {
  profiles: [],
  capability: {
    key: "apify-linkedin-profiles",
    name: "LinkedIn profiles",
    extends: "apify",
    vault: [],
    tools: [],
    skills: [skill("apify_linkedin_profile")],
  },
};
const SOCIAL_POSTS = {
  key: "apify-social-posts",
  name: "Social posts",
  extends: "apify",
  vault: [],
  tools: [],
  skills: [skill("apify_social_post")],
};
const MAILER = {
  key: "mailer",
  name: "Mailer",
  vault: [],
  tools: [{ name: "mailer_api", kind: "api" }],
  skills: [skill("mailer_send", "pod", ["mailer_api"])],
};
/** A plain capability (no `extends`) that declares a `require`. */
const DIGEST = {
  profiles: [],
  capability: {
    key: "digest",
    name: "Digest",
    vault: [],
    tools: [{ name: "digest_api", kind: "api" }],
    skills: [skill("digest_build", "pod", ["digest_api"])],
  },
  dependencies: [{ slug: "mailer", kind: "capability", relation: "require" }],
};

const marketInstall = (
  slug: string,
  definition: unknown,
  workspaceId: string | null = null
) =>
  applyMarketInstall({
    kind: "capability",
    slug,
    definition: definition as Record<string, unknown>,
    userId: UID,
    workspaceId,
  });

const rows = async <T>(sql: string, params: unknown[] = []) =>
  (await h.client!.query<T>(sql, params)).rows;
const containersByKey = async (key: string) =>
  rows<{ id: string; workspace_id: string | null }>(
    `select id, workspace_id from capabilities where template_key = $1`,
    [key]
  );
const containerByKey = async (key: string) => (await containersByKey(key))[0];
const extendsEdges = async () =>
  rows<{ from_id: string; to_id: string }>(
    `select from_id, to_id from links where link_type = 'extends'`
  );

beforeAll(async () => {
  await h.init();
  const schema = await import("@synap/database/schema");
  const seen = new Set<string>();
  for (const v of Object.values(schema)) {
    if (!is(v, PgTable)) continue;
    const name = getTableConfig(v).name;
    if (seen.has(name)) continue;
    seen.add(name);
    await h.client!.exec(ddlFor(v));
  }
  await h.client!.exec(
    `create unique index on links (from_type, from_id, to_type, to_id, link_type)`
  );
  await h.client!.query(`insert into users (id) values ($1)`, [UID]);
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

describe("market.install of a capability honours what it requires", () => {
  it("an add-on whose base the catalog cannot serve is refused, naming the base, with nothing written", async () => {
    h.catalog = {};
    await expect(
      marketInstall("apify-linkedin-profiles", LINKEDIN_PROFILES)
    ).rejects.toThrow(/needs "apify" installed first/);
    expect(await rows(`select id from capabilities`)).toEqual([]);
    expect(await rows(`select id from skills`)).toEqual([]);
  });

  it("an add-on whose base is missing installs the base first, then itself", async () => {
    h.catalog = { apify: APIFY };
    const result = await marketInstall(
      "apify-linkedin-profiles",
      LINKEDIN_PROFILES
    );
    const base = (await containerByKey("apify"))!;
    const addOn = (await containerByKey("apify-linkedin-profiles"))!;
    expect(base).toBeDefined();
    expect(addOn).toBeDefined();
    expect(await extendsEdges()).toEqual([
      { from_id: addOn.id, to_id: base.id },
    ]);
    expect(result.dependencies).toEqual([
      expect.objectContaining({
        slug: "apify",
        kind: "capability",
        action: "installed",
      }),
    ]);
  });

  it("a base already installed is found and left alone (no second container)", async () => {
    h.catalogReads = [];
    const result = await marketInstall("apify-social-posts", SOCIAL_POSTS);
    expect(result.dependencies).toEqual([
      expect.objectContaining({ slug: "apify", action: "found" }),
    ]);
    expect(h.catalogReads).not.toContain("apify");
    expect(await containersByKey("apify")).toHaveLength(1);
    expect(await containerByKey("apify-social-posts")).toBeDefined();
  });

  it("a plain capability's declared require is installed first", async () => {
    h.catalog = { mailer: MAILER };
    const result = await marketInstall("digest", DIGEST);
    expect(await containerByKey("mailer")).toBeDefined();
    expect(await containerByKey("digest")).toBeDefined();
    expect(result.dependencies).toEqual([
      expect.objectContaining({ slug: "mailer", action: "installed" }),
    ]);
  });

  it("a base installed in the target space counts as present there", async () => {
    // Installed in WS only (its action is space-scoped); not in the catalog.
    await createCapabilityFromDefinition(
      {
        key: "space-base",
        name: "Space base",
        vault: [],
        tools: [{ name: "space_base_api", kind: "api" }],
        skills: [skill("space_base_read", "workspace", ["space_base_api"])],
      } as never,
      {},
      CTX
    );
    expect((await containerByKey("space-base"))!.workspace_id).toBe(WS);
    h.catalog = {};
    const result = await marketInstall(
      "space-base-addon",
      {
        key: "space-base-addon",
        name: "Space base add-on",
        extends: "space-base",
        vault: [],
        tools: [],
        skills: [skill("space_extra", "workspace", ["space_base_api"])],
      },
      WS
    );
    expect(result.dependencies).toEqual([
      expect.objectContaining({ slug: "space-base", action: "found" }),
    ]);
    expect(await containersByKey("space-base")).toHaveLength(1);
    expect((await containerByKey("space-base-addon"))!.workspace_id).toBe(WS);
  });
});

describe("removing a base with add-ons installed", () => {
  it("is refused, naming its add-ons, and nothing is removed", async () => {
    const base = (await containerByKey("apify"))!;
    await expect(uninstallCapability(base.id, CTX)).rejects.toThrow(
      /"Apify" has 2 add-ons installed.*"LinkedIn profiles", "Social posts"/
    );
    expect(await containerByKey("apify")).toBeDefined();
    expect(await extendsEdges()).toHaveLength(3);
  });

  it("removing an add-on removes its extends edge; once none is left the base can go", async () => {
    const base = (await containerByKey("apify"))!;
    for (const key of ["apify-linkedin-profiles", "apify-social-posts"]) {
      const addOn = (await containerByKey(key))!;
      await uninstallCapability(addOn.id, CTX);
      expect(
        (await extendsEdges()).filter((e) => e.from_id === addOn.id)
      ).toEqual([]);
    }
    await uninstallCapability(base.id, CTX);
    expect(await containerByKey("apify")).toBeUndefined();
  });
});
