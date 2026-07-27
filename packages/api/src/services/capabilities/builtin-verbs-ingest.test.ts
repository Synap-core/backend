import { describe, it, expect, vi, beforeEach } from "vitest";

// channel.ingest delegates to the SHARED recordInboundMessage sink (never
// reimplements channel resolve/dedup/side-effects). We mock that lazy-imported
// service and assert the BATCH normalization logic: messageMap field-paths →
// recorder args, the per-message idempotencySeed (`${externalId}:${mappedId}`),
// the pagination-safe CONTENT fallback when a row is missing the mapped id, the
// outbound-provenance override, suppressSideEffects threading, and the XOR
// mode refine.
const h = vi.hoisted(() => ({
  record: vi.fn(),
}));

// Lazy-imported by channelIngestHandler (path is relative to builtin-verbs.ts,
// which lives in this same directory as the test).
vi.mock("../connectors/inbound-recorder.js", () => ({
  recordInboundMessage: h.record,
}));

// Keep sibling module-load deps happy (mirrors builtin-verbs-connector-health.test.ts).
// Provides the REAL MessageRole / MessageAuthorType enum values so we can assert
// the outbound override maps to the exact enum members the handler emits.
vi.mock("@synap/database", () => {
  const mk = (name: string) =>
    new Proxy(
      { __table: name },
      { get: (t, p) => (p in t ? (t as never)[p] : `${name}.${String(p)}`) }
    );
  return {
    db: { query: {} },
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
    documents: mk("documents"),
    capabilities: mk("capabilities"),
    tools: mk("tools"),
    getWorkspaceMembership: vi.fn(),
    insertChannelMessage: vi.fn(),
    getEffectiveFacets: vi.fn(),
    profileSlugScopeConditionFromRows: vi.fn(),
    // Real enum values (match packages/database/src/schema/messages.ts).
    MessageRole: { USER: "user", ASSISTANT: "assistant", SYSTEM: "system" },
    MessageAuthorType: {
      HUMAN: "human",
      AI_AGENT: "ai_agent",
      EXTERNAL: "external",
      BOT: "bot",
    },
  };
});
vi.mock("./place-artboard-deck.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./place-artboard-deck.js")>();
  return { ...actual, placeArtboardDeck: vi.fn() };
});
vi.mock("../mail-feed/triage.js", () => ({ triageEmails: vi.fn() }));
vi.mock("../mail-feed/generate.js", () => ({ generateViaIS: vi.fn() }));

import { BUILTIN_VERBS } from "./builtin-verbs.js";

const CTX = { userId: "u1", workspaceId: null }; // no workspace lens → membership skipped

// No workspace pin, so recordInboundMessage lands the batch pod-level.
const run = (params: Record<string, unknown>, ctx = CTX) =>
  BUILTIN_VERBS["channel.ingest"](params, ctx);

beforeEach(() => {
  vi.clearAllMocks();
  // The batch loop reads channelId/contextObjectId/recorded off each result.
  h.record.mockResolvedValue({
    channelId: "chan-1",
    contextObjectId: null,
    inboundHash: "hash",
    recorded: true,
  });
});

const MAP = {
  text: "body",
  id: "id",
  sentAt: "sent_at",
  participant: "sender.name",
  isOutbound: "is_sender",
};

describe("channel.ingest — batch normalization", () => {
  it("(a) maps text/id/sentAt via messageMap and derives seed `${externalId}:${mappedId}`", async () => {
    await run({
      provider: "linkedin",
      externalId: "thread-1",
      messageMap: MAP,
      messages: [
        {
          id: "m1",
          body: "hey there",
          sent_at: "2026-01-01T00:00:00Z",
          sender: { name: "Ada" },
          is_sender: false,
        },
      ],
    });

    expect(h.record).toHaveBeenCalledTimes(1);
    const arg = h.record.mock.calls[0][0];
    expect(arg).toMatchObject({
      provider: "linkedin",
      externalId: "thread-1",
      userId: "u1",
      text: "hey there",
      sentAt: "2026-01-01T00:00:00Z",
      participant: "Ada",
      // seed = `${externalId}:${map.id}` — the native id, thread-namespaced.
      idempotencySeed: "thread-1:m1",
    });
    // Inbound row → recorder gets NO provenance override (defaults EXTERNAL/USER).
    expect(arg.authorType).toBeUndefined();
    expect(arg.role).toBeUndefined();
  });

  it("(b) a row missing the mapped id falls back to a CONTENT key, NOT the array index", async () => {
    await run({
      provider: "linkedin",
      externalId: "thread-1",
      messageMap: MAP,
      messages: [
        // First row HAS an id — so if the fallback used the index, row two's
        // seed would be `thread-1:1`. It must instead be content-derived.
        { id: "m1", body: "first", sent_at: "2026-01-01T00:00:00Z" },
        { body: "no id here", sent_at: "2026-01-02T00:00:00Z" }, // id missing
      ],
    });

    expect(h.record).toHaveBeenCalledTimes(2);
    const secondSeed = h.record.mock.calls[1][0].idempotencySeed;
    // Content key: `c:${sentAt}:${text.slice(0,180)}`, thread-namespaced.
    expect(secondSeed).toBe("thread-1:c:2026-01-02T00:00:00Z:no id here");
    // Explicitly NOT the positional index — that is the pagination-shift bug.
    expect(secondSeed).not.toBe("thread-1:1");
  });

  it("(c) isOutbound=true rows pass authorType=HUMAN / role=ASSISTANT; inbound rows do not", async () => {
    await run({
      provider: "linkedin",
      externalId: "thread-1",
      messageMap: MAP,
      messages: [
        { id: "in", body: "their message", is_sender: false },
        { id: "out", body: "my reply", is_sender: true },
      ],
    });

    const inbound = h.record.mock.calls[0][0];
    const outbound = h.record.mock.calls[1][0];
    expect(inbound.authorType).toBeUndefined();
    expect(inbound.role).toBeUndefined();
    expect(outbound.authorType).toBe("human");
    expect(outbound.role).toBe("assistant");
  });

  it("(d) suppressSideEffects is threaded through to every recorder call", async () => {
    await run({
      provider: "linkedin",
      externalId: "thread-1",
      suppressSideEffects: true,
      messageMap: MAP,
      messages: [
        { id: "m1", body: "one" },
        { id: "m2", body: "two" },
      ],
    });

    expect(h.record).toHaveBeenCalledTimes(2);
    for (const call of h.record.mock.calls) {
      expect(call[0].suppressSideEffects).toBe(true);
    }
  });

  it("(d') suppressSideEffects omitted → recorder gets no override (default behavior)", async () => {
    await run({
      provider: "linkedin",
      externalId: "thread-1",
      messageMap: MAP,
      messages: [{ id: "m1", body: "one" }],
    });
    expect(h.record.mock.calls[0][0].suppressSideEffects).toBeUndefined();
  });

  it("skips empty/non-text rows without fabricating a message", async () => {
    const out = (await run({
      provider: "linkedin",
      externalId: "thread-1",
      messageMap: MAP,
      messages: [
        { id: "m1", body: "real" },
        { id: "sys", body: "" }, // empty body — a system event
        { id: "nope" }, // no body path at all
      ],
    })) as { recorded: number; skipped: number; total: number };

    expect(h.record).toHaveBeenCalledTimes(1);
    expect(out.recorded).toBe(1);
    expect(out.skipped).toBe(2);
    expect(out.total).toBe(3);
  });
});

describe("channel.ingest — mode XOR refine", () => {
  it("(e) rejects BOTH modes supplied at once", async () => {
    await expect(
      run({
        provider: "linkedin",
        externalId: "thread-1",
        // batch
        messageMap: MAP,
        messages: [{ id: "m1", body: "x" }],
        // + single
        text: "x",
        idempotencySeed: "seed",
      })
    ).rejects.toThrow();
    expect(h.record).not.toHaveBeenCalled();
  });

  it("(e) rejects NEITHER mode supplied", async () => {
    await expect(
      run({ provider: "linkedin", externalId: "thread-1" })
    ).rejects.toThrow();
    expect(h.record).not.toHaveBeenCalled();
  });
});
