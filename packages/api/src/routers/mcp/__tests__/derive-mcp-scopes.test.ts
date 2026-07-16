/**
 * deriveMcpScopes — regression coverage for the ONLY thing preventing a
 * production lockout of the MCP HTTP door.
 *
 * Three real mint sites in the wild issue Hub Protocol API keys with
 * `["hub-protocol.read","hub-protocol.write"]` and NO `mcp.*` scope at all:
 *   - synap-control-plane-api/src/lib/hub-key.ts:77
 *   - synap-cli/src/commands/agents.ts:582
 *   - packages/database/src/scripts/init-hub-keys.ts:97
 *
 * `deriveMcpScopes` (packages/api/src/routers/mcp/http-handler.ts) is the ONLY
 * reason those already-issued keys still get MCP access: it translates
 * `hub-protocol.*` (and `data.*`) inward to `mcp.read`/`mcp.write` before
 * `requireScope()` gates a tool call. Before this function existed, the HTTP
 * door hardcoded `["mcp.read","mcp.write"]` for every authenticated key, so
 * this equivalence was implicit and untested. If someone "simplifies" this
 * function to only recognize `mcp.*` (because that looks like the obviously
 * correct scope name), every key from the three sites above silently loses
 * MCP access — a production lockout, not a compile error, not a typecheck
 * failure — and nothing today would catch it except this file.
 *
 * Do NOT delete this file as "redundant" with the tripwire in
 * `packages/api/src/__tripwires__/` — that tripwire checks that real mint
 * sites derive to *some* non-empty scope; this file pins the exact table so a
 * behavior change here is caught immediately, not just an emptied-out case.
 */

import { describe, it, expect } from "vitest";
import { deriveMcpScopes } from "../http-handler.js";

describe("deriveMcpScopes", () => {
  it("hub-protocol.read alone derives to mcp.read only", () => {
    expect(deriveMcpScopes(["hub-protocol.read"])).toEqual(["mcp.read"]);
  });

  it("hub-protocol.write implies read: derives to both mcp.read and mcp.write", () => {
    const out = deriveMcpScopes(["hub-protocol.write"]);
    expect(out).toContain("mcp.read");
    expect(out).toContain("mcp.write");
    expect(out).toHaveLength(2);
  });

  it("hub-protocol.admin derives to both mcp.read and mcp.write", () => {
    const out = deriveMcpScopes(["hub-protocol.admin"]);
    expect(out).toContain("mcp.read");
    expect(out).toContain("mcp.write");
  });

  it("data.read derives to mcp.read only", () => {
    expect(deriveMcpScopes(["data.read"])).toEqual(["mcp.read"]);
  });

  it("data.write derives to both mcp.read and mcp.write", () => {
    const out = deriveMcpScopes(["data.write"]);
    expect(out).toContain("mcp.read");
    expect(out).toContain("mcp.write");
  });

  it("mcp.read passes through as mcp.read", () => {
    expect(deriveMcpScopes(["mcp.read"])).toEqual(["mcp.read"]);
  });

  it("an unrelated scope (realtime:observe) grants NO mcp access", () => {
    expect(deriveMcpScopes(["realtime:observe"])).toEqual([]);
  });

  it("empty scope array fails closed: no mcp access", () => {
    expect(deriveMcpScopes([])).toEqual([]);
  });

  it("null scopes fail closed: no mcp access", () => {
    expect(deriveMcpScopes(null)).toEqual([]);
  });

  it("the exact three-mint-site scope set derives to full read+write access", () => {
    // This is the literal array minted by hub-key.ts, agents.ts, and
    // init-hub-keys.ts — the case that motivated this whole function.
    const out = deriveMcpScopes(["hub-protocol.read", "hub-protocol.write"]);
    expect(out).toContain("mcp.read");
    expect(out).toContain("mcp.write");
  });
});
