/**
 * What the door did to a call's arguments is SAID on the reply (tickets
 * e18a0451, 1ef84d45, 2d61ff7c; `call-notices.ts`).
 *
 * Real: the tool list (the declared set), the `tools/call` dispatch of
 * `createMCPServer`, the undeclared-argument check and the one page clamp
 * (`pageLimit`). Stubbed: `tools.execute` — each test gives it the body a
 * handler would run (a page read, a refusal), since the tools themselves are
 * not under test.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

vi.mock("./tools/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tools/index.js")>();
  return {
    ...actual,
    tools: {
      ...actual.tools,
      execute: vi.fn(),
    },
  };
});
vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  db: {},
}));

import { createMCPServer } from "./index.js";
import { tools } from "./tools/index.js";
import { pageLimit } from "./handlers/shared.js";
import { refuseUndeclaredArgs } from "./undeclared-args.js";
import { withCallNotices } from "./call-notices.js";

type Handler = (req: unknown, extra: unknown) => Promise<unknown>;
const execute = tools.execute as unknown as ReturnType<typeof vi.fn>;

async function call(
  name: string,
  args: Record<string, unknown>
): Promise<CallToolResult> {
  const server = createMCPServer(undefined, "u1") as unknown as {
    _requestHandlers: Map<string, Handler>;
  };
  const handler = server._requestHandlers.get("tools/call");
  if (!handler) throw new Error("SDK no longer exposes _requestHandlers");
  return (await handler(
    { method: "tools/call", params: { name, arguments: args } },
    { signal: new AbortController().signal, sendNotification: vi.fn() }
  )) as CallToolResult;
}

/** Every JSON object the reply carries, merged (payload + any notice block). */
function payload(res: CallToolResult): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const block of res.content as { type: string; text: string }[]) {
    try {
      const parsed = JSON.parse(block.text) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        Object.assign(out, parsed);
    } catch {
      // a plain-text block (an error sentence)
    }
  }
  return out;
}

beforeEach(() => {
  execute
    .mockReset()
    .mockResolvedValue({ content: [{ type: "text", text: '{"items":[]}' }] });
});

describe("ignoredArgs — an argument the tool does not take is said, not dropped", () => {
  it("e18a0451: get_entities with sort/order names them and points at sortBy", async () => {
    const res = await call("synap_get_entities", {
      profileSlug: "person",
      sort: "lastInteractionAt",
      order: "asc",
    });
    const body = payload(res);
    expect(body.items).toEqual([]);
    const ignored = body.ignoredArgs as { keys: string[]; note: string };
    expect(ignored.keys).toEqual(["sort", "order"]);
    expect(ignored.note).toContain("`sort` → did you mean `sortBy`?");
    expect(ignored.note).toMatch(/Its inputs: .*sortDir/);
  });

  it("2d61ff7c: get_entity with `id` is told the input is `entityId`, on a failed call too", async () => {
    execute.mockResolvedValue({
      isError: true,
      content: [{ type: "text", text: "synap_get_entity needs `entityId`." }],
    });
    const res = await call("synap_get_entity", { id: "0667d277" });
    expect(res.isError).toBe(true);
    const ignored = payload(res).ignoredArgs as { note: string };
    expect(ignored.note).toContain("`id` → did you mean `entityId`?");
  });

  it("a call with only declared arguments comes back byte for byte", async () => {
    const reply = { content: [{ type: "text", text: '{"items":[]}' }] };
    execute.mockResolvedValue(reply);
    const res = await call("synap_get_entities", { profileSlug: "person" });
    expect(res.content).toEqual(reply.content);
  });

  it("a tool that REFUSES undeclared arguments is not told twice", async () => {
    execute.mockImplementation(
      async (name: string, args: Record<string, unknown>) =>
        (await refuseUndeclaredArgs(name, args)) ?? {
          content: [{ type: "text", text: "{}" }],
        }
    );
    const res = await call("synap_update_session", { addOutputs: [] });
    expect(res.isError).toBe(true);
    expect(payload(res).ignoredArgs).toBeUndefined();
  });
});

describe("limitClamped — a limit the page cap did not honour is said", () => {
  it("1ef84d45: list_sessions with limit 100 says 50 were used", async () => {
    // What the handler does with `limit` (session.ts): the one page clamp.
    execute.mockImplementation(
      async (_name: string, args: Record<string, unknown>) => ({
        content: [
          {
            type: "text",
            text: JSON.stringify({ count: pageLimit(args.limit, 20, 50) }),
          },
        ],
      })
    );
    const res = await call("synap_list_sessions", { limit: 100 });
    expect(payload(res)).toMatchObject({
      count: 50,
      limitClamped: { asked: 100, used: 50 },
    });
    // A limit within the cap, or none, says nothing.
    expect(payload(await call("synap_list_sessions", { limit: 30 }))).toEqual({
      count: 30,
    });
    expect(payload(await call("synap_list_sessions", {}))).toEqual({
      count: 20,
    });
  });

  it("a clamp outside a tool call (another door's caller) notes nothing", () => {
    expect(pageLimit(500, 20, 50)).toBe(50);
  });
});

describe("withCallNotices", () => {
  it("keeps a UI tool's structured copy equal to its text", () => {
    const res = withCallNotices(
      {
        content: [{ type: "text", text: '{"a":1}' }],
        structuredContent: { a: 1 },
      },
      { limitClamped: { asked: 9, used: 5 } }
    );
    expect(JSON.parse((res.content[0] as { text: string }).text)).toEqual(
      res.structuredContent
    );
  });
});
