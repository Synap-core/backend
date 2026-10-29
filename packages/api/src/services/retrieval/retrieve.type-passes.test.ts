/**
 * Type-scoped recall passes fuse at equal RRF weight, so they run only for a
 * list-shaped query: a technical query that contains "events" must not pull
 * calendar events to the top.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const hybridRecallMock = vi.fn();

vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap/database")>()),
  db: {},
  entities: {},
  relations: {},
  and: vi.fn(),
  eq: vi.fn(),
  inArray: vi.fn(),
  isNull: vi.fn(),
  loadFacetSlugsBatch: vi.fn(),
  listableEntityWhere: vi.fn(),
  loadDocumentBodyTexts: vi.fn(),
}));
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
  rrf: () => [],
}));
vi.mock("./graph-signal.js", () => ({ graphExpand: async () => [] }));

const { retrieve } = await import("./retrieve.js");

const catalog = [{ slug: "event", displayName: "Event" }];
const run = (query: string) =>
  retrieve({ query, userId: "u", workspaceId: null, catalog });
const scoped = () =>
  hybridRecallMock.mock.calls.filter(
    ([p]) => (p as { profileSlug?: string }).profileSlug === "event"
  );

beforeEach(() => {
  hybridRecallMock
    .mockReset()
    .mockResolvedValue({ ids: [], usedVector: false });
});

describe("retrieve — type-scoped passes", () => {
  it("runs none for a technical query that contains a kind word", async () => {
    await run("events API 200 limit paging offset gotcha");
    expect(scoped()).toHaveLength(0);
  });

  it("runs the event pass for a list-shaped query", async () => {
    await run("show my events next week");
    expect(scoped().length).toBeGreaterThan(0);
  });
});
