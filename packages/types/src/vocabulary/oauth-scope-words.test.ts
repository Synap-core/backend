/**
 * OAuth scope words: each known scope has its sentence, and an unknown one
 * shows its raw token (never hidden, never humanized into something calm).
 */
import { describe, expect, it } from "vitest";
import { OAUTH_SCOPE_LABELS, resolveOAuthScopeLabel } from "./index.js";

describe("OAuth scope words", () => {
  it("names the two MCP scopes", () => {
    expect(Object.keys(OAUTH_SCOPE_LABELS).sort()).toEqual([
      "mcp.read",
      "mcp.write",
    ]);
    expect(resolveOAuthScopeLabel("mcp.read")).toMatch(/^Read your/);
  });

  it("an unknown scope reads as its token", () => {
    expect(resolveOAuthScopeLabel("vault.redeem")).toBe("vault.redeem");
    expect(resolveOAuthScopeLabel("toString")).toBe("toString");
  });
});
