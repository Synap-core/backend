/**
 * Every MCP tools/call logs ONE line: the tool it runs, its time, its outcome,
 * never its arguments (`tool-call-log.ts`). Driven through the real tools/call
 * handler `createMCPServer` registers (the fence, the `synap_call_tool`
 * unwrap); only `tools.execute` (the tool itself) is stubbed, and the logger is
 * captured where `createLogger` builds it.
 *
 * NOT covered: the HTTP door's own time (auth, server build): that is in the
 * request log's total, not in `ms`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  lines: [] as Array<{ module: unknown; obj: unknown; msg: unknown }>,
}));

vi.mock("@synap-core/core", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const stub = (bindings: { module?: string }): unknown => {
    const log = {
      info: (obj: unknown, msg?: unknown) =>
        h.lines.push({ module: bindings.module, obj, msg }),
      warn: () => {},
      error: () => {},
      debug: () => {},
      trace: () => {},
      fatal: () => {},
      child: (b: { module?: string }) => stub({ ...bindings, ...b }),
    };
    return log;
  };
  return { ...actual, createLogger: stub };
});
vi.mock("../tool-access.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../tool-access.js")>()),
  loadKeyToolAccess: vi.fn(async () => ({ profile: "full" })),
}));
vi.mock("../tools/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tools/index.js")>();
  return {
    ...actual,
    tools: {
      ...actual.tools,
      execute: vi.fn(async () => ({
        content: [{ type: "text", text: '{"executed":true}' }],
      })),
    },
  };
});
vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  db: {},
}));

import { createMCPServer } from "../index.js";
import { tools } from "../tools/index.js";
import { CALL_TOOL_NAME } from "../call-tool-name.js";
import type { McpCallPrincipal } from "../call-fence.js";
import { NO_UI_RENDERER } from "../ui-tools.js";

const execute = vi.mocked(tools.execute);
const SECRET = "salary of Alice 93000";

type Handler = (req: unknown, extra: unknown) => Promise<unknown>;

function callToolAs(principal: McpCallPrincipal, keyId?: string) {
  const server = createMCPServer(
    undefined,
    "user-1",
    undefined,
    undefined,
    principal.isAgent ? "agent-1" : undefined,
    ["mcp.read", "mcp.write"],
    principal.keyType,
    null,
    keyId,
    "full",
    NO_UI_RENDERER,
    principal
  ) as unknown as { _requestHandlers: Map<string, Handler> };
  const call = server._requestHandlers.get("tools/call");
  if (!call) throw new Error("SDK no longer exposes _requestHandlers");
  const extra = {
    signal: new AbortController().signal,
    sendNotification: vi.fn(),
  };
  return (name: string, args: Record<string, unknown> = {}) =>
    call({ method: "tools/call", params: { name, arguments: args } }, extra);
}

const AGENT = {
  keyType: "hub_inbound",
  linkedUserId: "user-1",
  isAgent: true,
  grant: null,
};
const BARE = {
  keyType: "user_pat",
  linkedUserId: null,
  isAgent: false,
  grant: null,
};

/** The tool-call lines logged so far (other modules' lines left out). */
const toolLines = () =>
  h.lines
    .filter((l) => l.module === "mcp-tool-call")
    .map((l) => l.obj as Record<string, unknown>);

beforeEach(() => {
  h.lines.length = 0;
  execute.mockClear();
});

describe("MCP tools/call: one log line per call", () => {
  it("names the tool, its time and `ok`, and never the arguments", async () => {
    await callToolAs(AGENT, "key-1")("synap_ask", { query: SECRET });
    const lines = toolLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({
      tool: "synap_ask",
      key: "key-1",
      ms: expect.any(Number),
      outcome: "ok",
    });
    // No argument, no result text, anywhere in what was logged for the call.
    const logged = JSON.stringify(h.lines);
    expect(logged).not.toContain(SECRET);
    expect(logged).not.toContain("executed");
  });

  it("says `tool_error` when the tool answers isError", async () => {
    execute.mockResolvedValueOnce({
      content: [{ type: "text", text: "nope" }],
      isError: true,
    });
    await callToolAs(AGENT)("synap_ask", { query: "q" });
    expect(toolLines()).toEqual([
      { tool: "synap_ask", ms: expect.any(Number), outcome: "tool_error" },
    ]);
  });

  it("says `refused` when the door refuses the key (the tool never runs)", async () => {
    await expect(
      callToolAs(BARE)("synap_create_entity", { title: SECRET })
    ).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
    expect(toolLines()).toEqual([
      {
        tool: "synap_create_entity",
        ms: expect.any(Number),
        outcome: "refused",
      },
    ]);
    expect(JSON.stringify(h.lines)).not.toContain(SECRET);
  });

  it("says `error` when the tool throws, and still logs", async () => {
    execute.mockRejectedValueOnce(new Error("boom"));
    await expect(
      callToolAs(AGENT)("synap_ask", { query: "q" })
    ).rejects.toThrow("boom");
    expect(toolLines()).toEqual([
      { tool: "synap_ask", ms: expect.any(Number), outcome: "error" },
    ]);
  });

  it("names the INNER tool of synap_call_tool, with `via`", async () => {
    await callToolAs(AGENT)(CALL_TOOL_NAME, {
      tool: "synap_ask",
      arguments: { query: SECRET },
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(toolLines()).toEqual([
      {
        tool: "synap_ask",
        via: CALL_TOOL_NAME,
        ms: expect.any(Number),
        outcome: "ok",
      },
    ]);
    expect(JSON.stringify(h.lines)).not.toContain(SECRET);
  });
});
