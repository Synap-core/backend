import { describe, it, expect, vi } from "vitest";

// Mock the three substrate stores so we test ONLY the router's
// classify → route → fuse logic, not the underlying retrievers.
const retrieveMock = vi.fn();
const searchFullTextMock = vi.fn();
const searchFactsMock = vi.fn();
const libraryLaneMock = vi.fn();
const structuredLookupMock = vi.fn();

vi.mock("../../retrieval/retrieve.js", () => ({
  retrieve: (...args: unknown[]) => retrieveMock(...args),
}));
vi.mock("@synap/database", () => ({
  // `db` handle — only forwarded to the pending scan (mocked below); a bare
  // stub is enough for these router tests, which never touch a real store.
  db: {},
  knowledgeRepository: {
    searchFacts: (...args: unknown[]) => searchFactsMock(...args),
  },
  knowledgeKeysRepository: {
    searchFullText: (...args: unknown[]) => searchFullTextMock(...args),
  },
}));
// The Library lane has its own suite (library/__tests__/ask-lane.pglite.test.ts);
// here it is a stub so these tests stay on classify → route → fuse → degrade.
vi.mock("../../library/ask-lane.js", () => ({
  searchLibraryForAsk: (...args: unknown[]) => libraryLaneMock(...args),
}));
// The Wave-3 pending lane is covered by pending-text-match.test.ts; here it is a
// no-op so these tests stay focused on classify → route → fuse.
vi.mock("../../../utils/pending-capture-dedup.js", () => ({
  findPendingTextMatches: vi.fn().mockResolvedValue([]),
}));

vi.mock("../structured.js", () => ({
  structuredLookup: (...args: unknown[]) => structuredLookupMock(...args),
}));

const { ask } = await import("../ask.js");

describe("ask — structured block order", () => {
  it("leads with rows the semantic pass also hit, in semantic order", async () => {
    retrieveMock.mockReset().mockResolvedValue({
      entities: [{ id: "c" }, { id: "a" }],
      understanding: { confidence: 0.9, profileTypes: ["task"] },
      verdict: "confident",
      source: "hybrid",
    });
    searchFullTextMock.mockReset().mockResolvedValue([]);
    searchFactsMock.mockReset().mockResolvedValue([]);
    libraryLaneMock.mockReset().mockResolvedValue({ items: [] });
    // createdAt DESC order from the structured lane: a, b, c, d
    structuredLookupMock
      .mockReset()
      .mockResolvedValue([{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }]);
    const r = await ask({
      userId: "user-1",
      workspaceId: null,
      catalog: [{ slug: "task", displayName: "Task" }],
      limit: 5,
      query: "list my tasks",
    });
    const structured = r.answers.find((a) => a.substrate === "structured");
    expect(structured?.items.map((i) => (i as { id: string }).id)).toEqual([
      "c",
      "a",
      "b",
      "d",
    ]);
  });
});
