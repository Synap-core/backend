/**
 * `market.search` / `market.install` and catalog sources (Pod Console D11):
 *   - search reads Synap plus trusted sources that let agents propose — a
 *     showcase or opted-out source's listings never reach an agent unless it
 *     names that source, and a blocked source is never read;
 *   - an added source's entry says where it comes from and how it installs;
 *   - install reads a source-qualified id (`acme/crm`) as that source, a bare
 *     slug as Synap's, and never reads a cell's package segment as a source.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  query: vi.fn(),
  run: vi.fn(),
  views: vi.fn(),
}));

vi.mock("./catalog-cache-query.js", () => ({
  queryCatalogCache: (...a: unknown[]) => m.query(...a),
}));
vi.mock("./marketplace-install.js", () => ({
  runMarketInstall: (...a: unknown[]) => m.run(...a),
}));
vi.mock("./market-sources.js", () => ({
  listMarketSources: (...a: unknown[]) => m.views(...a),
}));

import { BUILTIN_VERBS } from "./builtin-verbs.js";

const CP = "https://cp.synap.live";
const view = (
  id: string,
  over: Record<string, unknown> = {},
  blocked: string | null = null
) => ({
  source: {
    id,
    cacheKey: id === "synap" ? CP : id,
    name: id.toUpperCase(),
    official: id === "synap",
    trust: id === "synap" ? "official" : "trusted",
    agentsMayPropose: id === "synap",
    ...over,
  },
  gate: { blocked },
  status: null,
});

const CTX = { userId: "u-1", workspaceId: null, agentUserId: "agent-1" };

beforeEach(() => {
  m.query.mockReset();
  m.run.mockReset();
  m.views.mockResolvedValue([
    view("synap"),
    view("acme", { agentsMayPropose: true }),
    view("quiet"),
    view("show", { trust: "showcase" }),
    view("gone", { agentsMayPropose: true }, "key changed"),
  ]);
});

describe("market.search", () => {
  it("reads Synap and the trusted sources that let agents propose — nothing blocked", async () => {
    m.query.mockResolvedValue([
      { source: CP, kind: "template", slug: "crm", name: "CRM" },
      { source: "acme", kind: "template", slug: "crm", name: "Acme CRM" },
    ]);
    const out = (await BUILTIN_VERBS["market.search"]!(
      { query: "crm" },
      CTX as never
    )) as {
      entries: Array<Record<string, unknown>>;
    };
    expect(m.query).toHaveBeenCalledWith(
      expect.objectContaining({ sources: [CP, "acme"] })
    );
    expect(out.entries[0]).not.toHaveProperty("source");
    expect(out.entries[1]).toMatchObject({
      id: "acme/crm",
      source: "acme",
      trust: "trusted",
      installable: "propose — a person reviews it",
    });
  });

  it("reads a named source only — and refuses a blocked one", async () => {
    m.query.mockResolvedValue([]);
    await BUILTIN_VERBS["market.search"]!({ source: "show" }, CTX as never);
    expect(m.query).toHaveBeenCalledWith(
      expect.objectContaining({ sources: ["show"] })
    );
    const out = (await BUILTIN_VERBS["market.search"]!(
      { source: "gone" },
      CTX as never
    )) as {
      message: string;
    };
    expect(out.message).toMatch(/not a catalog source/);
  });
});

describe("market.install — which source", () => {
  it("a qualified id names its source; a bare slug is Synap's", async () => {
    m.run.mockResolvedValue({ status: "proposed" });
    await BUILTIN_VERBS["market.install"]!(
      { slug: "acme/crm", kind: "template" },
      CTX as never
    );
    expect(m.run).toHaveBeenLastCalledWith(
      expect.objectContaining({
        slug: "crm",
        source: "acme",
        agentUserId: "agent-1",
      })
    );
    await BUILTIN_VERBS["market.install"]!(
      { slug: "crm", kind: "template" },
      CTX as never
    );
    expect(m.run).toHaveBeenLastCalledWith(
      expect.objectContaining({ slug: "crm", source: undefined })
    );
  });

  it("an unknown prefix is part of the slug, and a cell's package is never a source", async () => {
    m.run.mockResolvedValue({ status: "proposed" });
    await BUILTIN_VERBS["market.install"]!(
      { slug: "evil/crm", kind: "template" },
      CTX as never
    );
    expect(m.run).toHaveBeenLastCalledWith(
      expect.objectContaining({ slug: "evil/crm", source: undefined })
    );
    await BUILTIN_VERBS["market.install"]!(
      { slug: "acme/bar", kind: "cell" },
      CTX as never
    );
    expect(m.run).toHaveBeenLastCalledWith(
      expect.objectContaining({ slug: "acme/bar", source: undefined })
    );
  });
});
