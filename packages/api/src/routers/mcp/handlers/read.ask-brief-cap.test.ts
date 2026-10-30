/**
 * `synap_ask` with `detail: "brief"` caps the whole envelope AT THE DOOR.
 *
 * WHY: `capBriefEnvelope` capped `truncated.omittedSources`, but the MCP
 * handler spread the uncapped synthesis back over the reply, so a live brief
 * on 30 Oct carried 8 omitted sources against a cap of 5. The helper's own
 * test passed; only a test through the handler sees the reply the agent reads.
 *
 * WHAT IS REAL: the handler, `ask()`, `capBriefEnvelope`. WHAT IS STUBBED:
 * I/O only — the lens resolver, retrieval, synthesis and the pending scan.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  synthesisError: false,
}));

const source = (i: number) => ({
  substrate: "procedural",
  id: `src-${i}`,
  title: `source ${i}`,
});

vi.mock("../../../services/knowledge/resolve-lens.js", () => ({
  resolveKnowledgeLens: async () => ({ workspaceId: null, catalog: [] }),
}));

vi.mock("../../../services/retrieval/retrieve.js", () => ({
  retrieve: async () => ({
    entities: [],
    understanding: {
      profileTypes: [],
      propertyHints: [],
      temporal: false,
      confidence: 1,
      cleanedQuery: "",
    },
    source: "typesense",
    vectorDown: false,
    verdict: "empty",
  }),
}));

vi.mock(
  "../../../services/knowledge/synthesize.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../../services/knowledge/synthesize.js")
    >()),
    synthesizeAnswer: async () => ({
      answer: h.synthesisError ? null : "ok",
      ...(h.synthesisError
        ? { error: "synthesis_unavailable", failureClass: "unknown" }
        : {}),
      routedTo: ["procedural"],
      sources: Array.from({ length: 8 }, (_, i) => source(i)),
      truncated: {
        omitted: 8,
        total: 16,
        omittedSources: Array.from({ length: 8 }, (_, i) => source(100 + i)),
      },
    }),
  })
);

vi.mock("../../../utils/pending-capture-dedup.js", () => ({
  findPendingTextMatches: async () => [],
}));

const { readHandlers } = await import("./read.js");

async function askMcp(detail: string): Promise<Record<string, any>> {
  const res = (await readHandlers.synap_ask!({
    toolName: "synap_ask",
    args: { query: "how do we prevent duplicate captures", detail },
    userId: "user-1",
    apiKeyScopes: ["mcp.read"],
    caller: {} as never,
    lensCaller: {} as never,
    workspaceAccessible: false,
  } as never)) as { content: Array<{ text: string }> };
  return JSON.parse(res.content[0]!.text);
}

beforeEach(() => {
  h.synthesisError = false;
});

describe("synap_ask brief envelope, read through the MCP door", () => {
  it("caps sources and truncated.omittedSources at 5, keeping the counts", async () => {
    const reply = await askMcp("brief");
    expect(reply.sources).toHaveLength(5);
    expect(reply.sourcesOmitted).toBe(3);
    expect(reply.truncated.omittedSources).toHaveLength(5);
    expect(reply.truncated.omitted).toBe(8);
    expect(reply.truncated.total).toBe(16);
  });

  it("caps the same way when synthesis is down", async () => {
    h.synthesisError = true;
    const reply = await askMcp("brief");
    expect(reply.message).toMatch(/AI synthesis did not run/);
    expect(reply.sources).toHaveLength(5);
    expect(reply.truncated.omittedSources).toHaveLength(5);
  });

  it("leaves a full answer untouched", async () => {
    const reply = await askMcp("full");
    expect(reply.sources).toHaveLength(8);
    expect(reply.truncated.omittedSources).toHaveLength(8);
  });
});
