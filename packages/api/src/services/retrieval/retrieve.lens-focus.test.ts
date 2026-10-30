/**
 * Structural plan S1: a FOCUS boosts, it never filters. The recall passes run
 * exactly as without it (no workspace / project narrowing), and the ranker
 * lifts in-focus rows. An explicit workspaceId stays the passes' filter.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const hybridRecallMock = vi.fn();
const FOCUS_WS = "ws-focus";
const FOCUS_PROJECT = "project-1";

// The fused pool, best first: ten rows from elsewhere, then one in focus.
const POOL = Array.from({ length: 11 }, (_, i) => ({
  id: i === 10 ? "focused" : `r${i}`,
  title: `row ${i}`,
  type: "note",
  properties: null,
  updatedAt: new Date("2026-06-01T00:00:00Z"),
  workspaceId: i === 10 ? FOCUS_WS : "ws-other",
  homeWorkspaceId: null,
  documentId: null,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  // fetchOrdered selects whole rows; resolveProjectIds selects `{ id }`.
  const entityChain = {
    from: () => entityChain,
    where: async () => POOL,
  };
  const relationChain = {
    from: () => relationChain,
    where: async () => [{ id: "r8" }],
  };
  return {
    ...actual,
    db: {
      select: (cols?: Record<string, unknown>) =>
        cols ? relationChain : entityChain,
    },
    entities: {},
    relations: {},
    and: vi.fn(),
    eq: vi.fn(),
    inArray: vi.fn(),
    isNull: vi.fn(),
    loadFacetSlugsBatch: async () => new Map(),
    listableEntityWhere: vi.fn(),
    loadDocumentBodyTexts: async () => ({
      texts: new Map(),
      failed: new Map(),
    }),
  };
});
vi.mock("../../utils/project-scope.js", () => ({
  projectLensWhere: vi.fn(),
  BELONGS_TO_PROJECT: "belongs_to_project",
}));
vi.mock("../../utils/workspace-membership.js", () => ({
  resolveFacetVisibilityScope: async () => undefined,
}));
vi.mock("./hybrid-recall.js", () => ({
  embedQuery: async () => ({ embedding: null, degraded: false }),
  hybridRecall: (...a: unknown[]) => hybridRecallMock(...a),
  // Order-preserving fusion over one list is all this test needs.
  rrf: (lists: string[][], _k?: number, limit?: number) => {
    const ids = [...new Set(lists.flat())];
    return limit ? ids.slice(0, limit) : ids;
  },
}));
vi.mock("./graph-signal.js", () => ({ graphExpand: async () => [] }));
vi.mock("./rank-strategy.js", () => ({
  resolveRankStrategy: async () => "baseline",
}));

const { retrieve } = await import("./retrieve.js");

const run = (over: Partial<Parameters<typeof retrieve>[0]> = {}) =>
  retrieve({
    query: "what do we know about the release",
    userId: "u",
    workspaceId: null,
    catalog: [],
    ...over,
  });
const ids = (r: { entities: Record<string, unknown>[] }) =>
  r.entities.map((e) => e.id as string);

beforeEach(() => {
  hybridRecallMock
    .mockReset()
    .mockResolvedValue({ ids: POOL.map((r) => r.id), usedVector: false });
});

describe("retrieve — focus boosts, never filters", () => {
  it("a focused row is boosted, and every unfocused row is still returned", async () => {
    const plain = await run();
    const focused = await run({ focus: { workspaceId: FOCUS_WS } });
    expect(ids(plain).indexOf("focused")).toBe(10);
    expect(ids(focused).indexOf("focused")).toBeLessThan(10);
    expect(new Set(ids(focused))).toEqual(new Set(ids(plain))); // no hiding
    expect(ids(focused)[0]).toBe("r0"); // bounded: the top hit stays first
  });

  it("the focus never reaches a recall pass as a filter", async () => {
    await run({ focus: { workspaceId: FOCUS_WS, projectId: FOCUS_PROJECT } });
    expect(hybridRecallMock).toHaveBeenCalled();
    for (const [p] of hybridRecallMock.mock.calls) {
      expect(p).toMatchObject({ workspaceId: null, projectIds: undefined });
    }
  });

  it("a focus project lifts its members (membership read once, as a weight)", async () => {
    const focused = await run({ focus: { projectId: FOCUS_PROJECT } });
    // r8 belongs to the project: 0.5 affinity × 0.3 × span 10 = 1.5 positions.
    expect(ids(focused).indexOf("r8")).toBeLessThan(8);
    expect(ids(focused)).toHaveLength(POOL.length);
  });

  it("an explicit workspaceId is still the passes' filter", async () => {
    await run({ workspaceId: FOCUS_WS });
    for (const [p] of hybridRecallMock.mock.calls) {
      expect(p).toMatchObject({ workspaceId: FOCUS_WS });
    }
  });
});
