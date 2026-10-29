/**
 * `searchWeb` (the `web.search` verb): it runs a provider the caller NAMED, or
 * the one installed (`search_web`, 0360), through `executeCapability`, and
 * every other path is an honest `blocked` / `failed` that ran nothing.
 */
import { describe, it, expect, vi } from "vitest";
import { searchWeb, type WebSearchDeps } from "./web-search.js";
import type { IntentVerbMatch } from "./capability-intent-index.js";
import type { CatalogCacheEntry } from "./catalog-cache-query.js";

// The production lookup, for the one test that does not inject `listProviders`.
vi.mock("./capability-intent-index.js", () => ({
  capabilitiesByIntent: vi.fn(),
}));

const CTX = {
  userId: "user-1",
  workspaceId: null,
  agentUserId: "agent-1",
  sessionId: "session-1",
};

function match(
  verbId: string,
  capabilityName: string,
  ready = true
): IntentVerbMatch {
  return {
    intent: "search_web",
    verbId,
    verbLabel: verbId,
    verbKind: "read",
    granted: false,
    runPosture: "auto",
    backingSkillExecutable: ready,
    sourceKind: "skill",
    capabilityId: `cap-${verbId}`,
    capabilityName,
  };
}

function catalogEntry(
  slug: string,
  name: string,
  skills: Array<{ name: string; intent?: string }>
): CatalogCacheEntry {
  return {
    source: "https://cp.synap.live",
    kind: "capability",
    slug,
    name,
    description: null,
    version: null,
    tier: null,
    vendor: null,
    tags: null,
    contentHash: null,
    definition: { key: slug, skills },
    listing: null,
  };
}

const CATALOG = [
  catalogEntry("exa", "Exa — Web Search", [
    { name: "exa_search", intent: "search_web" },
    { name: "exa_find_similar", intent: "search_external" },
  ]),
  catalogEntry("notion", "Notion", [
    { name: "notion_search", intent: "search_external" },
  ]),
  catalogEntry("gmail", "Gmail", [{ name: "gmail_send" }]),
];

const INSTALLED = [
  match("web.search", "Synap Core"),
  match("brave_search", "Brave Search"),
  match("exa_search", "Exa — Neural Web Search"),
];

function deps(
  over: Partial<WebSearchDeps> = {}
): WebSearchDeps & { execute: ReturnType<typeof vi.fn> } {
  return {
    listProviders: async () => INSTALLED,
    listCatalog: async () => CATALOG,
    execute: vi.fn(async () => ({
      kind: "run" as const,
      skillId: "skill-exa",
      result: { results: [{ url: "https://synap.live" }] },
      ackState: "applied" as const,
      correlationId: "corr-1",
    })),
    ...over,
  } as WebSearchDeps & { execute: ReturnType<typeof vi.fn> };
}

describe("searchWeb", () => {
  it("with several providers and none named, runs nothing and lists the ones the caller may name", async () => {
    const d = deps();
    const out = await searchWeb(CTX, "synap", {}, d);
    expect(d.execute).not.toHaveBeenCalled();
    expect(out.search).toMatchObject({
      status: "blocked",
      reason: "no_provider",
      nextStep: "name_provider",
    });
    // Never itself, sorted, with the capability that names the provider.
    expect(out.providers).toEqual([
      { verbId: "brave_search", capabilityName: "Brave Search", ready: true },
      {
        verbId: "exa_search",
        capabilityName: "Exa — Neural Web Search",
        ready: true,
      },
    ]);
  });

  it("with none named, runs the one installed provider", async () => {
    const d = deps({
      listProviders: async () => [
        match("web.search", "Synap Core"),
        match("exa_search", "Exa — Neural Web Search"),
      ],
    });
    const out = await searchWeb(CTX, "synap", {}, d);
    expect(d.execute).toHaveBeenCalledTimes(1);
    expect(d.execute.mock.calls[0]![0]).toMatchObject({
      verbId: "exa_search",
      parameters: { query: "synap" },
    });
    expect(out.search).toMatchObject({ status: "ok", provider: "exa_search" });
  });

  it("with none named, the only READY provider wins over ones not enabled", async () => {
    const d = deps({
      listProviders: async () => [
        match("brave_search", "Brave Search", false),
        match("exa_search", "Exa — Neural Web Search"),
      ],
    });
    const out = await searchWeb(CTX, "synap", {}, d);
    expect(d.execute.mock.calls[0]![0]).toMatchObject({
      verbId: "exa_search",
    });
    expect(out.search).toMatchObject({ status: "ok", provider: "exa_search" });
  });

  it("with none named and none ready, the only installed one runs so its gate can ask to enable it", async () => {
    const d = deps({
      listProviders: async () => [match("exa_search", "Exa", false)],
      execute: vi.fn(async () => ({
        kind: "deny" as const,
        reason: "not approved",
        enableProposal: { status: "proposed", proposalId: "prop-1" },
      })) as never,
    });
    const out = await searchWeb(CTX, "synap", {}, d);
    expect(d.execute).toHaveBeenCalledTimes(1);
    expect(out.search).toMatchObject({
      status: "blocked",
      reason: "not_enabled",
      provider: "exa_search",
      proposalId: "prop-1",
    });
  });

  it("with none named and several installed but none ready, runs nothing", async () => {
    const d = deps({
      listProviders: async () => [
        match("brave_search", "Brave Search", false),
        match("exa_search", "Exa", false),
      ],
    });
    const out = await searchWeb(CTX, "synap", {}, d);
    expect(d.execute).not.toHaveBeenCalled();
    expect(out.search).toMatchObject({
      status: "blocked",
      nextStep: "name_provider",
    });
  });

  it("looks providers up by search_web, never search_external", async () => {
    const { capabilitiesByIntent } =
      await import("./capability-intent-index.js");
    vi.mocked(capabilitiesByIntent).mockResolvedValueOnce([]);
    const out = await searchWeb(
      CTX,
      "synap",
      {},
      { listCatalog: async () => [] }
    );
    expect(capabilitiesByIntent).toHaveBeenCalledWith(
      { userId: "user-1", workspaceId: null },
      "search_web"
    );
    expect(out.search).toMatchObject({ nextStep: "install_provider" });
  });

  it("with nothing installed, offers the catalog's web search providers to install on the person's own key", async () => {
    const d = deps({ listProviders: async () => [match("web.search", "x")] });
    const out = await searchWeb(CTX, "synap", {}, d);
    expect(d.execute).not.toHaveBeenCalled();
    expect(out.search).toMatchObject({
      status: "blocked",
      reason: "no_provider",
      nextStep: "install_provider",
    });
    // Only the capability with a search_web verb: never a notes search, never
    // a capability with no search verb.
    expect(
      out.search.status === "blocked" ? out.search.install : undefined
    ).toEqual([
      {
        slug: "exa",
        name: "Exa — Web Search",
        verbs: ["exa_search"],
        hint: 'Add "Exa — Web Search" to install its verbs.',
      },
    ]);
    expect(out.search.status === "blocked" ? out.search.detail : "").toContain(
      'market.install({ slug, kind: "capability" })'
    );
    expect(out.providers).toEqual([]);
  });

  it("with nothing installed and nothing in the catalog, points to market.search", async () => {
    const d = deps({
      listProviders: async () => [],
      listCatalog: async () => [],
    });
    const out = await searchWeb(CTX, "synap", {}, d);
    expect(out.search).toMatchObject({
      status: "blocked",
      nextStep: "install_provider",
      install: [],
    });
    expect(out.search.status === "blocked" ? out.search.detail : "").toContain(
      "market.search"
    );
  });

  it("a failed catalog read throws — never answered as 'nothing to install'", async () => {
    const d = deps({
      listProviders: async () => [],
      listCatalog: async () => {
        throw new Error("catalog cache down");
      },
    });
    await expect(searchWeb(CTX, "synap", {}, d)).rejects.toThrow(
      "catalog cache down"
    );
  });

  it("with a provider installed, the catalog is never read", async () => {
    const listCatalog = vi.fn(async () => CATALOG);
    const d = deps({
      listProviders: async () => [match("exa_search", "Exa")],
      listCatalog,
    });
    await searchWeb(CTX, "synap", {}, d);
    expect(listCatalog).not.toHaveBeenCalled();
  });

  it("a named verb that is not an installed provider fails and runs nothing", async () => {
    const d = deps();
    for (const provider of ["entity.delete", "web.search", "notion_search"]) {
      const out = await searchWeb(CTX, "synap", { provider }, d);
      expect(out.search).toMatchObject({ status: "failed", provider });
    }
    expect(d.execute).not.toHaveBeenCalled();
  });

  it("runs the named provider through the capability door, as the caller, in the session", async () => {
    const d = deps();
    const out = await searchWeb(CTX, "synap", { provider: "exa_search" }, d);
    expect(d.execute).toHaveBeenCalledTimes(1);
    expect(d.execute).toHaveBeenCalledWith({
      verbId: "exa_search",
      parameters: { query: "synap" },
      userId: "user-1",
      workspaceId: null,
      agentUserId: "agent-1",
      sessionId: "session-1",
      observability: "mirror",
    });
    expect(out.search).toEqual({
      status: "ok",
      provider: "exa_search",
      result: { results: [{ url: "https://synap.live" }] },
      correlationId: "corr-1",
    });
  });

  it("a provider that is not enabled is blocked with its enable request", async () => {
    const d = deps({
      execute: vi.fn(async () => ({
        kind: "deny" as const,
        reason: "not approved",
        enableProposal: {
          status: "proposed",
          proposalId: "prop-1",
        },
      })) as never,
    });
    const out = await searchWeb(CTX, "synap", { provider: "exa_search" }, d);
    expect(out.search).toMatchObject({
      status: "blocked",
      reason: "not_enabled",
      nextStep: "enable_provider",
      proposalId: "prop-1",
    });
  });

  it("a provider run that failed is failed, with its class", async () => {
    const d = deps({
      execute: vi.fn(async () => ({
        kind: "error" as const,
        message: "Exa is down",
        errorClass: "transient" as const,
      })) as never,
    });
    const out = await searchWeb(CTX, "synap", { provider: "exa_search" }, d);
    expect(out.search).toEqual({
      status: "failed",
      provider: "exa_search",
      error: "Exa is down",
      errorClass: "transient",
    });
  });

  it("a failed provider lookup throws — never answered as 'none installed'", async () => {
    const d = deps({
      listProviders: async () => {
        throw new Error("registry down");
      },
    });
    await expect(searchWeb(CTX, "synap", {}, d)).rejects.toThrow(
      "registry down"
    );
  });
});
