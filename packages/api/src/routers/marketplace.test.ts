/**
 * `marketplace` router — the pod-owned catalog door. The cache read, the
 * definition resolver and the install core are each proven in their own
 * tests; here, the procedure wiring around them:
 *   • list pages the cache (alphabetical without a query) and names sources
 *     with their last sync;
 *   • get returns the row with its on-demand definition, and a source that
 *     cannot serve it is a field, not a failed page;
 *   • preflight blocks a space-bound kind until a space is named, and a
 *     template carries the workspace preflight report;
 *   • install: a person installs directly, an agent files the proposal path,
 *     any other key is refused before the install core runs.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as Database from "@synap/database";
import { TRPCError } from "@trpc/server";

const m = vi.hoisted(() => ({
  query: vi.fn(),
  lookup: vi.fn(),
  resolve: vi.fn(),
  run: vi.fn(),
  preflight: vi.fn(),
  stamps: vi.fn(),
  distinct: vi.fn(),
  membership: vi.fn(),
}));

vi.mock("../utils/split-brain-service.js", () => ({
  isPodReadOnly: async () => false,
}));
vi.mock("../utils/tier-check.js", () => ({
  assertPackageTierAccess: async () => undefined,
}));
vi.mock("../services/preflight-compose-target.js", () => ({
  resolvePreflightComposeTarget: async () => undefined,
}));
vi.mock("../services/capabilities/catalog-cache-query.js", () => ({
  queryCatalogCache: (...a: unknown[]) => m.query(...a),
}));
vi.mock("../services/capabilities/marketplace-install.js", () => ({
  lookupCatalogEntry: (...a: unknown[]) => m.lookup(...a),
  resolveCatalogDefinition: (...a: unknown[]) => m.resolve(...a),
  runMarketInstall: (...a: unknown[]) => m.run(...a),
}));
vi.mock("../services/capabilities/builtin-verbs.js", () => ({
  resolveInstalledFlag: async () => undefined,
}));
vi.mock("@synap/jobs", () => ({
  CATALOG_KINDS: [
    "capability",
    "automation",
    "template",
    "cell",
    "skill",
    "view",
  ],
  catalogSources: () => ["https://cp.synap.live"],
}));
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof Database>();
  return {
    ...actual,
    db: {
      selectDistinct: () => ({ from: async () => m.distinct() }),
    },
    getCatalogSyncStamps: (...a: unknown[]) => m.stamps(...a),
    getWorkspaceMembership: (...a: unknown[]) => m.membership(...a),
    preflightWorkspaceFromDefinition: (...a: unknown[]) => m.preflight(...a),
  };
});

import { marketplaceRouter } from "./marketplace.js";

const CP = "https://cp.synap.live";
const WS = "11111111-1111-4111-8111-111111111111";

function caller(extra: Record<string, unknown> = {}) {
  return marketplaceRouter.createCaller({
    authenticated: true,
    userId: "user-1",
    session: { identity: { id: "user-1" } },
    ...extra,
  } as never);
}

const entry = (slug: string, name: string, kind = "capability") => ({
  source: CP,
  kind,
  slug,
  name,
  description: null,
  version: "1.0.0",
  tier: null,
  vendor: null,
  tags: null,
  contentHash: null,
  definition: null,
});

beforeEach(() => {
  for (const fn of Object.values(m)) fn.mockReset();
  m.distinct.mockResolvedValue([{ source: CP }]);
  m.stamps.mockResolvedValue({
    [`${CP}::capability`]: {
      lastSyncAt: "2026-10-13T08:00:00.000Z",
      lastStatus: "ok",
      lastCount: 2,
    },
    [`${CP}::template`]: {
      lastSyncAt: "2026-10-13T08:10:00.000Z",
      lastStatus: "ok",
      lastCount: 1,
    },
  });
  m.membership.mockResolvedValue({ role: "owner" });
});

describe("marketplace.list", () => {
  it("pages the cache alphabetically and names each source with its last sync", async () => {
    m.query.mockResolvedValue([
      entry("zeta", "Zeta"),
      entry("alpha", "Alpha"),
      entry("crm", "CRM", "template"),
    ]);
    const out = await caller().list({ limit: 2 });
    expect(out.entries.map((e) => e.slug)).toEqual(["alpha", "crm"]);
    expect(out.entries[1]).toMatchObject({
      objectKind: "workspace",
      sourceName: "Synap",
    });
    expect(out.total).toBe(3);
    expect(out.nextCursor).toBe(2);
    expect(out.sources).toEqual([
      {
        source: CP,
        name: "Synap",
        configured: true,
        lastSyncAt: "2026-10-13T08:10:00.000Z",
        unreachable: false,
      },
    ]);
    const next = await caller().list({ limit: 2, cursor: 2 });
    expect(next.entries.map((e) => e.slug)).toEqual(["zeta"]);
    expect(next.nextCursor).toBeNull();
  });

  it("keeps the ranked order of a search and forwards the filters", async () => {
    m.query.mockResolvedValue([entry("zeta", "Zeta"), entry("alpha", "Alpha")]);
    const out = await caller().list({
      query: "z",
      kind: "capability",
      source: CP,
    });
    expect(out.entries.map((e) => e.slug)).toEqual(["zeta", "alpha"]);
    expect(m.query).toHaveBeenCalledWith(
      expect.objectContaining({ query: "z", kind: "capability", source: CP })
    );
  });

  it("names a source no longer configured by its host", async () => {
    m.query.mockResolvedValue([]);
    m.distinct.mockResolvedValue([
      { source: CP },
      { source: "https://acme.example" },
    ]);
    const out = await caller().list();
    expect(out.sources.map((s) => [s.name, s.configured])).toEqual([
      ["acme.example", false],
      ["Synap", true],
    ]);
  });
});

describe("marketplace.get", () => {
  it("returns the row with its definition resolved on demand", async () => {
    m.lookup.mockResolvedValue(entry("crm", "CRM", "template"));
    m.resolve.mockResolvedValue({ workspaceName: "CRM" });
    const out = await caller().get({ kind: "template", slug: "crm" });
    expect(m.lookup).toHaveBeenCalledWith("template", "crm", undefined);
    expect(out).toMatchObject({
      name: "CRM",
      definition: { workspaceName: "CRM" },
      definitionError: null,
      installed: null,
    });
  });

  it("reports a definition the source cannot serve as a field, not a failure", async () => {
    m.lookup.mockResolvedValue(entry("crm", "CRM", "template"));
    m.resolve.mockRejectedValue(new Error("Marketplace source unreachable"));
    const out = await caller().get({ kind: "template", slug: "crm" });
    expect(out.definition).toBeNull();
    expect(out.definitionError).toBe("Marketplace source unreachable");
  });

  it("is NOT_FOUND for an entry the cache does not hold", async () => {
    m.lookup.mockResolvedValue(null);
    await expect(
      caller().get({ kind: "capability", slug: "nope" })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("marketplace.preflight", () => {
  it("blocks a space-bound kind until a space is named", async () => {
    m.lookup.mockResolvedValue(entry("digest", "Digest", "automation"));
    m.resolve.mockResolvedValue({
      automations: [{ name: "Digest", triggerType: "cron" }],
    });
    const out = await caller().preflight({
      kind: "automation",
      slug: "digest",
    });
    expect(out.ok).toBe(false);
    expect(out.blockers).toEqual(["Choose the space to add it to."]);

    const named = await caller().preflight({
      kind: "automation",
      slug: "digest",
      workspaceId: WS,
    });
    expect(named.ok).toBe(true);
    expect(m.membership).toHaveBeenCalled();
  });

  it("refuses a space the caller is not a member of", async () => {
    m.lookup.mockResolvedValue(entry("digest", "Digest", "automation"));
    m.resolve.mockResolvedValue({ automations: [{ name: "Digest" }] });
    m.membership.mockResolvedValue(null);
    await expect(
      caller().preflight({
        kind: "automation",
        slug: "digest",
        workspaceId: WS,
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("runs the workspace preflight core for a template", async () => {
    m.lookup.mockResolvedValue(entry("crm", "CRM", "template"));
    m.resolve.mockResolvedValue({ profiles: [{ slug: "deal" }] });
    m.preflight.mockResolvedValue({ dryRun: true, ok: false });
    const out = await caller().preflight({ kind: "template", slug: "crm" });
    expect(out.workspace).toBe("creates");
    expect(out.report).toEqual({ dryRun: true, ok: false });
    expect(out.ok).toBe(false);
  });
});

describe("marketplace.install", () => {
  it("a person installs directly through runMarketInstall", async () => {
    m.run.mockResolvedValue({ status: "installed", result: { kind: "view" } });
    const out = await caller().install({
      kind: "view",
      slug: "boards",
      source: CP,
      workspaceId: WS,
    });
    expect(out.status).toBe("installed");
    expect(m.run).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "view",
        slug: "boards",
        source: CP,
        userId: "user-1",
        workspaceId: WS,
        agentUserId: null,
      })
    );
  });

  it("an agent's install takes the proposal path market.install takes", async () => {
    m.run.mockResolvedValue({
      status: "proposed",
      proposalId: "p-1",
      reviewUrl: "/open/p-1",
    });
    const out = await caller({
      agentUserId: "agent-1",
      keyType: "agent",
    }).install({ kind: "capability", slug: "gmail" });
    expect(out.status).toBe("proposed");
    expect(m.run).toHaveBeenCalledWith(
      expect.objectContaining({ agentUserId: "agent-1" })
    );
  });

  it("refuses any other key before the install core runs", async () => {
    const err = await caller({ keyType: "service", session: null })
      .install({ kind: "capability", slug: "gmail" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).code).toBe("FORBIDDEN");
    expect(m.run).not.toHaveBeenCalled();
  });
});
