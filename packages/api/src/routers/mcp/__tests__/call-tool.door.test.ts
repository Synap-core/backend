/**
 * `synap_call_tool` (call-tool.ts): the dispatcher runs an unlocked tool in the
 * same turn, and is judged as THAT tool, never as itself.
 *
 * Driven through the real code: `createMCPServer`'s tools/call handler (the
 * fence, the shadow, the dispatch), and the HTTP door (`mcpHttpApp`, real SDK
 * transport) for the request guard's classification. Stubbed: `tools.execute`
 * (the tool itself; governance runs inside it and has its own real-gate test,
 * `call-tool.real-gate.pglite.test.ts`), the key's tool access, the door
 * lookup and the guard's `runGuarded` (a spy that calls through).
 *
 * Rows that rule out a wrong design, each named:
 *  - a bare human key dispatching a WRITE is refused like its direct call
 *    (rules out "nothing fences a dispatched call");
 *  - the same key dispatching a READ runs it (rules out "the fence judges the
 *    dispatcher's own name", a write tool, which would refuse every read);
 *  - a space-pinned key dispatching a pod-wide read is refused, an unpinned
 *    one runs it (rules out both the missing fence and the dispatcher's own
 *    REFUSED classification being what is judged).
 *
 * NOT covered here: that governance proposes (the real-gate test does), and
 * the edge rate class (apps/api `security.ask-budget.test.ts`).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  AI_READ_PROPOSE_ROLE_ID,
  GRANT_PRESETS,
} from "@synap-core/types/grants";

const h = vi.hoisted(() => ({
  access: { profile: null as string | null, groups: [] as string[] },
  door: "pod-mcp" as "pod-mcp" | "cp-connector",
  guarded: [] as Array<{ route: string; exemption: unknown }>,
}));

vi.mock("../../../services/api-keys.js", () => ({
  apiKeyService: {
    validateApiKey: vi.fn(async () => ({
      id: "key-1",
      userId: "user-1",
      scope: ["mcp.read", "mcp.write"],
      keyType: "hub_inbound",
      workspaceId: null,
      linkedUserId: "user-1",
    })),
  },
}));
vi.mock("../../../access/key-identity.js", () => ({
  resolveKeyIdentity: vi.fn(async () => ({
    effectiveUserId: "user-1",
    agentUserId: "agent-1",
    isAgent: true,
    grant: null,
  })),
}));
vi.mock("../../../access/guest-containment.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isGuestPrincipal: vi.fn(async () => false),
}));
vi.mock("../../../access/pod-access.js", () => ({
  reportNoPodAccess: vi.fn(async () => undefined),
}));
vi.mock("../tool-access.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../tool-access.js")>()),
  loadKeyToolAccess: vi.fn(async () => h.access),
}));
vi.mock(
  "../../../services/capability-briefs/resolve-skill-door.js",
  async () => ({ resolveSkillDoor: vi.fn(async () => h.door) })
);
vi.mock("../../../services/worker-served.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  recordWorkerServed: vi.fn(async () => undefined),
}));
vi.mock("../../../middleware/hub-request-guard.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../middleware/hub-request-guard.js")
    >();
  return {
    ...actual,
    runGuarded: (
      opts: { route: string; exemption: unknown },
      fn: () => Promise<Response>,
      ...rest: unknown[]
    ) => {
      h.guarded.push({ route: opts.route, exemption: opts.exemption });
      return (actual.runGuarded as (...a: unknown[]) => Promise<Response>)(
        opts,
        fn,
        ...rest
      );
    },
  };
});
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

import { mcpHttpApp } from "../http-handler.js";
import { createMCPServer } from "../index.js";
import { tools } from "../tools/index.js";
import {
  UNATTRIBUTED_WRITE_MESSAGE,
  type McpCallPrincipal,
} from "../call-fence.js";
import { GRANT_DOOR_UNSUPPORTED } from "../../../access/grant-door-fence.js";
import { NO_UI_RENDERER } from "../ui-tools.js";
import { CALL_TOOL_NAME, effectiveToolCall } from "../call-tool-name.js";

const AI_PERMISSIONS = GRANT_PRESETS.find(
  (r) => r.id === AI_READ_PROPOSE_ROLE_ID
)!.grant.permissions;
const SPACE_PINNED = {
  scopes: [{ permissions: AI_PERMISSIONS, workspaceIds: ["w1"] }],
  clientId: null,
};
const UNPINNED = { scopes: [{ permissions: AI_PERMISSIONS }], clientId: null };

const AGENT: McpCallPrincipal = {
  keyType: "hub_inbound",
  linkedUserId: "user-1",
  isAgent: true,
};
const BARE: McpCallPrincipal = {
  keyType: "user_pat",
  linkedUserId: null,
  isAgent: false,
};

const execute = vi.mocked(tools.execute);

beforeEach(() => {
  execute.mockClear();
  execute.mockImplementation(async () => ({
    content: [{ type: "text", text: '{"executed":true}' }],
  }));
  h.access = { profile: null, groups: [] };
  h.door = "pod-mcp";
  h.guarded = [];
});

type Handler = (req: unknown, extra: unknown) => Promise<unknown>;
type Result = { isError?: boolean; content: Array<{ text: string }> };

/** The tools/call handler for one key. `keyId` set = the key's profile applies. */
function door(principal: McpCallPrincipal, keyId?: string) {
  const server = createMCPServer(
    "ws-lens",
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
    requestInfo: { headers: {} },
  };
  return {
    direct: (name: string, args: Record<string, unknown> = {}) =>
      call(
        { method: "tools/call", params: { name, arguments: args } },
        extra
      ) as Promise<Result>,
    dispatch: (dispatcherArgs: Record<string, unknown>) =>
      call(
        {
          method: "tools/call",
          params: { name: CALL_TOOL_NAME, arguments: dispatcherArgs },
        },
        extra
      ) as Promise<Result>,
  };
}

const text = (r: Result) => r.content.map((c) => c.text).join("\n");

describe("the fence judges the tool the dispatcher names", () => {
  it("a bare human key's dispatched WRITE is refused exactly like its direct call", async () => {
    const d = door(BARE);
    await expect(
      d.direct("synap_create_entity", { profileSlug: "note", title: "x" })
    ).rejects.toThrow(UNATTRIBUTED_WRITE_MESSAGE);
    await expect(
      d.dispatch({
        tool: "synap_create_entity",
        arguments: { profileSlug: "note", title: "x" },
      })
    ).rejects.toThrow(UNATTRIBUTED_WRITE_MESSAGE);
    expect(execute).not.toHaveBeenCalled();
  });

  it("the same bare key's dispatched READ runs (the dispatcher's own write annotation is never judged)", async () => {
    await door(BARE).dispatch({
      tool: "synap_ask",
      arguments: { query: "q" },
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]![0]).toBe("synap_ask");
  });

  it("a space-pinned key's dispatched pod-wide read is refused like the direct call; an unpinned key runs it", async () => {
    const pinned = door({ ...AGENT, grant: SPACE_PINNED });
    await expect(
      pinned.dispatch({ tool: "synap_ask", arguments: { query: "q" } })
    ).rejects.toThrow(GRANT_DOOR_UNSUPPORTED);
    await expect(
      pinned.dispatch({ tool: "synap_diagnose", arguments: {} })
    ).rejects.toThrow(GRANT_DOOR_UNSUPPORTED);
    expect(execute).not.toHaveBeenCalled();

    await door({ ...AGENT, grant: UNPINNED }).dispatch({
      tool: "synap_ask",
      arguments: { query: "q" },
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("a space-pinned key's dispatched write reaches the tool, as its direct call does (the gate bounds writes)", async () => {
    const d = door({ ...AGENT, grant: SPACE_PINNED });
    await d.dispatch({
      tool: "synap_create_entity",
      arguments: { profileSlug: "note", title: "x" },
    });
    await d.direct("synap_create_entity", { profileSlug: "note", title: "x" });
    expect(execute).toHaveBeenCalledTimes(2);
  });
});

describe("the dispatched call is the direct call", () => {
  it("execute gets the same name, arguments (with the URL lens) and identity as the direct call", async () => {
    const d = door(AGENT);
    const args = { profileSlug: "note", title: "x" };
    await d.direct("synap_create_entity", args);
    await d.dispatch({ tool: "synap_create_entity", arguments: args });
    const [directCall, dispatchedCall] = execute.mock.calls;
    // name, args, userId, scopes, sessionUserId, agentUserId, keyType, keyWorkspaceId
    expect(dispatchedCall!.slice(0, 8)).toEqual(directCall!.slice(0, 8));
    expect(dispatchedCall![0]).toBe("synap_create_entity");
    expect(dispatchedCall![1]).toEqual({ ...args, workspaceId: "ws-lens" });
    expect(dispatchedCall![5]).toBe("agent-1");
  });

  it("the tool's result comes back unchanged, a proposal included", async () => {
    const proposed = {
      content: [{ type: "text" as const, text: '{"status":"proposed"}' }],
    };
    execute.mockResolvedValueOnce(proposed);
    const out = await door(AGENT).dispatch({
      tool: "synap_create_entity",
      arguments: { profileSlug: "note", title: "x" },
    });
    expect(out).toEqual(proposed);
  });

  it("the dispatcher's sessionId reaches the tool when its arguments name none", async () => {
    const d = door(AGENT);
    await d.dispatch({
      tool: "synap_create_entity",
      arguments: { profileSlug: "note", title: "x" },
      sessionId: "s-outer",
    });
    await d.dispatch({
      tool: "synap_create_entity",
      arguments: { profileSlug: "note", title: "x", sessionId: "s-inner" },
      sessionId: "s-outer",
    });
    expect(
      (execute.mock.calls[0]![1] as { sessionId?: string }).sessionId
    ).toBe("s-outer");
    expect(
      (execute.mock.calls[1]![1] as { sessionId?: string }).sessionId
    ).toBe("s-inner");
  });
});

describe("what the dispatcher refuses (nothing runs)", () => {
  it("itself, an unknown name, and no tool name", async () => {
    const d = door(AGENT);
    const self = await d.dispatch({ tool: CALL_TOOL_NAME, arguments: {} });
    expect(self.isError).toBe(true);
    expect(text(self)).toContain("cannot call itself");
    const unknown = await d.dispatch({ tool: "synap_nope", arguments: {} });
    expect(unknown.isError).toBe(true);
    expect(text(unknown)).toContain('No tool is named "synap_nope"');
    const none = await d.dispatch({ arguments: {} });
    expect(none.isError).toBe(true);
    expect(text(none)).toContain("`tool` is required");
    expect(execute).not.toHaveBeenCalled();
  });

  it("a tool whose group this entry key has not unlocked: the exact load_skill call, then it runs once unlocked", async () => {
    h.access = { profile: "entry", groups: [] };
    const locked = await door(AGENT, "key-1").dispatch({
      tool: "synap_create_document",
      arguments: { title: "t", content: "c" },
    });
    expect(locked.isError).toBe(true);
    expect(text(locked)).toContain('synap_load_skill({ref: "tools:data"})');
    expect(execute).not.toHaveBeenCalled();

    h.access = { profile: "entry", groups: ["data"] };
    await door(AGENT, "key-1").dispatch({
      tool: "synap_create_document",
      arguments: { title: "t", content: "c" },
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]![0]).toBe("synap_create_document");
  });

  it("the connector's key reads the unlock call in its own tool names", async () => {
    h.access = { profile: "entry", groups: [] };
    h.door = "cp-connector";
    const locked = await door(AGENT, "key-cp").dispatch({
      tool: "synap_create_document",
      arguments: { title: "t" },
    });
    expect(text(locked)).toContain('pod__load_skill({ref: "tools:data"})');
  });

  it("an entry tool and a legacy key's every tool are runnable (only locked groups are refused)", async () => {
    h.access = { profile: "entry", groups: [] };
    await door(AGENT, "key-1").dispatch({
      tool: "synap_ask",
      arguments: { query: "q" },
    });
    h.access = { profile: null, groups: [] };
    await door(AGENT, "key-legacy").dispatch({
      tool: "synap_create_document",
      arguments: { title: "t" },
    });
    expect(execute.mock.calls.map((c) => c[0])).toEqual([
      "synap_ask",
      "synap_create_document",
    ]);
  });
});

describe("arguments: the schema is what a bad call gets back", () => {
  it("left out: the tool's input schema, not an error, and nothing runs", async () => {
    const out = await door(AGENT).dispatch({ tool: "synap_create_document" });
    expect(out.isError).toBeUndefined();
    expect(text(out)).toContain('"tool":"synap_create_document"');
    expect(text(out)).toContain('"inputSchema"');
    expect(execute).not.toHaveBeenCalled();
  });

  it("not an object, or a required key missing: an error carrying the schema", async () => {
    const d = door(AGENT);
    const notObject = await d.dispatch({
      tool: "synap_ask",
      arguments: "who is Ada",
    });
    expect(notObject.isError).toBe(true);
    expect(text(notObject)).toContain('"inputSchema"');
    const missing = await d.dispatch({ tool: "synap_ask", arguments: {} });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toContain("`query`");
    expect(text(missing)).toContain('"inputSchema"');
    expect(execute).not.toHaveBeenCalled();
  });

  it("a tool that answers an error gets its schema appended; a direct call does not", async () => {
    const err = {
      isError: true,
      content: [{ type: "text" as const, text: "profileSlug is not a kind" }],
    };
    execute.mockResolvedValue(err);
    const d = door(AGENT);
    const dispatched = await d.dispatch({
      tool: "synap_create_entity",
      arguments: { profileSlug: "nope", title: "x" },
    });
    expect(dispatched.isError).toBe(true);
    expect(dispatched.content[0]!.text).toBe("profileSlug is not a kind");
    expect(text(dispatched)).toContain("Input schema of synap_create_entity");
    expect(await d.direct("synap_create_entity", {})).toEqual(err);
  });
});

describe("the request guard classifies the dispatched tool (HTTP door)", () => {
  const post = (body: unknown) =>
    mcpHttpApp.request("/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: "Bearer synap_test_key",
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify(body),
    });

  it("a dispatched synap_wait_for_answer is a long poll, never timed out at 30 s, and is labelled by its name", async () => {
    await post({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: CALL_TOOL_NAME,
        arguments: {
          tool: "synap_wait_for_answer",
          arguments: { sessionId: "s" },
        },
      },
    });
    expect(h.guarded).toEqual([
      {
        route: "MCP tools/call synap_wait_for_answer",
        exemption: "long_poll",
      },
    ]);
  });

  it("a dispatched synap_ask is a model call; a dispatched plain read is guarded", async () => {
    for (const tool of ["synap_ask", "synap_get_entity"]) {
      await post({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: CALL_TOOL_NAME, arguments: { tool, arguments: {} } },
      });
    }
    expect(h.guarded.map((g) => g.exemption)).toEqual(["model", null]);
  });
});

describe("effectiveToolCall (the one unwrap every layer reads)", () => {
  it("unwraps once; leaves anything else as sent", () => {
    expect(
      effectiveToolCall(CALL_TOOL_NAME, {
        tool: " synap_ask ",
        arguments: { query: "q" },
      })
    ).toEqual({ name: "synap_ask", args: { query: "q" } });
    // Nested: the inner dispatcher is NOT unwrapped again (the door refuses it).
    expect(
      effectiveToolCall(CALL_TOOL_NAME, {
        tool: CALL_TOOL_NAME,
        arguments: { tool: "synap_ask" },
      }).name
    ).toBe(CALL_TOOL_NAME);
    expect(effectiveToolCall(CALL_TOOL_NAME, { arguments: {} }).name).toBe(
      CALL_TOOL_NAME
    );
    expect(
      effectiveToolCall(CALL_TOOL_NAME, { tool: "synap_ask", arguments: [] })
        .args
    ).toEqual({});
    expect(effectiveToolCall("synap_ask", { query: "q" })).toEqual({
      name: "synap_ask",
      args: { query: "q" },
    });
  });
});
