/**
 * The `/mcp` burst cap says how long to wait (plan 0d26a391, Option D).
 *
 * Before: a JSON-RPC 429 with no `Retry-After` and no wait in the body, so a
 * client guessed (the bridge paused 15 minutes for a 60-second window). Now
 * the refusal carries `Retry-After` in seconds and `error.data.retryAfter`,
 * and its limit is ONE config value (`RATE_LIMIT_MCP_MAX`), passed to a
 * deployed pod by compose and accepted by `deploy/env.schema`.
 *
 * Driven through the REAL `mcpHttpApp` and the REAL limiter; only the key
 * service is stubbed. The key's window is filled through the limiter's own
 * door (`checkHubRateLimit`), so the request under test is the refused one.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi, afterEach } from "vitest";

const svc = vi.hoisted(() => ({
  validateApiKey: vi.fn(),
  isRevokedKey: vi.fn(async () => false),
}));
vi.mock("../../../services/api-keys.js", () => ({ apiKeyService: svc }));

import { mcpHttpApp } from "../http-handler.js";
import {
  checkHubRateLimit,
  limitFor,
} from "../../../utils/hub-protocol-rate-limit.js";

let n = 0;
function freshKey(): string {
  n += 1;
  const id = `key-retry-after-${n}-${Date.now()}`;
  svc.validateApiKey.mockResolvedValue({ id, userId: "user-1" });
  return id;
}

async function call() {
  return mcpHttpApp.request("/", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: "Bearer synap_hub_test_whatever",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
}

afterEach(() => {
  delete process.env.RATE_LIMIT_MCP_MAX;
});

describe("/mcp 429 carries the wait", () => {
  it("Retry-After header (seconds) and error.data.retryAfter agree", async () => {
    process.env.RATE_LIMIT_MCP_MAX = "3";
    const key = freshKey();
    for (let i = 0; i < 3; i++) checkHubRateLimit(key, "mcp");

    const res = await call();
    expect(res.status).toBe(429);
    // Not an auth failure: no OAuth discovery hop.
    expect(res.headers.get("www-authenticate")).toBeNull();

    const header = res.headers.get("retry-after");
    expect(header).toMatch(/^\d+$/);
    const seconds = Number(header);
    expect(seconds).toBeGreaterThanOrEqual(1);
    expect(seconds).toBeLessThanOrEqual(60);

    const body = (await res.json()) as {
      error?: {
        message?: string;
        data?: { retryAfter?: number; limit?: number; scope?: string };
      };
    };
    expect(body.error?.data?.retryAfter).toBe(seconds);
    expect(body.error?.data?.limit).toBe(3);
    expect(body.error?.data?.scope).toBe("key");
    expect(body.error?.message).toContain(`${seconds}s`);
  });
});

describe("the /mcp limit is one config value", () => {
  it("RATE_LIMIT_MCP_MAX sets it; empty or invalid falls back to the default", () => {
    const fallback = limitFor("mcp");
    expect(fallback).toBeGreaterThan(0);

    process.env.RATE_LIMIT_MCP_MAX = "2";
    expect(limitFor("mcp")).toBe(2);
    const key = freshKey();
    checkHubRateLimit(key, "mcp");
    checkHubRateLimit(key, "mcp");
    expect(() => checkHubRateLimit(key, "mcp")).toThrow(/rate limit/i);

    process.env.RATE_LIMIT_MCP_MAX = "not-a-number";
    expect(limitFor("mcp")).toBe(fallback);
    process.env.RATE_LIMIT_MCP_MAX = "";
    expect(limitFor("mcp")).toBe(fallback);
  });

  it("a deployed pod receives it: compose passes it, env.schema accepts it", () => {
    const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
    const read = (rel: string) => readFileSync(root + rel, "utf8");
    const keys = [
      ...new Set(
        read("packages/api/src/utils/hub-protocol-rate-limit.ts").match(
          /\bRATE_LIMIT_[A-Z_]+\b/g
        ) ?? []
      ),
    ];
    // Non-vacuity: the scan sees the key it exists to check.
    expect(keys).toContain("RATE_LIMIT_MCP_MAX");

    const compose = read("deploy/docker-compose.yml");
    expect(keys.filter((k) => !compose.includes(`${k}: \${${k}:-}`))).toEqual(
      []
    );
    const schema = new Set(
      read("deploy/env.schema")
        .split("\n")
        .filter((l) => l.trim() && !l.trimStart().startsWith("#"))
        .map((l) => l.trim().split(/\s+/)[0])
    );
    expect(keys.filter((k) => !schema.has(k))).toEqual([]);
  });
});
