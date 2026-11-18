/**
 * THE reply cap (`reply-cap.ts`): an oversized JSON reply is FITTED (whole rows
 * dropped from its lists, long strings clipped, a `fit` notice naming each); a
 * paged list reads on from the first row left out (`nextOffset`); a reply that
 * is not a JSON object is cut to a `head` with a notice; a reply within budget
 * is untouched byte for byte; and the cap sits on the call path every tool
 * takes.
 *
 * Negative controls: with `capReply` removed from `adapter.ts`, the
 * reachability cases go red; with the old head-only cut (`fitted` returning
 * null), every "fits" and "reads on" case goes red (finding 18becda0).
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
  // A paged list door: `rows` rows of ~400 chars from `offset`, the
  // handler's own `nextOffset` at the end of ITS page (which, after a cut,
  // would skip the rows the cap dropped).
  const paged = (rows: number, offset: number) =>
    ({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            items: Array.from({ length: rows }, (_, i) => ({
              id: `row-${offset + i}`,
              body: "b".repeat(400),
            })),
            count: rows,
            offset,
            nextOffset: offset + rows,
          }),
        },
      ],
    }) as CallToolResult;
  return {
    ...actual,
    readHandlers: {
      ...actual.readHandlers,
      synap_get_entities: async (ctx: {
        args: { size?: number; rows?: number; offset?: number };
      }) =>
        ctx.args.rows
          ? paged(ctx.args.rows, ctx.args.offset ?? 0)
          : big(ctx.args.size ?? 100),
    },
  };
});

import { capReply, REPLY_CAP_CHARS, REPLY_CAP_EXEMPT } from "./reply-cap.js";
import { executeMCPToolViaHubProtocol } from "./adapter.js";

const text = (r: CallToolResult) => {
  const b = r.content?.[0];
  if (!b || b.type !== "text") throw new Error("expected text");
  return b.text;
};
const reply = (t: string): CallToolResult => ({
  content: [{ type: "text", text: t }],
});

const rowsReply = (n: number, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    items: Array.from({ length: n }, (_, i) => ({
      id: `r${i}`,
      body: "b".repeat(400),
    })),
    ...extra,
  });

describe("capReply", () => {
  it("fits an oversized JSON reply: valid JSON, the other keys whole, a notice and a way out", () => {
    const original = JSON.stringify({
      a: 'q"uote\n'.repeat(10_000),
      keep: "THE-END",
    });
    const out = capReply("synap_get_session", reply(original));
    const body = text(out);
    expect(body.length).toBeLessThanOrEqual(REPLY_CAP_CHARS);
    const parsed = JSON.parse(body);
    expect(parsed).not.toHaveProperty("head");
    expect(parsed.keep).toBe("THE-END");
    expect(parsed.fit.clipped).toEqual(["a"]);
    expect(JSON.parse(original).a.startsWith(parsed.a.slice(0, -1))).toBe(true);
    expect(parsed.fit.how).toMatch(/detail:'lean'/);
  });

  it("drops WHOLE rows from a list, never cuts one, and says how many", () => {
    const out = JSON.parse(text(capReply("synap_x", reply(rowsReply(100)))));
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(REPLY_CAP_CHARS);
    const shown = out.items.length;
    expect(shown).toBeGreaterThan(20);
    expect(shown + out.fit.omitted.items).toBe(100);
    out.items.forEach((r: { id: string; body: string }, i: number) => {
      expect(r.id).toBe(`r${i}`);
      expect(r.body).toHaveLength(400);
    });
    // Not a paged reply: no continuation is invented.
    expect(out).not.toHaveProperty("nextOffset");
  });

  it("a paged reply reads on from the FIRST row left out, not the handler's next page", () => {
    const out = JSON.parse(
      text(
        capReply(
          "synap_list_sessions",
          reply(rowsReply(100, { count: 100, offset: 200, nextOffset: 300 }))
        )
      )
    );
    const shown = out.items.length;
    expect(shown).toBeLessThan(100);
    expect(out.nextOffset).toBe(200 + shown);
    expect(out.count).toBe(shown);
    expect(out.fit.how).toContain(`offset: ${200 + shown}`);
  });

  it("a last page that is cut gets a continuation it did not have", () => {
    const out = JSON.parse(
      text(capReply("synap_x", reply(rowsReply(100, { offset: 0 }))))
    );
    expect(out.nextOffset).toBe(out.items.length);
  });

  it("a pageSlice reply (`paging.offset`) reads on inside `paging`", () => {
    const out = JSON.parse(
      text(
        capReply(
          "synap_list_tracks",
          reply(
            rowsReply(100, {
              paging: { total: 150, offset: 50, nextOffset: 150 },
            })
          )
        )
      )
    );
    expect(out.paging.nextOffset).toBe(50 + out.items.length);
    expect(out.paging.total).toBe(150);
  });

  it("a cut side list is never taken for the page", () => {
    const out = JSON.parse(
      text(
        capReply(
          "synap_x",
          reply(
            JSON.stringify({
              items: [{ id: "only" }],
              warnings: Array.from({ length: 100 }, () => "w".repeat(300)),
              note: "n".repeat(300),
              count: 1,
              offset: 0,
            })
          )
        )
      )
    );
    expect(out.fit.omitted.warnings).toBeGreaterThan(0);
    expect(out.items).toEqual([{ id: "only" }]);
    expect(out).not.toHaveProperty("nextOffset");
  });

  it("a reply that is not a JSON object is cut to a head, with a notice", () => {
    const original = "plain text ".repeat(3_000);
    const parsed = JSON.parse(
      text(capReply("synap_get_session", reply(original)))
    );
    expect(parsed.truncated.totalChars).toBe(original.length);
    expect(original.startsWith(parsed.head)).toBe(true);
  });

  it("names a tool's own narrowing parameter, else a generic hint", () => {
    const big = reply("y".repeat(REPLY_CAP_CHARS + 1));
    expect(
      JSON.parse(text(capReply("synap_get_document", big))).truncated.how
    ).toMatch(/`limit`.*`offset`/);
    expect(
      JSON.parse(text(capReply("synap_unknown", big))).truncated.how
    ).toMatch(/Narrow the call/);
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
  it("an oversized real-door reply is fitted with the notice", async () => {
    const out = await executeMCPToolViaHubProtocol(
      "synap_get_entities",
      { size: 60_000 },
      "user-1",
      ["mcp.read"]
    );
    const parsed = JSON.parse(text(out));
    expect(text(out).length).toBeLessThanOrEqual(REPLY_CAP_CHARS);
    expect(parsed.fit.clipped).toEqual(["rows"]);
    expect(parsed.tail).toBe("THE-END");
  });

  it("walking a real paged door through the cap reads every row once", async () => {
    const seen: string[] = [];
    let offset: number | undefined = 0;
    let calls = 0;
    // The door answers 80 rows per call; the cap lets ~30 through each time.
    while (offset !== undefined && offset < 160 && calls++ < 20) {
      const page = JSON.parse(
        text(
          await executeMCPToolViaHubProtocol(
            "synap_get_entities",
            { rows: Math.min(80, 160 - offset), offset },
            "user-1",
            ["mcp.read"]
          )
        )
      );
      expect(JSON.stringify(page).length).toBeLessThanOrEqual(REPLY_CAP_CHARS);
      seen.push(...page.items.map((r: { id: string }) => r.id));
      offset = page.nextOffset;
    }
    expect(calls).toBeGreaterThan(2);
    expect(seen).toEqual(Array.from({ length: 160 }, (_, i) => `row-${i}`));
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
