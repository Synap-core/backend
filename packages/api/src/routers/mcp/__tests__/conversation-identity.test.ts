/**
 * The MCP door's CONVERSATION identity, driven through the REAL `mcpHttpApp`
 * and the REAL SDK transport.
 *
 * `initialize` must MINT an `Mcp-Session-Id` (the client echoes it on every
 * later request), and a later request's id must reach the request context as
 * the conversation half of the client key — the fact session attribution and
 * focus key on (`clientKeyForApiKey`). Without the header the key alone is the
 * client (option A).
 *
 * Stubbed: the key lookup, the key→principal remap, the guest probe, the tool
 * profile read and `createMCPServer` — replaced by a one-tool SDK server whose
 * handler REPORTS `getRequestClientKey()`, so the assertion reads the value the
 * real resolver and focus door would read, not a shape.
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
vi.mock("../tool-access.js", () => ({
  loadKeyToolAccess: vi.fn(async () => ({ profile: "full" })),
}));
vi.mock("../index.js", async () => {
  const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
  const { CallToolRequestSchema, ListToolsRequestSchema } =
    await import("@modelcontextprotocol/sdk/types.js");
  const { getRequestClientKey } = await import("@synap/database");
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
        content: [{ type: "text", text: String(getRequestClientKey()) }],
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

async function clientKeyOfCall(extra: Record<string, string> = {}) {
  const res = await post(
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      // A read-shaped name, so the attribution hard-reject never applies.
      params: { name: "synap_ask", arguments: {} },
    },
    extra
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    result: { content: Array<{ text: string }> };
  };
  return body.result.content[0].text;
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

  it("no Mcp-Session-Id → the key alone is the client (option A)", async () => {
    expect(await clientKeyOfCall()).toBe("key:key-1");
  });
});
