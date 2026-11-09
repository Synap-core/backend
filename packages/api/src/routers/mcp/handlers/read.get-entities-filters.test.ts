/**
 * synap_get_entities forwards `filters` and `includeFacets` to the core list.
 *
 * Before: the tool declared neither and the handler passed neither, so a caller
 * that sent `filters` got the WHOLE kind back with a 200 (the filter silently
 * ignored: the doors audit 1bb7b083). Now both reach `getEntities` (the Hub
 * forwarder, then `entities.list`), a malformed filter is an error the agent
 * reads, and a lean row keeps the facets the caller asked for.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { projectLean } = vi.hoisted(() => ({
  projectLean: vi.fn(
    async (rows: unknown[], _options?: { fields?: string[] }) => rows
  ),
}));
vi.mock("../../../services/entity-lean-list.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../services/entity-lean-list.js")
  >()),
  projectLeanEntityList: projectLean,
}));

// The role lookup a lean list makes before listing (`leanListedUnderRole`):
// `lead` is a role here, every other slug a kind.
vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveSlugKind: vi.fn(async (_db: unknown, slug: string) => ({
    hasKindRow: slug !== "lead",
    hasRoleRow: slug === "lead",
  })),
}));

import { readHandlers } from "./read.js";
import type { McpToolContext } from "./shared.js";

const getEntities = vi.fn(async (_input: Record<string, unknown>) => [
  { id: "e1" },
]);

const run = (args: Record<string, unknown>) =>
  readHandlers.synap_get_entities!({
    toolName: "synap_get_entities",
    args,
    userId: "user-1",
    apiKeyScopes: ["mcp.read"],
    caller: {
      entities: { getEntities },
    } as unknown as McpToolContext["caller"],
    lensCaller: {} as McpToolContext["lensCaller"],
    workspaceAccessible: true,
  } as McpToolContext);

const text = (r: Awaited<ReturnType<typeof run>>) => {
  const b = r.content?.[0];
  if (!b || b.type !== "text") throw new Error("expected text");
  return b.text;
};

const FILTER = { field: "properties.stage", operator: "equals", value: "won" };

beforeEach(() => {
  getEntities.mockClear();
  projectLean.mockClear();
});

describe("synap_get_entities filters + includeFacets", () => {
  it("forwards a filters array to the core list", async () => {
    await run({ profileSlug: "deal", filters: [FILTER] });
    expect(getEntities.mock.calls[0]![0]).toMatchObject({ filters: [FILTER] });
  });

  it("accepts the same filters as the Hub's JSON string", async () => {
    await run({ profileSlug: "deal", filters: JSON.stringify([FILTER]) });
    expect(getEntities.mock.calls[0]![0]).toMatchObject({ filters: [FILTER] });
  });

  it("forwards includeFacets and returns facets on lean rows", async () => {
    await run({ profileSlug: "person", includeFacets: true });
    expect(getEntities.mock.calls[0]![0]).toMatchObject({
      includeFacets: true,
    });
    const options = projectLean.mock.calls[0]![1] as { fields?: string[] };
    expect(options.fields).toEqual(
      expect.arrayContaining(["facets", "facetSlugs"])
    );
  });

  it("a malformed filter is an error, never a silent unfiltered list", async () => {
    const r = await run({
      profileSlug: "deal",
      filters: [{ field: "properties.stage", operator: "nope", value: 1 }],
    });
    expect(text(r)).toContain("Invalid filters");
    expect(getEntities).not.toHaveBeenCalled();
  });

  it("unparseable JSON is an error", async () => {
    const r = await run({ profileSlug: "deal", filters: "[{" });
    expect(text(r)).toContain("filters must be");
    expect(getEntities).not.toHaveBeenCalled();
  });

  it("a property filter without a kind is an error", async () => {
    const r = await run({ filters: [FILTER] });
    expect(text(r)).toContain("needs profileSlug");
    expect(getEntities).not.toHaveBeenCalled();
  });
});

describe("synap_get_entities listed under a role", () => {
  const STATUS = { field: "status", operator: "equals", value: "qualified" };

  it("a role list loads the facet rows and projects lean rows under the role", async () => {
    await run({ profileSlug: "lead", filters: [STATUS] });
    expect(getEntities.mock.calls[0]![0]).toMatchObject({
      profileSlug: "lead",
      filters: [STATUS],
      includeFacets: true,
    });
    expect(projectLean.mock.calls[0]![1]).toMatchObject({
      listedUnder: "lead",
    });
  });

  it("control: a kind list loads no facets and is not listed under a role", async () => {
    await run({ profileSlug: "deal", filters: [STATUS] });
    expect(getEntities.mock.calls[0]![0]).not.toHaveProperty("includeFacets");
    expect(projectLean.mock.calls[0]![1]).not.toHaveProperty("listedUnder");
  });
});
