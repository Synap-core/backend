/**
 * Security-proof tests for the UNAUTHENTICATED public projection endpoint.
 *
 * Every leak the endpoint must prevent has an assertion here:
 *  1. A workspace with publicProjection.enabled !== true ⇒ 404 (default-deny),
 *     and the projection query is NEVER executed.
 *  2. A pod-wide entity with NO qualifying facet is never returned — proven at
 *     the query-builder level (the filter is facet-workspace-scoped) and by the
 *     handler returning exactly the joined rows, never inventing rows.
 *  3. A private property key (not in the allowlist) never appears in output.
 *  4. A `role` outside the allowlist is not honored (falls back to the allowlist,
 *     never widens exposure).
 *  5. Only entities with a facet in the target workspace + an allowlisted role
 *     are returned; `limit` is hard-capped.
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────────

// Capture what runProjectionQuery hands to the DB and what settings it reads.
// `vi.hoisted` so these exist before the hoisted vi.mock factory runs.
const { findFirstMock, limitMock, whereMock } = vi.hoisted(() => ({
  findFirstMock: vi.fn(),
  limitMock: vi.fn(),
  whereMock: vi.fn(),
}));

vi.mock("@synap/database", () => {
  // A chainable select() builder whose terminal .limit() resolves mocked rows.
  const makeSelectChain = () => {
    const chain: Record<string, unknown> = {};
    chain.from = () => chain;
    chain.innerJoin = () => chain;
    chain.where = whereMock;
    return chain;
  };
  return {
  db: {
    query: { workspaces: { findFirst: findFirstMock } },
    select: () => makeSelectChain(),
  },
  entities: { id: "e.id", title: "e.title", preview: "e.preview", properties: "e.props", deletedAt: "e.deletedAt" },
  entityFacets: { workspaceId: "f.ws", profileId: "f.pid", entityId: "f.eid", properties: "f.props", deletedAt: "f.deletedAt" },
  profiles: { id: "p.id", slug: "p.slug" },
  workspaces: { id: "w.id" },
  eq: (a: unknown, b: unknown) => ({ op: "eq", a, b }),
  and: (...c: unknown[]) => ({ op: "and", c }),
  or: (...c: unknown[]) => ({ op: "or", c }),
  inArray: (a: unknown, b: unknown) => ({ op: "inArray", a, b }),
  isNull: (a: unknown) => ({ op: "isNull", a }),
  ilike: (a: unknown, b: unknown) => ({ op: "ilike", a, b }),
  };
});

vi.mock("./_shared.js", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import {
  registerPublicProjectionRoutes,
  parsePublicProjectionConfig,
  buildProjectionSpec,
  resolveRoleSlugs,
  clampLimit,
  projectRow,
  PROJECTION_MAX_LIMIT,
  PROJECTION_DEFAULT_LIMIT,
  type PublicProjectionConfig,
} from "./public-projection.js";
import type { HubHono, HubVariables } from "./_shared.js";

const WS = "11111111-1111-4111-8111-111111111111";
const CONFIG: PublicProjectionConfig = {
  enabled: true,
  roles: ["directory_member", "sponsor"],
  fields: ["website", "tagline"],
};

function buildApp(): HubHono {
  const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  registerPublicProjectionRoutes(app);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  limitMock.mockResolvedValue([]);
  whereMock.mockReturnValue({ limit: limitMock });
});

// ── 1. Default-deny config parsing ────────────────────────────────────────────

describe("parsePublicProjectionConfig — default-deny", () => {
  it("returns null when settings absent / not an object", () => {
    expect(parsePublicProjectionConfig(undefined)).toBeNull();
    expect(parsePublicProjectionConfig(null)).toBeNull();
    expect(parsePublicProjectionConfig("nope")).toBeNull();
    expect(parsePublicProjectionConfig({})).toBeNull();
  });

  it("returns null when enabled !== true", () => {
    expect(
      parsePublicProjectionConfig({
        publicProjection: { enabled: false, roles: ["x"], fields: [] },
      })
    ).toBeNull();
    expect(
      parsePublicProjectionConfig({
        publicProjection: { enabled: "true", roles: ["x"], fields: [] },
      })
    ).toBeNull();
  });

  it("returns null when roles allowlist is empty (misconfigured ⇒ deny)", () => {
    expect(
      parsePublicProjectionConfig({
        publicProjection: { enabled: true, roles: [], fields: ["a"] },
      })
    ).toBeNull();
  });

  it("accepts a valid opt-in config", () => {
    const cfg = parsePublicProjectionConfig({
      publicProjection: { enabled: true, roles: ["sponsor"], fields: ["website"] },
    });
    expect(cfg).toEqual({ enabled: true, roles: ["sponsor"], fields: ["website"] });
  });
});

// ── 4. Role allowlist is never widened ────────────────────────────────────────

describe("resolveRoleSlugs — out-of-allowlist role ignored", () => {
  it("honors an in-allowlist role by narrowing to it", () => {
    expect(resolveRoleSlugs("sponsor", CONFIG.roles)).toEqual(["sponsor"]);
  });

  it("ignores an out-of-allowlist role, falling back to the full allowlist", () => {
    // 'company' is a pod-wide kind, NOT an allowlisted role — must not be honored.
    expect(resolveRoleSlugs("company", CONFIG.roles)).toEqual(CONFIG.roles);
    expect(resolveRoleSlugs("person", CONFIG.roles)).toEqual(CONFIG.roles);
  });

  it("falls back to the allowlist when no role given", () => {
    expect(resolveRoleSlugs(undefined, CONFIG.roles)).toEqual(CONFIG.roles);
  });
});

// ── 5. Query spec: facet-scoped + capped ──────────────────────────────────────

describe("buildProjectionSpec — facet-scoping & caps", () => {
  it("binds facetWorkspaceId to the requested workspace (the security keystone)", () => {
    const spec = buildProjectionSpec(CONFIG, { workspaceId: WS });
    expect(spec.facetWorkspaceId).toBe(WS);
  });

  it("roleSlugs is always a subset of the config allowlist", () => {
    for (const role of [undefined, "sponsor", "company", "note", "person"]) {
      const spec = buildProjectionSpec(CONFIG, { workspaceId: WS, role });
      for (const slug of spec.roleSlugs) expect(CONFIG.roles).toContain(slug);
    }
  });

  it("caps limit at PROJECTION_MAX_LIMIT and defaults sensibly", () => {
    expect(clampLimit("9999")).toBe(PROJECTION_MAX_LIMIT);
    expect(clampLimit(undefined)).toBe(PROJECTION_DEFAULT_LIMIT);
    expect(clampLimit("0")).toBe(PROJECTION_DEFAULT_LIMIT);
    expect(clampLimit("-5")).toBe(PROJECTION_DEFAULT_LIMIT);
    expect(clampLimit("10")).toBe(10);
  });

  it("escapes LIKE wildcards in the keyword", () => {
    const spec = buildProjectionSpec(CONFIG, { workspaceId: WS, q: "50%_off" });
    expect(spec.keyword).toBe("50\\%\\_off");
  });
});

// ── 3. Field whitelist enforced ───────────────────────────────────────────────

describe("projectRow — field whitelist", () => {
  it("strips any key not in the allowlist, even when present on the row", () => {
    const item = projectRow(
      {
        id: "e1",
        title: "Acme",
        role: "sponsor",
        entityProperties: {
          website: "https://acme.example",
          // PRIVATE keys that MUST NOT leak:
          internalNotes: "do not contact until Q3",
          ownerEmail: "samir@private.example",
          revenue: 1_000_000,
        },
        facetProperties: { tagline: "We build things", secretTier: "gold" },
      },
      CONFIG.fields
    );
    expect(item).toEqual({
      id: "e1",
      title: "Acme",
      role: "sponsor",
      properties: { website: "https://acme.example", tagline: "We build things" },
    });
    // Explicit leak assertions.
    expect(item.properties).not.toHaveProperty("internalNotes");
    expect(item.properties).not.toHaveProperty("ownerEmail");
    expect(item.properties).not.toHaveProperty("revenue");
    expect(item.properties).not.toHaveProperty("secretTier");
  });

  it("returns empty properties when the allowlist is empty", () => {
    const item = projectRow(
      { id: "e1", title: "x", role: "sponsor", entityProperties: { a: 1 }, facetProperties: {} },
      []
    );
    expect(item.properties).toEqual({});
  });
});

// ── Handler-level: 404 default-deny + never returns un-joined rows ─────────────

describe("GET /public/projection — handler", () => {
  it("returns 404 and never runs the projection query when not opted in", async () => {
    findFirstMock.mockResolvedValue({
      settings: { publicProjection: { enabled: false, roles: ["sponsor"], fields: [] } },
    });
    const app = buildApp();
    const res = await app.request(`/public/projection?workspace=${WS}`);
    expect(res.status).toBe(404);
    // The facet query must never execute for a non-opted-in workspace.
    expect(whereMock).not.toHaveBeenCalled();
    expect(limitMock).not.toHaveBeenCalled();
  });

  it("returns 404 for a malformed workspace id (never reaches Postgres)", async () => {
    const app = buildApp();
    const res = await app.request(`/public/projection?workspace=not-a-uuid`);
    expect(res.status).toBe(404);
    expect(findFirstMock).not.toHaveBeenCalled();
  });

  it("returns only the joined (facet-qualified) rows, field-whitelisted", async () => {
    findFirstMock.mockResolvedValue({ settings: { publicProjection: CONFIG } });
    // The query — being facet-scoped — yields ONLY entities carrying an
    // allowlisted facet in this workspace. A pod-wide private person/note has no
    // such facet and thus never appears in this result set.
    limitMock.mockResolvedValue([
      {
        id: "company-1",
        title: "Acme",
        role: "sponsor",
        entityProperties: { website: "https://acme.example", ownerEmail: "leak@x" },
        facetProperties: { tagline: "public tagline" },
      },
    ]);
    const app = buildApp();
    const res = await app.request(`/public/projection?workspace=${WS}&q=acme&limit=999`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ id: string; role: string; properties: Record<string, unknown> }>;
      count: number;
    };
    expect(body.count).toBe(1);
    expect(body.items[0].id).toBe("company-1");
    // Private key stripped end-to-end.
    expect(body.items[0].properties).toEqual({ website: "https://acme.example", tagline: "public tagline" });
    expect(body.items[0].properties).not.toHaveProperty("ownerEmail");
    // Limit was capped (999 → PROJECTION_MAX_LIMIT).
    expect(limitMock).toHaveBeenCalledWith(PROJECTION_MAX_LIMIT);
  });
});
