import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * EVERY ATTRIBUTED WRITE CARRIES ITS ATTRIBUTION AS DATA.
 *
 * Live, 2026-09-14: a `synap_capture` sent with no `sessionId` while 10+
 * sessions were open was filed under the newest one — and the only disclosure
 * was a trailing "Note: …" text. A dropped explicit `sessionId` (not owned) was
 * disclosed nowhere at all.
 *
 * Driven through the real `executeMCPToolViaHubProtocol` → real
 * `resolveSessionHandle` (ownership check + open-session read), with the
 * database mocked at `@synap/database` and the tool handler stubbed to a plain
 * `ok()`-shaped payload. The hub caller factory is stubbed (it only builds a
 * tRPC caller the stub handler never uses).
 */

const h = vi.hoisted(() => ({
  owned: false,
  ownershipThrows: false,
  openRows: [] as Array<{ id: string }>,
  openThrows: false,
  payloadText: JSON.stringify({ status: "applied" }),
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    getDb: vi.fn(async () => ({})),
    db: {
      select: vi.fn((columns: Record<string, unknown>) => {
        // `listOpenFocusSessions` projects `goal`; the ownership check does not.
        const isOpenList = "goal" in columns;
        const chain: Record<string, unknown> = {};
        chain.from = () => chain;
        chain.where = () => chain;
        chain.orderBy = () => chain;
        chain.limit = async () => {
          if (isOpenList) {
            if (h.openThrows) throw new Error("db down");
            return h.openRows.map((r) => ({
              ...r,
              goal: null,
              startedAt: null,
            }));
          }
          if (h.ownershipThrows) throw new Error("db down");
          return h.owned ? [{ id: "S-EXPLICIT" }] : [];
        };
        return chain;
      }),
    },
  };
});

vi.mock("../handlers/shared.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../handlers/shared.js")>();
  return { ...actual, createHubProtocolCaller: vi.fn(async () => ({})) };
});

vi.mock("../handlers/capture.js", () => ({
  captureHandlers: {
    synap_capture: async () => ({
      content: [{ type: "text", text: h.payloadText }],
    }),
  },
}));

const { executeMCPToolViaHubProtocol } = await import("../adapter.js");
const { resolveSessionHandle } = await import("../handlers/shared.js");

async function run(args: Record<string, unknown>) {
  const result = await executeMCPToolViaHubProtocol(
    "synap_capture",
    { text: "x", ...args },
    "user-1",
    ["mcp.write"]
  );
  const blocks = result.content as Array<{ type: string; text: string }>;
  return { blocks, payload: JSON.parse(blocks[0].text) };
}

beforeEach(() => {
  h.owned = false;
  h.ownershipThrows = false;
  h.openRows = [];
  h.openThrows = false;
  h.payloadText = JSON.stringify({ status: "applied" });
});

describe("structured session attribution on every attributed write", () => {
  it("(c) no sessionId with several sessions open → derived + ambiguous, and the Note text stays", async () => {
    h.openRows = [{ id: "S-NEWEST" }, { id: "S-OLDER" }];

    const { blocks, payload } = await run({});

    expect(payload.attribution).toEqual({
      session: "derived",
      ambiguous: true,
      openCount: 2,
    });
    expect(payload.status).toBe("applied");
    expect(blocks).toHaveLength(2);
    expect(blocks[1].text).toMatch(/^Note: 2 of your focus sessions are open/);
  });

  it("one open session → derived, not ambiguous, counted", async () => {
    h.openRows = [{ id: "S-ONLY" }];
    const { blocks, payload } = await run({});
    expect(payload.attribution).toEqual({
      session: "derived",
      ambiguous: false,
      openCount: 1,
    });
    expect(blocks).toHaveLength(1);
  });

  it("(d) an explicit OWNED sessionId → explicit (open sessions never counted)", async () => {
    h.owned = true;
    h.openRows = [{ id: "S-NEWEST" }, { id: "S-OLDER" }];
    const { payload } = await run({ sessionId: "S-EXPLICIT" });
    expect(payload.attribution).toEqual({
      session: "explicit",
      ambiguous: false,
      openCount: null,
    });
  });

  it("(e) an explicit sessionId that is NOT the caller's is reported as dropped", async () => {
    h.owned = false;
    const { payload } = await run({ sessionId: "S-SOMEONE-ELSE" });
    expect(payload.attribution).toEqual({
      session: "none",
      ambiguous: false,
      openCount: null,
      ignoredSession: { sessionId: "S-SOMEONE-ELSE", reason: "not-owned" },
    });
  });

  it("a FAILED ownership check is reported as such, not as not-owned", async () => {
    h.ownershipThrows = true;
    const { payload } = await run({ sessionId: "S-EXPLICIT" });
    expect(payload.attribution.ignoredSession).toEqual({
      sessionId: "S-EXPLICIT",
      reason: "ownership-check-failed",
    });
  });

  it("a FAILED open-session read is an uncounted null, never 0", async () => {
    h.openThrows = true;
    const failed = await run({});
    expect(failed.payload.attribution).toEqual({
      session: "none",
      ambiguous: false,
      openCount: null,
    });

    h.openThrows = false;
    h.openRows = [];
    const empty = await run({});
    expect(empty.payload.attribution).toEqual({
      session: "none",
      ambiguous: false,
      openCount: 0,
    });
  });

  it("a payload that is not a JSON object is returned unchanged", async () => {
    h.payloadText = "plain text failure";
    const result = await executeMCPToolViaHubProtocol(
      "synap_capture",
      { text: "x" },
      "user-1",
      ["mcp.write"]
    );
    expect(result.content).toEqual([
      { type: "text", text: "plain text failure" },
    ]);
  });

  it("reads are never attributed", async () => {
    expect(
      await resolveSessionHandle("synap_get_entity", {}, "user-1")
    ).toBeUndefined();
  });
});
