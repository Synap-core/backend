/**
 * W-C1 SHADOW: every MCP tool call's undeclared argument keys are COUNTED (a
 * log line per call, key names only) and the call is NOT refused. W-C3 turns
 * the same check into a refusal after seven days of these numbers.
 *
 * Real: the tool list (`tools.list()`, the declared set), the pure comparison,
 * and the `tools/call` dispatch of `createMCPServer` — the one point every
 * tool call passes. Stubbed: `tools.execute` (the tool itself is not under
 * test) and the shadow's own spy, which wraps the real function.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  shadowCalls: [] as Array<[string, unknown]>,
}));
vi.mock("./undeclared-args.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./undeclared-args.js")>();
  return {
    ...actual,
    shadowUndeclaredArgs: async (
      name: string,
      args: Record<string, unknown> | null | undefined
    ) => {
      h.shadowCalls.push([name, args]);
      return actual.shadowUndeclaredArgs(name, args);
    },
  };
});
vi.mock("./tools/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tools/index.js")>();
  return {
    ...actual,
    tools: {
      ...actual.tools,
      execute: vi.fn(async () => ({ content: [{ type: "text", text: "{}" }] })),
    },
  };
});
vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  db: {},
}));

import { createMCPServer } from "./index.js";
import { shadowUndeclaredArgs } from "./undeclared-args.js";

type Handler = (req: unknown, extra: unknown) => Promise<unknown>;

beforeEach(() => {
  h.shadowCalls = [];
});

describe("undeclared tool arguments — shadow (W-C1)", () => {
  it("names the undeclared keys of a READ tool, never the declared or door-injected ones", async () => {
    // a4e6977d: a filter a tool lacks used to be ignored silently.
    expect(
      await shadowUndeclaredArgs("synap_list_sessions", {
        trackId: "t",
        workspaceId: "w",
        projectId: "p",
        bogusFilter: 1,
      })
    ).toEqual(["bogusFilter"]);
  });

  it("a write tool's derived sessionId is declared, so it is never counted", async () => {
    expect(
      await shadowUndeclaredArgs("synap_link_entities", {
        sessionId: "s",
        addOutputs: [],
      })
    ).toEqual(["addOutputs"]);
  });

  it("an unknown tool counts nothing (the SDK reports the tool itself)", async () => {
    expect(await shadowUndeclaredArgs("synap_no_such_tool", { x: 1 })).toEqual(
      []
    );
  });

  it("the tools/call dispatch runs it on every call, and still executes the tool", async () => {
    const server = createMCPServer(undefined, "u1") as unknown as {
      _requestHandlers: Map<string, Handler>;
    };
    const handler = server._requestHandlers.get("tools/call");
    if (!handler) throw new Error("SDK no longer exposes _requestHandlers");
    const res = await handler(
      {
        method: "tools/call",
        params: { name: "synap_list_sessions", arguments: { bogusFilter: 1 } },
      },
      { signal: new AbortController().signal, sendNotification: vi.fn() }
    );
    expect(h.shadowCalls).toEqual([
      ["synap_list_sessions", { bogusFilter: 1 }],
    ]);
    // Shadow only: the call is not refused.
    expect(res).toMatchObject({ content: [{ type: "text", text: "{}" }] });
  });
});
