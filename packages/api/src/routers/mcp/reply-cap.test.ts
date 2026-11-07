/**
 * THE reply cap (`reply-cap.ts`): an oversized reply is cut with a notice that
 * says what is missing and how to narrow, a reply within budget is untouched
 * byte for byte, and the cap sits on the call path every tool takes.
 *
 * Negative control: with `capReply` removed from `adapter.ts`, the
 * reachability case and the "oversized" cases go red.
 */
import { describe, it, expect, vi } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap/database")>()),
  getDb: vi.fn(async () => ({}) as never),
}));
// The handler map the real adapter dispatches to: one read tool answers with a
// reply far over the budget, the rest stay real.
vi.mock("./handlers/read.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./handlers/read.js")>();
  const big = (n: number) =>
    ({
      content: [
        {
          type: "text",
          text: JSON.stringify({ rows: "x".repeat(n), tail: "THE-END" }),
        },
      ],
    }) as CallToolResult;
  return {
    ...actual,
    readHandlers: {
      ...actual.readHandlers,
      synap_get_session: async () => big(60_000),
      synap_get_entities: async () => big(100),
    },
  };
});

import {
  capReply,
  REPLY_CAP_CHARS,
  REPLY_CAP_EXEMPT,
} from "./reply-cap.js";
import { executeMCPToolViaHubProtocol } from "./adapter.js";

const text = (r: CallToolResult) => {
  const b = r.content?.[0];
  if (!b || b.type !== "text") throw new Error("expected text");
  return b.text;
};
const reply = (t: string): CallToolResult => ({
  content: [{ type: "text", text: t }],
});

describe("capReply", () => {
  it("cuts an oversized reply to valid JSON that fits, with a notice and a way out", () => {
    const original = JSON.stringify({ a: 'q"uote\n'.repeat(10_000) });
    const out = capReply("synap_get_session", reply(original));
    const body = text(out);
    expect(body.length).toBeLessThanOrEqual(REPLY_CAP_CHARS);
    const parsed = JSON.parse(body);
    expect(parsed.truncated.totalChars).toBe(original.length);
    expect(parsed.truncated.shownChars + parsed.truncated.omittedChars).toBe(
      original.length
    );
    expect(parsed.truncated.omittedChars).toBeGreaterThan(0);
    expect(original.startsWith(parsed.head)).toBe(true);
    expect(parsed.truncated.how).toMatch(/detail:'lean'/);
  });

  it("names a tool's own narrowing parameter, else a generic hint", () => {
    const big = reply("y".repeat(REPLY_CAP_CHARS + 1));
    expect(JSON.parse(text(capReply("synap_get_document", big))).truncated.how)
      .toMatch(/`limit`.*`offset`/);
    expect(JSON.parse(text(capReply("synap_unknown", big))).truncated.how)
      .toMatch(/Narrow the call/);
  });

  it("returns a reply within budget as the SAME object, byte for byte", () => {
    const exact = reply("z".repeat(REPLY_CAP_CHARS));
    expect(capReply("synap_get_session", exact)).toBe(exact);
    const small = reply(JSON.stringify({ ok: true }));
    expect(capReply("synap_get_session", small)).toBe(small);
  });

  it("never caps an error", () => {
    const err: CallToolResult = {
      isError: true,
      content: [{ type: "text", text: "e".repeat(REPLY_CAP_CHARS * 2) }],
    };
    expect(capReply("synap_get_session", err)).toBe(err);
  });

  it("opts out ONLY the documented body-returning tools", () => {
    expect([...REPLY_CAP_EXEMPT]).toEqual(["synap_load_skill"]);
    const big = reply("s".repeat(REPLY_CAP_CHARS * 2));
    expect(capReply("synap_load_skill", big)).toBe(big);
  });
});

describe("the cap is on the call path every tool takes", () => {
  it("an oversized real-door reply is truncated with the notice", async () => {
    const out = await executeMCPToolViaHubProtocol(
      "synap_get_session",
      {},
      "user-1",
      ["mcp.read"]
    );
    const parsed = JSON.parse(text(out));
    expect(text(out).length).toBeLessThanOrEqual(REPLY_CAP_CHARS);
    expect(parsed.truncated.omittedChars).toBeGreaterThan(40_000);
    expect(parsed.head).not.toContain("THE-END");
  });

  it("an in-budget real-door reply is unchanged", async () => {
    const out = await executeMCPToolViaHubProtocol(
      "synap_get_entities",
      {},
      "user-1",
      ["mcp.read"]
    );
    expect(text(out)).toBe(
      JSON.stringify({ rows: "x".repeat(100), tail: "THE-END" })
    );
  });
});
