/**
 * A key that was DISCONNECTED says so on `/mcp`, with the way back; a key the
 * pod never issued stays generic (W4 A4). Driven through the REAL
 * `mcpHttpApp`; only the key service is stubbed — the handler's choice between
 * the two messages is what is under test.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const svc = vi.hoisted(() => ({
  validateApiKey: vi.fn(async () => null),
  isRevokedKey: vi.fn(async () => false),
}));
vi.mock("../../../services/api-keys.js", () => ({ apiKeyService: svc }));

import { mcpHttpApp, MCP_KEY_DISCONNECTED_MESSAGE } from "../http-handler.js";

async function call(): Promise<{ error?: { message?: string } }> {
  const res = await mcpHttpApp.request("/", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: "Bearer synap_hub_test_whatever",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  return res.json();
}

beforeEach(() => {
  svc.validateApiKey.mockClear();
  svc.isRevokedKey.mockReset();
});

describe("/mcp auth failure message", () => {
  it("a revoked key is told it was disconnected, and how to reconnect", async () => {
    svc.isRevokedKey.mockResolvedValue(true);
    const body = await call();
    expect(body.error?.message).toBe(MCP_KEY_DISCONNECTED_MESSAGE);
    expect(MCP_KEY_DISCONNECTED_MESSAGE).toMatch(/synap init/);
    expect(svc.isRevokedKey).toHaveBeenCalledWith("synap_hub_test_whatever");
  });

  it("an unknown key stays generic — nothing leaks", async () => {
    svc.isRevokedKey.mockResolvedValue(false);
    const body = await call();
    expect(body.error?.message).toBe("Invalid or expired API key");
  });
});
