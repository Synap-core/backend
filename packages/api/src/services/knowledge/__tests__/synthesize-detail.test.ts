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
