/**
 * The MCP door's CONVERSATION identity, driven through the REAL `mcpHttpApp`
 * and the REAL SDK transport.
 *
 * `initialize` must MINT an `Mcp-Session-Id` (the client echoes it on every
 * later request), and a later request's id must reach the request context as
 * the conversation half of the client key — the fact session attribution and
 * focus key on (`clientKeyForApiKey`). The client's own header outranks
 * `_meta["live.synap/conversation"]`, which outranks the transport id; with
 * none, the request is its own per-call run (`key:<id>|call:<uuid>`, D1).
 *
 * Stubbed: the key lookup, the key→principal remap, the guest probe, the tool
 * profile read and `createMCPServer` — replaced by a one-tool SDK server whose
 * handler REPORTS `getRequestClientKey()`, so the assertion reads the value the
 * real resolver and focus door would read, not a shape. The runner state
 * (0384) is checked the same way, plus the door's call to the one writer
 * (`reportRunnerState`), made inside the request's context.
 */
import { describe, it, expect, vi } from "vitest";

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
  })),
}));
vi.mock("../../../access/guest-containment.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isGuestPrincipal: vi.fn(async () => false),
}));
const reported = vi.hoisted(() => [] as Array<string | null>);
vi.mock(
  "../../../services/focus-sessions/session-runners.js",
  async (importOriginal) => {
    const { getRequestRunnerState } = await import("@synap/database");
    return {
      ...(await importOriginal<Record<string, unknown>>()),
      reportRunnerState: vi.fn(async () => {
        reported.push(getRequestRunnerState()?.state ?? null);
        return 0;
      }),
    };
  }
);
vi.mock("../tool-access.js", () => ({
  loadKeyToolAccess: vi.fn(async () => ({ profile: "full" })),
}));
vi.mock("../index.js", async () => {
  const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
  const { CallToolRequestSchema, ListToolsRequestSchema } =
    await import("@modelcontextprotocol/sdk/types.js");
  const {
    getRequestClientKey,
    getRequestConversationCwd,
    getRequestRunnerState,
    getRequestReportedModel,
  } = await import("@synap/database");
  return {
    groundingBudgetBytes: () => 0,
    createMCPServer: () => {
      const server = new Server(
        { name: "probe", version: "0" },
        { capabilities: { tools: {} } }
      );
      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [],
      }));
      server.setRequestHandler(CallToolRequestSchema, async () => ({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              key: String(getRequestClientKey()),
              cwd: getRequestConversationCwd() ?? null,
              state: getRequestRunnerState()?.state ?? null,
              // Absent (undefined) when nothing usable was reported.
              ran: getRequestReportedModel(),
            }),
          },
        ],
      }));
      return server;
    },
  };
});

import { mcpHttpApp } from "../http-handler.js";

const HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
  authorization: "Bearer synap_test_key",
  "mcp-protocol-version": "2025-06-18",
};

async function post(body: unknown, extra: Record<string, string> = {}) {
  return mcpHttpApp.request("/", {
    method: "POST",
    headers: { ...HEADERS, ...extra },
    body: JSON.stringify(body),
  });
}

async function contextOfCall(
  extra: Record<string, string> = {},
  meta?: Record<string, unknown>
): Promise<{
  key: string;
  cwd: string | null;
  state: string | null;
  ran?: { model?: string; provider?: string };
}> {
  const res = await post(
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      // A read-shaped name, so the attribution hard-reject never applies.
      params: {
        name: "synap_ask",
        arguments: {},
        ...(meta ? { _meta: meta } : {}),
      },
    },
    extra
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    result: { content: Array<{ text: string }> };
  };
  return JSON.parse(body.result.content[0].text);
}

async function clientKeyOfCall(extra: Record<string, string> = {}) {
  return (await contextOfCall(extra)).key;
}

describe("MCP conversation identity (Mcp-Session-Id)", () => {
  it("initialize mints a conversation id, fresh per connection", async () => {
    const init = (id: number) =>
      post({
        jsonrpc: "2.0",
        id,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "0" },
        },
      });
    const a = await init(1);
    const b = await init(1);
    expect(a.status).toBe(200);
    const idA = a.headers.get("mcp-session-id");
    const idB = b.headers.get("mcp-session-id");
    expect(idA).toMatch(/^[0-9a-f-]{36}$/);
    expect(idB).toMatch(/^[0-9a-f-]{36}$/);
    expect(idB).not.toBe(idA);
  });

  it("a later request's Mcp-Session-Id is the conversation half of the client key", async () => {
    expect(await clientKeyOfCall({ "mcp-session-id": "conv-A" })).toBe(
      "key:key-1|conv:conv-A"
    );
    expect(await clientKeyOfCall({ "mcp-session-id": "conv-B" })).toBe(
      "key:key-1|conv:conv-B"
    );
  });

  // D1: two routines on one key in the same minute must never share a run.
  it("no conversation id → a per-call run, distinct per request", async () => {
    const a = await clientKeyOfCall();
    const b = await clientKeyOfCall();
    expect(a).toMatch(/^key:key-1\|call:[0-9a-f-]{36}$/);
    expect(b).toMatch(/^key:key-1\|call:[0-9a-f-]{36}$/);
    expect(b).not.toBe(a);
  });

  it("_meta live.synap/conversation names the conversation, with its cwd", async () => {
    const CC = "claude-code:2b1f7c1e-6f52-4d0e-9d1b-3b2f9e0a7c11";
    expect(
      await contextOfCall(
        { "mcp-session-id": "conv-A" },
        {
          "live.synap/conversation": CC,
          "live.synap/conversationCwd": "/Users/a/code",
        }
      )
    ).toEqual({
      key: `key:key-1|conv:${CC}`,
      cwd: "/Users/a/code",
      state: null,
    });
  });

  it("the X-Synap-Conversation header outranks _meta when both are sent", async () => {
    expect(
      (
        await contextOfCall(
          { "x-synap-conversation": "claude-ai:hdr" },
          { "live.synap/conversation": "claude-code:meta" }
        )
      ).key
    ).toBe("key:key-1|conv:claude-ai:hdr");
  });

  it("a non-string _meta value is no conversation id", async () => {
    expect(
      (await contextOfCall({}, { "live.synap/conversation": 42 })).key
    ).toMatch(/^key:key-1\|call:/);
  });

  // A LOCAL agent's client (the synap stdio bridge) names its OWN conversation
  // — the id a person can reopen — and it outranks the transport id.
  it("X-Synap-Conversation outranks Mcp-Session-Id and carries the cwd", async () => {
    const CC = "claude-code:8c34a72b-b1c1-4c37-9c1f-02920b69ccb2";
    expect(
      await contextOfCall({
        "mcp-session-id": "conv-A",
        "x-synap-conversation": CC,
        "x-synap-conversation-cwd": "/Users/a/code/synap",
      })
    ).toEqual({
      key: `key:key-1|conv:${CC}`,
      cwd: "/Users/a/code/synap",
      state: null,
    });
  });

  // 0384: any harness adapter says what its runner is doing, on any call.
  it("X-Synap-Runner-State reaches the request with the conversation, and the door hands it to the runner writer", async () => {
    const CC = "claude-code:8c34a72b-b1c1-4c37-9c1f-02920b69ccb2";
    reported.length = 0;
    expect(
      await contextOfCall({
        "x-synap-conversation": CC,
        "x-synap-runner-state": "needs_permission",
      })
    ).toMatchObject({ key: `key:key-1|conv:${CC}`, state: "needs_permission" });
    expect(reported).toContain("needs_permission");
  });

  it("_meta live.synap/runnerState names it for a client that cannot set headers; an unknown word is none", async () => {
    const CC = "claude-code:8c34a72b-b1c1-4c37-9c1f-02920b69ccb2";
    expect(
      (
        await contextOfCall(
          { "x-synap-conversation": CC },
          { "live.synap/runnerState": "busy" }
        )
      ).state
    ).toBe("busy");
    expect(
      (
        await contextOfCall({
          "x-synap-conversation": CC,
          "x-synap-runner-state": "asleep",
        })
      ).state
    ).toBeNull();
  });

  // 0389: the model and provider a client says it runs on, on any call.
  it("X-Synap-Model / X-Synap-Model-Provider reach the request, parsed; none sent reads unknown", async () => {
    const CC = "claude-code:8c34a72b-b1c1-4c37-9c1f-02920b69ccb2";
    expect(
      (
        await contextOfCall({
          "x-synap-conversation": CC,
          "x-synap-model": "claude-opus-5-5",
          "x-synap-model-provider": "Anthropic",
        })
      ).ran
    ).toEqual({ model: "claude-opus-5-5", provider: "anthropic" });
    expect(
      (await contextOfCall({ "x-synap-conversation": CC })).ran
    ).toBeUndefined();
    expect(
      (
        await contextOfCall({
          "x-synap-model": "https://api.z.ai/v1",
          "x-synap-model-provider": "https://api.z.ai",
        })
      ).ran
    ).toEqual({ provider: "other" });
  });

  it("_meta names them for a client that cannot set headers; the header outranks it", async () => {
    expect(
      (
        await contextOfCall(
          {},
          { "live.synap/model": "glm-4.6", "live.synap/modelProvider": "zai" }
        )
      ).ran
    ).toEqual({ model: "glm-4.6", provider: "zai" });
    expect(
      (
        await contextOfCall(
          { "x-synap-model": "claude-opus-5-5" },
          { "live.synap/model": "glm-4.6" }
        )
      ).ran
    ).toEqual({ model: "claude-opus-5-5" });
  });
});
