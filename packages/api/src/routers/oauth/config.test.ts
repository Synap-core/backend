/**
 * The scope rule both MCP mint doors share (`/token` on this AS and the legacy
 * `/mcp/redeem`): either grammar in, pod grammar out, with the hub-protocol
 * peers an MCP key needs to drive `/mcp`. Moved here with the helper from
 * mcp-redeem.test.ts (W9-MCP) so it outlives the legacy door.
 */
import { describe, it, expect } from "vitest";

import {
  isSynapApp,
  mapCpScopesToPodScopes,
  oauthKeyInstanceId,
  parseOauthKeyInstanceId,
  podAppActsAs,
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

// ─── who a pod app's token acts as ────────────────────────────────────────

describe("isSynapApp / podAppActsAs — the person path is origin-exact", () => {
  const DOC = "/.well-known/synap-client.json";

  it("a Synap app on its exact https origin, any path on it, acts as the person", () => {
    for (const id of [
      `https://content-studio.synap.live${DOC}`,
      "https://content-studio.synap.live/other/path.json",
      `https://studio.synap.live${DOC}`,
    ]) {
      expect(isSynapApp(id)).toBe(true);
      expect(podAppActsAs(id)).toBe("person");
    }
  });

  it("a lookalike, another scheme, port or credentials never does", () => {
    for (const id of [
      `https://content-studio.synap.live.evil.com${DOC}`,
      `https://evil.com/content-studio.synap.live${DOC}`,
      `https://content-studio-synap.live${DOC}`,
      `https://xcontent-studio.synap.live${DOC}`,
      `https://content-studio.synap.live.${DOC}`,
      `http://content-studio.synap.live${DOC}`,
      `https://content-studio.synap.live:8443${DOC}`,
      `https://me@content-studio.synap.live${DOC}`,
      `https://me:pw@content-studio.synap.live${DOC}`,
      `https://unknown-app.synap.live${DOC}`,
      `https://synap.live${DOC}`,
      "app_00000000-0000-4000-8000-000000000000",
      "dcr_abc",
      "not a url",
    ]) {
      expect(isSynapApp(id), id).toBe(false);
      expect(podAppActsAs(id), id).toBe("agent");
    }
  });
});
