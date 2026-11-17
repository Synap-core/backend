/**
 * `ask`'s time window (ticket a9888512) reaches BOTH entity lanes as a filter:
 * the semantic engine (`retrieve`, which applies it to every candidate source
 * before ranking) and the structured enumeration. The other lanes (runbooks,
 * facts, Library, catalog) have no `updatedAt` window and are read as before.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const retrieveMock = vi.fn();
const structuredLookupMock = vi.fn();

vi.mock("../../retrieval/retrieve.js", () => ({
  retrieve: (...args: unknown[]) => retrieveMock(...args),
}));
vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap/database")>()),
  db: {},
  knowledgeRepository: { searchFacts: vi.fn().mockResolvedValue([]) },
  knowledgeKeysRepository: { searchFullText: vi.fn().mockResolvedValue([]) },
}));
vi.mock("../../library/ask-lane.js", () => ({
  searchLibraryForAsk: vi.fn().mockResolvedValue({ items: [] }),
}));
vi.mock("../../../utils/pending-capture-dedup.js", () => ({
  findPendingTextMatches: vi.fn().mockResolvedValue([]),
}));
vi.mock("../structured.js", () => ({
  structuredLookup: (...args: unknown[]) => structuredLookupMock(...args),
}));

const { ask } = await import("../ask.js");

const WEEK = {
  since: new Date("2026-11-16T00:00:00.000Z"),
  until: new Date("2026-11-23T00:00:00.000Z"),
};

beforeEach(() => {
  retrieveMock.mockReset().mockResolvedValue({
    entities: [],
    understanding: { confidence: 0.9, profileTypes: ["task"] },
    verdict: "empty",
    source: "hybrid",
  });
  structuredLookupMock.mockReset().mockResolvedValue([]);
});

describe("ask — the window reaches both entity lanes", () => {
  it("hands the window to the semantic engine and the structured lane", async () => {
    await ask({
      query: "list my tasks",
      userId: "user-1",
      workspaceId: null,
      catalog: [{ slug: "task", displayName: "Task" }],
      window: WEEK,
    });
    expect(retrieveMock).toHaveBeenCalledTimes(1);
    expect(retrieveMock.mock.calls[0]![0]).toMatchObject({ window: WEEK });
    // Non-vacuity: the query routed to the structured lane.
    expect(structuredLookupMock).toHaveBeenCalledTimes(1);
    expect(structuredLookupMock.mock.calls[0]![0]).toMatchObject({
      profileSlug: "task",
      window: WEEK,
    });
  });

  it("no window: both lanes are told so (null), never a default window", async () => {
    await ask({
      query: "list my tasks",
      userId: "user-1",
      workspaceId: null,
      catalog: [{ slug: "task", displayName: "Task" }],
    });
    expect(retrieveMock.mock.calls[0]![0].window).toBeNull();
    expect(structuredLookupMock.mock.calls[0]![0].window).toBeNull();
  });
});
