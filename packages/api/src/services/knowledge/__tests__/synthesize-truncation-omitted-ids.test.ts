/**
 * GUARD — a truncated `ask` must be CONTINUABLE, not merely confessed.
 *
 * Live defect (2026-09-20, reproduced twice with different wording):
 *   "Note: The context provided is partial — only 16 of 20 retrieved items are
 *    shown above. The full answer may require reviewing the 4 omitted items."
 * Honest and unusable: no cursor, no ids, no follow-up call. The agent was told
 * its answer was incomplete and given no door to complete it.
 *
 * Root cause found by running the code, not reading it: `SynthesisResult.truncated`
 * was DECLARED on the result type and FORWARDED by all three doors (MCP
 * `synap_ask`, hub `POST /knowledge/answer`, tRPC `knowledge.answer`) — and
 * `buildSynthesisContext` never put it in its return object. Every caller got
 * `undefined`; the only signal that ever reached a reader was the model
 * re-narrating the prose `[NOTICE]` line out of the context.
 *
 * These tests assert REACHABILITY — the omitted items' ids ARRIVE at the door —
 * not that a key is declared. That distinction is the whole defect.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { getDefaultActiveService, askMock } = vi.hoisted(() => ({
  getDefaultActiveService: vi.fn(),
  askMock: vi.fn(),
}));

vi.mock("../../../utils/intelligence-routing.js", () => ({
  getDefaultActiveService,
}));
vi.mock("../ask.js", () => ({ ask: askMock }));
// The lens/catalog resolution reads the DB; it is not what this file tests
// (covered by __tripwires__/knowledge-lens-door-parity.test.ts).
vi.mock("../resolve-lens.js", () => ({
  resolveKnowledgeLens: async () => ({ workspaceId: null, catalog: [] }),
}));

import { buildSynthesisContext, synthesizeAnswer } from "../synthesize.js";
import type { AskAnswer } from "../ask.js";
import { readHandlers } from "../../../routers/mcp/handlers/read.js";
import type { McpToolContext } from "../../../routers/mcp/handlers/shared.js";

/** Big enough that the 20k context budget must drop most of it. */
function overflowingAnswers(count = 20, bodyChars = 1500): AskAnswer[] {
  return [
    {
      substrate: "structured",
      status: "ok",
      items: Array.from({ length: count }, (_, i) => ({
        id: `ent-${i}`,
        title: `Entity ${i}`,
        content: "z".repeat(bodyChars),
      })),
    },
  ] as unknown as AskAnswer[];
}

describe("buildSynthesisContext — the omission names the items it dropped", () => {
  it("returns `truncated` at all (it was declared and never populated)", () => {
    const result = buildSynthesisContext(overflowingAnswers());
    expect(result.truncated).toBeDefined();
  });

  it("carries a fetchable id for every omitted item, not just a count", () => {
    const { truncated } = buildSynthesisContext(overflowingAnswers());
    expect(truncated!.omitted).toBeGreaterThan(0);
    expect(truncated!.total).toBe(20);
    // The LIST is the point: a count is a confession, ids are a door.
    expect(truncated!.omittedSources).toHaveLength(truncated!.omitted);
    for (const s of truncated!.omittedSources) {
      expect(s.id).toMatch(/^ent-\d+$/);
      expect(s.substrate).toBe("structured");
      expect(s.title).toMatch(/^Entity \d+$/);
    }
  });

  it("names EXACTLY the items the context left out — no overlap, no gap", () => {
    const { context, sources, truncated } =
      buildSynthesisContext(overflowingAnswers());
    const omittedIds = new Set(truncated!.omittedSources.map((s) => s.id));
    const admitted = sources.filter((s) => !omittedIds.has(s.id));
    // Every admitted item's text is in the context; every omitted one's is not.
    // (Titles are unique per item, so this is a real per-item check.)
    for (const s of admitted) expect(context).toContain(s.title);
    for (const s of truncated!.omittedSources) {
      // `Entity 1` is a prefix of `Entity 12`, so match the entry delimiter.
      expect(context).not.toContain(`] ${s.title} ·`);
    }
    expect(admitted.length + omittedIds.size).toBe(20);
  });

  it("is ABSENT when nothing was dropped (no false partial-answer alarm)", () => {
    const { truncated } = buildSynthesisContext(overflowingAnswers(3, 100));
    expect(truncated).toBeUndefined();
  });
});

describe("synthesizeAnswer — the ids survive BOTH synthesis outcomes", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it("forwards omitted ids when synthesis SUCCEEDS", async () => {
    getDefaultActiveService.mockResolvedValue({
      endpoint: "http://is.test",
      apiKey: "k",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ answer: "a partial answer" }),
      })
    );
    const res = await synthesizeAnswer(
      overflowingAnswers(),
      "q",
      ["structured"],
      null
    );
    expect(res.answer).toBe("a partial answer");
    expect(res.truncated?.omittedSources.length).toBe(res.truncated?.omitted);
    expect(res.truncated!.omittedSources[0]!.id).toMatch(/^ent-\d+$/);
  });

  it("forwards omitted ids when synthesis FAILS (where the prose dies)", async () => {
    getDefaultActiveService.mockRejectedValue(new Error("IS down"));
    const res = await synthesizeAnswer(
      overflowingAnswers(),
      "q",
      ["structured"],
      null
    );
    expect(res.error).toBe("synthesis_unavailable");
    // The prose [NOTICE] never reaches anyone on this path — the structured
    // omission is the ONLY signal, so it must be here.
    expect(res.truncated!.omittedSources[0]!.id).toMatch(/^ent-\d+$/);
  });
});

describe("synap_ask (MCP door) — the omitted ids reach the agent", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it("returns truncated.omittedSources in the tool result payload", async () => {
    askMock.mockResolvedValue({
      answers: overflowingAnswers(),
      routedTo: ["structured"],
      degraded: [],
      pending: null,
      understanding: {},
    });
    getDefaultActiveService.mockResolvedValue({
      endpoint: "http://is.test",
      apiKey: "k",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ answer: "a partial answer" }),
      })
    );

    const ctx = {
      toolName: "synap_ask",
      args: { query: "list everything" },
      userId: "user-1",
      apiKeyScopes: ["mcp.read"],
      workspaceId: null,
      caller: {
        profiles: { listProfiles: vi.fn().mockResolvedValue({ profiles: [] }) },
      },
      lensCaller: {},
      workspaceAccessible: false,
    } as unknown as McpToolContext;

    const result = await readHandlers.synap_ask!(ctx);
    const text = (result.content as { type: string; text: string }[])
      .map((c) => c.text)
      .join("");
    const payload = JSON.parse(text) as {
      truncated?: {
        omitted: number;
        total: number;
        omittedSources: { id: string }[];
      };
    };
    expect(payload.truncated).toBeDefined();
    expect(payload.truncated!.total).toBe(20);
    expect(payload.truncated!.omittedSources.length).toBe(
      payload.truncated!.omitted
    );
    expect(payload.truncated!.omittedSources[0]!.id).toMatch(/^ent-\d+$/);
  });
});
