/**
 * `synap_ask` `since` / `until` (ticket a9888512), through the REAL handler:
 * the door reads the window, hands it to `ask()` (which filters the entity
 * lanes before ranking: `services/knowledge/__tests__/ask-window.test.ts`) and
 * ECHOES it, so "nothing in the window" reads differently from "the ranker
 * missed it". A malformed or inverted window is refused, never read as "no
 * window".
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const askMock = vi.fn();

vi.mock("../../../services/knowledge/ask.js", () => ({
  ask: (...args: unknown[]) => askMock(...args),
}));
vi.mock("../../../services/knowledge/resolve-lens.js", () => ({
  resolveKnowledgeLens: async () => ({ workspaceId: null, catalog: [] }),
}));
vi.mock(
  "../../../services/knowledge/synthesize.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../../services/knowledge/synthesize.js")
    >()),
    synthesizeAnswer: async () => ({ answer: "ok", sources: [], routedTo: [] }),
  })
);

const { readHandlers } = await import("./read.js");

async function askMcp(
  args: Record<string, unknown>
): Promise<Record<string, any>> {
  const res = (await readHandlers.synap_ask!({
    toolName: "synap_ask",
    args: { query: "what did my routines find", detail: "full", ...args },
    userId: "user-1",
    apiKeyScopes: ["mcp.read"],
    caller: {} as never,
  } as never)) as { content: Array<{ text: string }>; isError?: boolean };
  const text = res.content[0]!.text;
  // A refusal is plain text (`toolError`); an answer is JSON.
  return res.isError ? { isError: true, text } : JSON.parse(text);
}

beforeEach(() => {
  askMock.mockReset().mockResolvedValue({
    query: "q",
    routedTo: ["semantic"],
    intent: "semantic",
    primary: "semantic",
    answers: [],
    degraded: [],
    understanding: {},
    verdict: "empty",
    lens: { filter: { workspaceId: null, projectId: null } },
  });
});

describe("synap_ask — since / until", () => {
  it("hands the window to ask() and echoes it on the reply", async () => {
    const out = await askMcp({ since: "2026-11-16", until: "2026-11-23" });
    expect(askMock).toHaveBeenCalledTimes(1);
    expect(askMock.mock.calls[0]![0].window).toEqual({
      since: new Date("2026-11-16T00:00:00.000Z"),
      until: new Date("2026-11-23T00:00:00.000Z"),
    });
    expect(out.window).toEqual({
      since: "2026-11-16T00:00:00.000Z",
      until: "2026-11-23T00:00:00.000Z",
      field: "updatedAt",
      appliesTo: ["semantic", "structured"],
    });
  });

  it("without a window, ask() gets none and the reply carries none", async () => {
    const out = await askMcp({});
    expect(askMock.mock.calls[0]![0]).not.toHaveProperty("window");
    expect(out).not.toHaveProperty("window");
  });

  it("refuses a phrase or an inverted window before any read", async () => {
    const phrase = await askMcp({ since: "this week" });
    expect(phrase.isError).toBe(true);
    expect(phrase.text).toMatch(/since must be an ISO-8601/);
    const inverted = await askMcp({
      since: "2026-11-23",
      until: "2026-11-16",
    });
    expect(inverted.isError).toBe(true);
    expect(inverted.text).toMatch(/must be before until/);
    expect(askMock).not.toHaveBeenCalled();
  });
});
