import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the three substrate stores so we test ONLY the router's
// classify → route → fuse logic, not the underlying retrievers.
const retrieveMock = vi.fn();
const searchFullTextMock = vi.fn();
const searchFactsMock = vi.fn();

vi.mock("../retrieval/retrieve.js", () => ({
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
// The Wave-3 pending lane is covered by pending-text-match.test.ts; here it is a
// no-op so these tests stay focused on classify → route → fuse.
vi.mock("../../utils/pending-capture-dedup.js", () => ({
  findPendingTextMatches: vi.fn().mockResolvedValue([]),
}));

const { ask } = await import("./ask.js");

const baseParams = {
  userId: "user-1",
  workspaceId: null,
  catalog: [],
  limit: 5,
};

const semanticResult = {
  entities: [{ id: "e1", title: "Acme" }],
  understanding: { confidence: 0.9 },
  verdict: "confident",
  source: "hybrid",
};

beforeEach(() => {
  retrieveMock.mockReset().mockResolvedValue(semanticResult);
  searchFullTextMock
    .mockReset()
    .mockResolvedValue([{ key: "deploy", value: "How to deploy" }]);
  searchFactsMock
    .mockReset()
    .mockResolvedValue([{ id: "f1", fact: "noted X" }]);
});

describe("ask router", () => {
  it("a plain entity query hits ONLY semantic", async () => {
    const r = await ask({ ...baseParams, query: "the Acme project" });
    expect(retrieveMock).toHaveBeenCalledTimes(1);
    expect(searchFullTextMock).not.toHaveBeenCalled();
    expect(searchFactsMock).not.toHaveBeenCalled();
    expect(r.routedTo).toEqual(["semantic"]);
    expect(r.primary).toBe("semantic");
    expect(r.answers).toHaveLength(1);
    expect(r.answers[0].substrate).toBe("semantic");
    expect(r.answers[0].items).toEqual(semanticResult.entities);
    expect(r.answers[0].status).toBe("ok");
    expect(r.degraded).toEqual([]);
  });

  it("carries the semantic engine's understanding + verdict (glass-box)", async () => {
    const r = await ask({ ...baseParams, query: "the Acme project" });
    expect(r.understanding).toEqual(semanticResult.understanding);
    expect(r.verdict).toBe("confident");
  });

  it("a 'how to' query also hits procedural, primary-first", async () => {
    const r = await ask({ ...baseParams, query: "how to deploy the backend" });
    expect(searchFullTextMock).toHaveBeenCalledTimes(1);
    expect(searchFactsMock).not.toHaveBeenCalled();
    expect(r.routedTo).toContain("procedural");
    expect(r.primary).toBe("procedural");
    expect(r.answers[0].substrate).toBe("procedural"); // primary listed first
  });

  it("a 'what did I note' query also hits episodic, primary-first", async () => {
    const r = await ask({
      ...baseParams,
      query: "what did I note about pricing",
    });
    expect(searchFactsMock).toHaveBeenCalledTimes(1);
    expect(searchFullTextMock).not.toHaveBeenCalled();
    expect(r.primary).toBe("episodic");
    expect(r.answers[0].substrate).toBe("episodic");
  });

  it("orders three substrates primary-first, semantic-before-episodic for the rest", async () => {
    const r = await ask({ ...baseParams, query: "remember how to deploy" });
    // classifier: procedural primary, also episodic. semantic always runs.
    expect(r.routedTo).toEqual(["semantic", "procedural", "episodic"]);
    expect(r.answers.map((a) => a.substrate)).toEqual([
      "procedural", // primary
      "semantic", // then natural order
      "episodic",
    ]);
  });

  // ── Glass-box honesty: errored ≠ empty ────────────────────────────────────
  it("tags an errored ancillary store status:'error' + lists it in degraded (NOT a silent empty)", async () => {
    searchFullTextMock.mockRejectedValue(new Error("knowledge_keys down"));
    const r = await ask({ ...baseParams, query: "how to deploy" });
    const procedural = r.answers.find((a) => a.substrate === "procedural");
    expect(procedural?.status).toBe("error");
    expect(procedural?.items).toEqual([]);
    expect(r.degraded).toContain("procedural");
    // semantic (backbone) still answers
    const semantic = r.answers.find((a) => a.substrate === "semantic");
    expect(semantic?.items).toEqual(semanticResult.entities);
  });

  it("intent stays cued but primary FALLS BACK when the cued substrate is empty (dogfood: how-to → entity)", async () => {
    // "how to deploy …" cues procedural, but the deploy runbook is an ENTITY
    // (devplane_recipe), so knowledge_keys returns nothing and semantic answers.
    // primary must point where the answer actually is — never at an empty store.
    searchFullTextMock.mockResolvedValue([]);
    const r = await ask({
      ...baseParams,
      query: "how to deploy the intelligence service",
    });
    expect(r.intent).toBe("procedural"); // the cue is preserved (glass-box)
    expect(r.primary).toBe("semantic"); // but primary = the substrate that answered
    expect(r.answers[0].substrate).toBe("semantic"); // and it's listed first
  });

  it("primary stays the cued substrate when it DID answer", async () => {
    // default mock: searchFullText returns a row → procedural answered
    const r = await ask({ ...baseParams, query: "how to deploy the backend" });
    expect(r.intent).toBe("procedural");
    expect(r.primary).toBe("procedural");
  });

  it("a genuinely-empty ancillary store is status:'ok' (NOT degraded)", async () => {
    searchFullTextMock.mockResolvedValue([]);
    const r = await ask({ ...baseParams, query: "how to deploy" });
    const procedural = r.answers.find((a) => a.substrate === "procedural");
    expect(procedural?.status).toBe("ok");
    expect(procedural?.items).toEqual([]);
    expect(r.degraded).toEqual([]);
  });

  // ── Scoping (security): procedural must not read unfiltered ────────────────
  it("scopes procedural search to the user's namespace when no workspace lens is pinned", async () => {
    await ask({ ...baseParams, workspaceId: null, query: "how to deploy" });
    // workspaceId ?? userId — NEVER undefined (which is the unfiltered branch).
    expect(searchFullTextMock).toHaveBeenCalledWith(
      "how to deploy",
      "user-1",
      5
    );
  });

  it("uses the pinned workspace lens for procedural search when provided", async () => {
    await ask({ ...baseParams, workspaceId: "ws-9", query: "how to deploy" });
    expect(searchFullTextMock).toHaveBeenCalledWith("how to deploy", "ws-9", 5);
  });

  it("propagates limit to every routed store", async () => {
    await ask({ ...baseParams, limit: 3, query: "remember how to deploy" });
    expect(retrieveMock).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 3 })
    );
    expect(searchFullTextMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      3
    );
    expect(searchFactsMock).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 3 })
    );
  });

  it("passes the caller's lens (workspaceId) straight through to retrieve", async () => {
    await ask({ ...baseParams, workspaceId: "ws-9", query: "anything" });
    expect(retrieveMock).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws-9" })
    );
  });

  // ── parseOnly: the palette's "route without retrieving" fast path ──────────
  it("parseOnly returns understanding + routing and runs NO retrieval", async () => {
    const r = await ask({
      ...baseParams,
      catalog: [{ slug: "person", displayName: "Person", plural: "people" }],
      query: "show all people",
      parseOnly: true,
    });
    // Not a single store was touched.
    expect(retrieveMock).not.toHaveBeenCalled();
    expect(searchFullTextMock).not.toHaveBeenCalled();
    expect(searchFactsMock).not.toHaveBeenCalled();
    // understandQuery is NOT mocked, so this is the REAL inference — the palette
    // reads profileTypes to route "show all people" → the person listing.
    expect(r.understanding.profileTypes).toContain("person");
    // Glass-box routing is still classified — an enumerative lead is structured.
    expect(r.routedTo).toContain("structured");
    expect(r.primary).toBe("structured");
    // No retrieval ran → no answers, nothing degraded.
    expect(r.answers).toEqual([]);
    expect(r.degraded).toEqual([]);
  });
});
