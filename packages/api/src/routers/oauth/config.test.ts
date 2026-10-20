/**
 * The scope rule both MCP mint doors share (`/token` on this AS and the legacy
 * `/mcp/redeem`): either grammar in, pod grammar out, with the hub-protocol
 * peers an MCP key needs to drive `/mcp`. Moved here with the helper from
 * mcp-redeem.test.ts (W9-MCP) so it outlives the legacy door.
 */
import { describe, it, expect } from "vitest";

import {
  mapCpScopesToPodScopes,
  oauthKeyInstanceId,
  parseOauthKeyInstanceId,
} from "./config.js";

// ─── scope-grammar mapping ────────────────────────────────────────────────

describe("mapCpScopesToPodScopes", () => {
  it("maps CP colon grammar to pod dot grammar (mcp:read → mcp.read)", () => {
    const out = mapCpScopesToPodScopes(["mcp:read"]);
    expect(out).toContain("mcp.read");
    expect(out).not.toContain("mcp:read");
    // read implies the hub-protocol peer so the key can drive /mcp
    expect(out).toContain("hub-protocol.read");
  });

  it("maps mcp:write → mcp.write and pulls in hub-protocol read+write", () => {
    const out = mapCpScopesToPodScopes(["mcp:write"]);
    expect(out).toContain("mcp.write");
    expect(out).toContain("hub-protocol.write");
    expect(out).toContain("hub-protocol.read");
  });

  it("drops unknown scopes", () => {
    const out = mapCpScopesToPodScopes(["totally:bogus"]);
    // nothing valid mapped → falls back to the functional default set
    expect(out).toEqual(
      expect.arrayContaining([
        "hub-protocol.read",
        "hub-protocol.write",
        "mcp.read",
        "mcp.write",
      ])
    );
  });

  it("empty / null → functional default set", () => {
    for (const input of [[], null, undefined] as const) {
      const out = mapCpScopesToPodScopes(input);
      expect(out).toEqual([
        "hub-protocol.read",
        "hub-protocol.write",
        "mcp.read",
        "mcp.write",
      ]);
    }
  });
});

// ─── the oauth instance id ────────────────────────────────────────────────

describe("oauthKeyInstanceId / parseOauthKeyInstanceId", () => {
  const USER = "11111111-1111-4111-8111-111111111111";

  it("round-trips a DCR client", () => {
    expect(
      parseOauthKeyInstanceId(oauthKeyInstanceId("dcr_abc", USER))
    ).toEqual({ clientId: "dcr_abc", userId: USER });
  });

  it("round-trips a CIMD client, whose id is a URL full of ':'", () => {
    const app = "https://studio.example.com:8443/.well-known/synap-client.json";
    expect(parseOauthKeyInstanceId(oauthKeyInstanceId(app, USER))).toEqual({
      clientId: app,
      userId: USER,
    });
  });

  it("reads anything else as null", () => {
    for (const v of [
      null,
      undefined,
      "mcp:abc",
      "oauth:",
      "oauth:x:",
      "oauth::u",
    ])
      expect(parseOauthKeyInstanceId(v)).toBeNull();
  });
});
