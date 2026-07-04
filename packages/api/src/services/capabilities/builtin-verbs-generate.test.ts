import { describe, it, expect, vi, beforeEach } from "vitest";

// ai.generate is the synchronous single-shot LLM verb: its handler delegates to
// `generateViaIS` (POST → IS /v1/tools/generate) and returns the IS `output`
// VALUE DIRECTLY (no envelope), so an automation step's steps.<id>.output IS that
// value. We mock generateViaIS to assert (a) the handler returns output directly,
// (b) the engine's stringified inputMapping (json:"true", maxTokens:"1200") is
// coerced correctly, and (c) the verb is registered read-only (auto-runs).
const h = vi.hoisted(() => ({ generateViaIS: vi.fn() }));

vi.mock("../mail-feed/generate.js", () => ({ generateViaIS: h.generateViaIS }));

// Keep sibling module-load deps happy (mirrors builtin-verbs-read.test.ts).
vi.mock("@synap/database", () => {
  const mk = (name: string) =>
    new Proxy(
      { __table: name },
      { get: (t, p) => (p in t ? (t as never)[p] : `${name}.${String(p)}`) }
    );
  return {
    db: {},
    eq: (col: unknown, val: unknown) => ({ op: "eq", col, val }),
    and: (...xs: unknown[]) => ({ op: "and", xs }),
    or: (...xs: unknown[]) => ({ op: "or", xs }),
    isNull: (col: unknown) => ({ op: "isNull", col }),
    desc: (col: unknown) => ({ op: "desc", col }),
    drizzleSql: (strings: TemplateStringsArray, ...vals: unknown[]) => ({
      op: "sql",
      strings,
      vals,
    }),
    channels: mk("channels"),
    views: mk("views"),
    entities: mk("entities"),
    relations: mk("relations"),
    messages: mk("messages"),
    getWorkspaceMembership: vi.fn(),
    insertChannelMessage: vi.fn(),
  };
});
vi.mock("./place-artboard-deck.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./place-artboard-deck.js")>();
  return { ...actual, placeArtboardDeck: vi.fn() };
});
vi.mock("../mail-feed/triage.js", () => ({ triageEmails: vi.fn() }));

import { BUILTIN_VERBS, READ_ONLY_BUILTIN_VERBS } from "./builtin-verbs.js";

describe("ai.generate — registry", () => {
  it("is registered and marked read-only (pure compute → auto-run)", () => {
    expect(typeof BUILTIN_VERBS["ai.generate"]).toBe("function");
    expect(READ_ONLY_BUILTIN_VERBS.has("ai.generate")).toBe(true);
  });
});

describe("ai.generate — handler", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the IS output VALUE directly (json object) — no envelope", async () => {
    h.generateViaIS.mockResolvedValueOnce({
      reviewNeeded: true,
      milestone: "abstract",
      reason: "client finished the abstract",
    });

    const out = (await BUILTIN_VERBS["ai.generate"](
      { prompt: "classify this", json: "true" },
      { userId: "u1", workspaceId: "ws1" }
    )) as { reviewNeeded: boolean };

    // Output is the parsed object directly — steps.detect.output.reviewNeeded resolves.
    expect(out.reviewNeeded).toBe(true);
  });

  it("coerces the engine's stringified json:'true' + numeric maxTokens", async () => {
    h.generateViaIS.mockResolvedValueOnce({ ok: 1 });

    await BUILTIN_VERBS["ai.generate"](
      { prompt: "p", json: "true", maxTokens: "1200", system: "sys" },
      { userId: "u1", workspaceId: "ws1" }
    );

    expect(h.generateViaIS).toHaveBeenCalledWith({
      system: "sys",
      prompt: "p",
      json: true,
      maxTokens: 1200,
    });
  });

  it("coerces json:'false' to false (NOT truthy) and defaults json when absent", async () => {
    h.generateViaIS.mockResolvedValue("plain text");

    await BUILTIN_VERBS["ai.generate"](
      { prompt: "p", json: "false" },
      { userId: "u1", workspaceId: null }
    );
    expect(h.generateViaIS).toHaveBeenLastCalledWith(
      expect.objectContaining({ json: false })
    );

    await BUILTIN_VERBS["ai.generate"](
      { prompt: "p" },
      { userId: "u1", workspaceId: null }
    );
    expect(h.generateViaIS).toHaveBeenLastCalledWith(
      expect.objectContaining({ json: false })
    );
  });

  it("returns raw text when the IS output is a string", async () => {
    h.generateViaIS.mockResolvedValueOnce("a summary line");
    const out = await BUILTIN_VERBS["ai.generate"](
      { prompt: "summarize" },
      { userId: "u1", workspaceId: "ws1" }
    );
    expect(out).toBe("a summary line");
  });
});
