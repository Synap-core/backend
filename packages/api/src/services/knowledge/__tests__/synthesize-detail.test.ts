/**
 * GUARD — `synap_ask` `detail` (decision B9a) changes what is ASKED of the IS
 * and the receipt says which answer came back.
 *
 * The defect (task d1257f1f): a plain agent lookup cost a 500–1,500-word
 * answer, with no way to ask for less. `detail` is only real if:
 *  - `brief` reaches the IS request body (the IS picks its short prompt from it);
 *  - `sources` makes NO IS call at all (no model spend) and is not dressed as a
 *    failure (`answer: null` with no `error`);
 *  - `full` / omitted sends the body every IS version already accepts;
 *  - the reported `detail` is what HAPPENED: an IS that predates `brief`
 *    ignores it and answers in full, and the receipt must then say `full`;
 *  - an unknown value is refused, never silently read as `full`.
 * Driven through the real MCP handler and the real `synthesizeAnswer`; only
 * retrieval (`ask`), the lens and the network are stubbed.
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
vi.mock("../resolve-lens.js", () => ({
  resolveKnowledgeLens: async () => ({ workspaceId: null, catalog: [] }),
}));

import type { AskAnswer } from "../ask.js";
import { readHandlers } from "../../../routers/mcp/handlers/read.js";
import type { McpToolContext } from "../../../routers/mcp/handlers/shared.js";

const ANSWERS = [
  {
    substrate: "structured",
    status: "ok",
    items: [
      {
        id: "ent-1",
        title: "Hosting partner",
        content: "Hetzner hosts the pod.",
      },
      { id: "ent-2", title: "Old hosting note", content: "We used OVH once." },
    ],
  },
] as unknown as AskAnswer[];

function ctx(args: Record<string, unknown>): McpToolContext {
  return {
    toolName: "synap_ask",
    args: { query: "who hosts the pod?", ...args },
    userId: "user-1",
    apiKeyScopes: ["mcp.read"],
    workspaceId: null,
    caller: {},
    lensCaller: {},
    workspaceAccessible: false,
  } as unknown as McpToolContext;
}

async function callAsk(args: Record<string, unknown>) {
  const result = await readHandlers.synap_ask!(ctx(args));
  const text = (result.content as { type: string; text: string }[])
    .map((c) => c.text)
    .join("");
  return { result, text };
}

function isReplies(body: Record<string, unknown>) {
  const fetchMock = vi
    .fn()
    .mockResolvedValue({ ok: true, json: async () => body });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function sentBody(
  fetchMock: ReturnType<typeof vi.fn>
): Record<string, unknown> {
  const init = fetchMock.mock.calls[0]?.[1] as { body: string };
  return JSON.parse(init.body) as Record<string, unknown>;
}

describe("synap_ask detail (MCP door → synthesizeAnswer → IS request)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    askMock.mockResolvedValue({
      answers: ANSWERS,
      routedTo: ["structured"],
      degraded: [],
      pending: null,
      understanding: {},
    });
    getDefaultActiveService.mockResolvedValue({
      endpoint: "http://is.test",
      apiKey: "k",
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("brief: asks the IS for brief and reports the brief answer it got", async () => {
    const fetchMock = isReplies({ answer: "Hetzner.", detail: "brief" });

    const { text } = await callAsk({ detail: "brief" });

    expect(sentBody(fetchMock).detail).toBe("brief");
    const payload = JSON.parse(text) as { answer: string; detail: string };
    expect(payload).toMatchObject({ answer: "Hetzner.", detail: "brief" });
  });

  it("brief against an IS that ignores it: the receipt says full, not brief", async () => {
    isReplies({ answer: "A long provenance-rich answer…" });

    const { text } = await callAsk({ detail: "brief" });

    expect((JSON.parse(text) as { detail: string }).detail).toBe("full");
  });

  it("brief answered with nothing: redone as full, never the pending notice alone", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ answer: "", detail: "brief" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ answer: "Hetzner hosts the pod." }),
      });
    vi.stubGlobal("fetch", fetchMock);
    askMock.mockResolvedValue({
      answers: ANSWERS,
      routedTo: ["structured"],
      degraded: [],
      pending: { matches: [{ id: "p1" }] },
      understanding: {},
    });

    const { text } = await callAsk({ detail: "brief" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      "detail" in
        (JSON.parse(
          (fetchMock.mock.calls[1]![1] as { body: string }).body
        ) as object)
    ).toBe(false);
    const payload = JSON.parse(text) as { answer: string; detail: string };
    expect(payload.detail).toBe("full");
    expect(payload.answer).toMatch(/Hetzner hosts the pod\./);
  });

  it("a queue answer leads the prose and rides the envelope", async () => {
    isReplies({ answer: "Nothing in the notes about it." });
    askMock.mockResolvedValue({
      answers: ANSWERS,
      routedTo: ["structured"],
      degraded: [],
      pending: null,
      understanding: {},
      queue: {
        pendingReview: { count: 3, oldestDays: 2, lens: "authored" },
        owedByPerson: { count: 0, sessions: 0 },
        openSessions: { count: 0 },
      },
    });

    const { text } = await callAsk({ query: "what is waiting on me" });

    const payload = JSON.parse(text) as { answer: string; queue: unknown };
    expect(payload.answer).toMatch(/^Waiting on you: 3 proposals to review/);
    expect(payload.queue).toMatchObject({ pendingReview: { count: 3 } });
  });

  it("an empty FULL answer is a classified failure, not a success", async () => {
    isReplies({ answer: "  " });

    const { text } = await callAsk({});

    const payload = JSON.parse(text) as {
      answer: unknown;
      error?: string;
      failureClass?: string;
    };
    expect(payload.answer).toBeNull();
    expect(payload.error).toBe("synthesis_unavailable");
    expect(payload.failureClass).toBe("invalid_response");
  });

  it("brief caps the envelope: 5 sources, 200-char pending summaries, no spaces; full keeps all", async () => {
    const items = Array.from({ length: 12 }, (_, i) => ({
      id: `ent-${i}`,
      title: `Note ${i}`,
      content: "short",
    }));
    askMock.mockResolvedValue({
      answers: [{ substrate: "structured", status: "ok", items }],
      routedTo: ["structured"],
      degraded: [],
      pending: {
        notice: "pending",
        matches: Array.from({ length: 5 }, (_, i) => ({
          proposalId: `p${i}`,
          proposalType: "create",
          summary: "x".repeat(3000),
          reviewUrl: `https://pod.test/open/p${i}`,
          score: 1,
        })),
      },
      spaces: { hint: "y".repeat(5000) },
      understanding: {},
    });
    isReplies({ answer: "Hetzner.", detail: "brief" });
    const brief = await callAsk({ detail: "brief" });
    isReplies({ answer: "A long answer." });
    const full = await callAsk({});

    const b = JSON.parse(brief.text) as {
      sources: unknown[];
      sourcesOmitted?: number;
      pending: { matches: { summary: string }[] };
      spaces?: unknown;
    };
    expect(b.sources).toHaveLength(5);
    expect(b.sourcesOmitted).toBe(7);
    expect(b.pending.matches).toHaveLength(5);
    expect(b.pending.matches.every((m) => m.summary.length <= 201)).toBe(true);
    expect(b.spaces).toBeUndefined();

    const f = JSON.parse(full.text) as typeof b;
    expect(f.sources).toHaveLength(12);
    expect(f.pending.matches[0]!.summary).toHaveLength(3000);
    expect(f.spaces).toBeDefined();
    console.info(
      `[size] ask envelope: full=${full.text.length} brief=${brief.text.length}`
    );
    expect(brief.text.length).toBeLessThan(full.text.length / 5);
  });

  it("sources: no IS call, the matches, and no failure costume", async () => {
    const fetchMock = isReplies({ answer: "should never be asked" });

    const { result, text } = await callAsk({ detail: "sources" });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(getDefaultActiveService).not.toHaveBeenCalled();
    expect(result.isError).not.toBe(true);
    const payload = JSON.parse(text) as {
      answer: unknown;
      detail: string;
      error?: string;
      sources: { id: string }[];
    };
    expect(payload.answer).toBeNull();
    expect(payload.detail).toBe("sources");
    expect(payload.error).toBeUndefined();
    expect(payload.sources.map((s) => s.id)).toEqual(["ent-1", "ent-2"]);
  });

  it("default: the IS body carries no detail (byte-compatible) and says full", async () => {
    const fetchMock = isReplies({
      answer: "Hetzner hosts the pod, per a note…",
    });

    const { text } = await callAsk({});

    expect("detail" in sentBody(fetchMock)).toBe(false);
    expect((JSON.parse(text) as { detail: string }).detail).toBe("full");
  });

  it("an unknown detail is refused before retrieval, never read as full", async () => {
    const fetchMock = isReplies({ answer: "x" });

    const { result, text } = await callAsk({ detail: "tiny" });

    expect(result.isError).toBe(true);
    expect(text).toMatch(/detail must be one of sources, brief, full/);
    expect(askMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
