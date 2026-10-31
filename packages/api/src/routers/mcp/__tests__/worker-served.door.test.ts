/**
 * Wave contract 3, the door half: a tools/call through the real MCP HTTP door
 * (`mcpHttpApp`, real SDK transport) hands the request's `X-Synap-Runner`
 * header to `recordWorkerServed` with the AUTHENTICATING key's id, and a call
 * without the header hands it nothing to stamp. What the stamp writes (only a
 * `synap-worker` value, throttled) is pinned in `worker-served.pglite.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

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
vi.mock("../../../services/worker-served.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../services/worker-served.js")
  >()),
  recordWorkerServed: vi.fn(async () => true),
}));
vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  db: {},
}));

import { mcpHttpApp } from "../http-handler.js";
import { tools } from "../tools/index.js";
import { recordWorkerServed } from "../../../services/worker-served.js";

const stamp = vi.mocked(recordWorkerServed);

const HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
  authorization: "Bearer synap_test_key",
  "mcp-protocol-version": "2025-06-18",
};

const orient = {
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name: "synap_orient", arguments: {} },
};

const post = (extra: Record<string, string> = {}) =>
  mcpHttpApp.request("/", {
    method: "POST",
    headers: { ...HEADERS, ...extra },
    body: JSON.stringify(orient),
  });

beforeEach(() => {
  stamp.mockClear();
  vi.mocked(tools.execute).mockClear();
});

describe("MCP door: the runner header reaches the stamp", () => {
  it("a call carrying X-Synap-Runner stamps the authenticating key with that value", async () => {
    const res = await post({ "X-Synap-Runner": "synap-worker/0.9.1" });
    expect(res.status).toBe(200);
    expect(tools.execute).toHaveBeenCalledTimes(1);
    expect(stamp).toHaveBeenCalledTimes(1);
    expect(stamp).toHaveBeenCalledWith("key-1", "synap-worker/0.9.1");
  });

  it("a call without the header hands the stamp nothing", async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(tools.execute).toHaveBeenCalledTimes(1);
    expect(stamp).toHaveBeenCalledWith("key-1", undefined);
  });
});
