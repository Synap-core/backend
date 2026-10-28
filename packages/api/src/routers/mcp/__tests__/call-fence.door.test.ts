/**
 * Audit F4 (2026-10-28): a JSON-RPC BATCH walked past the MCP door's W1 grant
 * fence and its attribution hard-reject, which read `parsedBody.method` on ONE
 * object while the SDK transport dispatches every request in an array.
 *
 * Two halves, each driven through the real code:
 *  1. The HTTP door (`mcpHttpApp`, real SDK transport) refuses an array body
 *     with -32600 before any server is built.
 *  2. The tools/call door (`createMCPServer`'s real handler) refuses a
 *     space-pinned key's pod-wide read and a bare key's write, whatever the
 *     body looked like; `tools.execute` (the tool itself) is stubbed and must
 *     never run for a refused call. `resources/read` is fenced the same way.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  AI_READ_PROPOSE_ROLE_ID,
  GRANT_PRESETS,
} from "@synap-core/types/grants";

const h = vi.hoisted(() => ({
  grant: null as unknown,
  keyType: "hub_inbound",
  linkedUserId: "user-1" as string | null,
  isAgent: true,
}));

vi.mock("../../../services/api-keys.js", () => ({
  apiKeyService: {
    validateApiKey: vi.fn(async () => ({
      id: "key-1",
      userId: "user-1",
      scope: ["mcp.read", "mcp.write"],
      keyType: h.keyType,
      workspaceId: null,
      linkedUserId: h.linkedUserId,
    })),
  },
}));
vi.mock("../../../access/key-identity.js", () => ({
  resolveKeyIdentity: vi.fn(async () => ({
    effectiveUserId: "user-1",
    agentUserId: h.isAgent ? "agent-1" : undefined,
    isAgent: h.isAgent,
    grant: h.grant,
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
vi.mock("../resources/index.js", () => ({
  resources: {
    list: vi.fn(async () => []),
    read: vi.fn(async () => ({ contents: [] })),
  },
}));
vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  db: {},
}));

import { mcpHttpApp } from "../http-handler.js";
import { createMCPServer } from "../index.js";
import { tools } from "../tools/index.js";
import { resources } from "../resources/index.js";
import {
  MCP_BATCH_REFUSED,
  UNATTRIBUTED_WRITE_MESSAGE,
  type McpCallPrincipal,
} from "../call-fence.js";
import { GRANT_DOOR_UNSUPPORTED } from "../../../access/grant-door-fence.js";
import { NO_UI_RENDERER } from "../ui-tools.js";

const AI_PERMISSIONS = GRANT_PRESETS.find(
  (r) => r.id === AI_READ_PROPOSE_ROLE_ID
)!.grant.permissions;
/** An app limited at consent to one space: every permission, one workspace. */
const SPACE_PINNED = {
  scopes: [{ permissions: AI_PERMISSIONS, workspaceIds: ["w1"] }],
  clientId: null,
};
/** The same permissions, unpinned: reads every subject with no narrowing. */
const UNPINNED = { scopes: [{ permissions: AI_PERMISSIONS }], clientId: null };

const execute = vi.mocked(tools.execute);

beforeEach(() => {
  execute.mockClear();
  vi.mocked(resources.read).mockClear();
  h.grant = null;
  h.keyType = "hub_inbound";
  h.linkedUserId = "user-1";
  h.isAgent = true;
});

// ── 1. The HTTP door ─────────────────────────────────────────────────────────

const HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
  authorization: "Bearer synap_test_key",
  "mcp-protocol-version": "2025-06-18",
};

const askCall = (id: number) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name: "synap_ask", arguments: { query: "salary" } },
});

async function post(body: unknown) {
  return mcpHttpApp.request("/", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(body),
  });
}

describe("MCP HTTP door: a JSON-RPC batch is refused", () => {
  it("a one-element batch from a space-pinned key gets -32600 and runs nothing", async () => {
    h.grant = SPACE_PINNED;
    const res = await post([askCall(1)]);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: MCP_BATCH_REFUSED },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("a batch from a bare human key carrying a write runs nothing", async () => {
    h.keyType = "user_pat";
    h.linkedUserId = null;
    h.isAgent = false;
    const res = await post([
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "synap_create_entity", arguments: {} },
      },
    ]);
    expect(res.status).toBe(400);
    expect(execute).not.toHaveBeenCalled();
  });

  it("the same single call from a space-pinned key is refused by the tools/call door", async () => {
    h.grant = SPACE_PINNED;
    const res = await post(askCall(2));
    const body = (await res.json()) as {
      error?: { code: number; message: string };
    };
    // The SDK serialises an McpError as "MCP error <code>: <message>".
    expect(body.error?.code).toBe(-32001);
    expect(body.error?.message).toContain(GRANT_DOOR_UNSUPPORTED);
    expect(execute).not.toHaveBeenCalled();
  });

  it("a single call from an unpinned key reaches the tool", async () => {
    h.grant = UNPINNED;
    const res = await post(askCall(3));
    expect(res.status).toBe(200);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

// ── 2. The tools/call door, called directly ─────────────────────────────────

type Handler = (req: unknown, extra: unknown) => Promise<unknown>;

function handlersFor(principal: McpCallPrincipal) {
  const server = createMCPServer(
    undefined,
    "user-1",
    undefined,
    undefined,
    principal.isAgent ? "agent-1" : undefined,
    ["mcp.read", "mcp.write"],
    principal.keyType,
    null,
    undefined,
    "full",
    NO_UI_RENDERER,
    principal
  ) as unknown as { _requestHandlers: Map<string, Handler> };
  const call = server._requestHandlers.get("tools/call");
  const read = server._requestHandlers.get("resources/read");
  if (!call || !read) throw new Error("SDK no longer exposes _requestHandlers");
  const extra = {
    signal: new AbortController().signal,
    sendNotification: vi.fn(),
  };
  return {
    callTool: (name: string, args: Record<string, unknown> = {}) =>
      call({ method: "tools/call", params: { name, arguments: args } }, extra),
    readResource: (uri: string) =>
      read({ method: "resources/read", params: { uri } }, extra),
  };
}

const AGENT = { keyType: "hub_inbound", linkedUserId: "user-1", isAgent: true };

describe("MCP tools/call door: the grant fence", () => {
  it("refuses a space-pinned key's pod-wide read (synap_ask) before the tool runs", async () => {
    const { callTool } = handlersFor({ ...AGENT, grant: SPACE_PINNED });
    await expect(callTool("synap_ask", { query: "salary" })).rejects.toThrow(
      GRANT_DOOR_UNSUPPORTED
    );
    await expect(callTool("synap_orient")).rejects.toThrow(
      GRANT_DOOR_UNSUPPORTED
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it("lets the space-pinned key call a write tool (the gate bounds writes)", async () => {
    const { callTool } = handlersFor({ ...AGENT, grant: SPACE_PINNED });
    await callTool("synap_create_entity", { title: "x" });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("lets an unpinned key and a legacy key (no grant) read pod-wide", async () => {
    await handlersFor({ ...AGENT, grant: UNPINNED }).callTool("synap_ask", {
      query: "q",
    });
    await handlersFor({ ...AGENT, grant: null }).callTool("synap_ask", {
      query: "q",
    });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("refuses every scoped key a synap:// resource; a key with no grant reads it", async () => {
    // No synap:// resource is classified in the W1 inventory, so the fence
    // fails closed for ANY scoped grant, pinned or not.
    for (const grant of [SPACE_PINNED, UNPINNED]) {
      const { readResource } = handlersFor({ ...AGENT, grant });
      await expect(readResource("synap://entities")).rejects.toThrow(
        GRANT_DOOR_UNSUPPORTED
      );
    }
    expect(resources.read).not.toHaveBeenCalled();
    const legacy = handlersFor({ ...AGENT, grant: null });
    await legacy.readResource("synap://entities");
    expect(resources.read).toHaveBeenCalledTimes(1);
  });
});

describe("MCP tools/call door: the attribution hard-reject", () => {
  const BARE = { keyType: "user_pat", linkedUserId: null, isAgent: false };

  it("refuses a bare human key's write before the tool runs", async () => {
    await expect(
      handlersFor(BARE).callTool("synap_create_entity", { title: "x" })
    ).rejects.toThrow(UNATTRIBUTED_WRITE_MESSAGE);
    expect(execute).not.toHaveBeenCalled();
  });

  it("lets the bare key read, and an agent key write", async () => {
    await handlersFor(BARE).callTool("synap_ask", { query: "q" });
    await handlersFor(AGENT).callTool("synap_create_entity", { title: "x" });
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
