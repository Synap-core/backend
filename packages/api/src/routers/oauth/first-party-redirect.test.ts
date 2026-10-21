/**
 * The first-party redirect matcher (join plan target A, RFC 8252 §7) against
 * the REAL registry: each row names the wrong rule it rules out.
 *
 *   localhost            — a matcher that compares hostnames loosely (§8.3)
 *   wrong / extra path   — a host-and-port-only matcher
 *   any port             — a matcher that pins one port (§7.3 says any)
 *   http://evil          — a matcher that only checks the scheme or the path
 *   other schemes        — a matcher that treats every non-https as loopback
 *   DCR                  — a registry that leaks into self-registration
 */

import { describe, it, expect } from "vitest";

import {
  FIRST_PARTY_CLIENTS,
  FIRST_PARTY_CLIENT_IDS,
  isFirstPartyClientId,
} from "./config.js";
import {
  DcrError,
  clientAcceptsRedirect,
  matchFirstPartyRedirect,
  validateDcrRequest,
} from "./protocol.js";
import { resolveFirstPartyClientName } from "@synap-core/types/vocabulary";

const DESKTOP = FIRST_PARTY_CLIENTS["synap-desktop"].redirects;
const RELAY = FIRST_PARTY_CLIENTS["synap-relay"].redirects;

describe("matchFirstPartyRedirect — synap-desktop (loopback, any port)", () => {
  it.each([
    "http://127.0.0.1:1/oauth/callback",
    "http://127.0.0.1:53111/oauth/callback",
    "http://127.0.0.1:65535/oauth/callback",
    "http://[::1]:8080/oauth/callback",
  ])("accepts %s", (uri) => {
    expect(matchFirstPartyRedirect(DESKTOP, uri)).toBe(true);
  });

  it.each([
    ["localhost", "http://localhost:53111/oauth/callback"],
    ["no port", "http://127.0.0.1/oauth/callback"],
    ["port 0", "http://127.0.0.1:0/oauth/callback"],
    ["leading-zero port", "http://127.0.0.1:053111/oauth/callback"],
    ["port above 65535", "http://127.0.0.1:65536/oauth/callback"],
    ["wrong path", "http://127.0.0.1:53111/callback"],
    ["path prefix", "http://127.0.0.1:53111/oauth/callback/evil"],
    ["dot segment", "http://127.0.0.1:53111/oauth/../oauth/callback"],
    ["encoded path", "http://127.0.0.1:53111/oauth/%63allback"],
    ["query", "http://127.0.0.1:53111/oauth/callback?x=1"],
    ["fragment", "http://127.0.0.1:53111/oauth/callback#x"],
    ["userinfo", "http://a@127.0.0.1:53111/oauth/callback"],
    ["other loopback ip", "http://127.0.0.2:53111/oauth/callback"],
    ["suffix host", "http://127.0.0.1.evil.com:53111/oauth/callback"],
    ["http://evil", "http://evil.example:53111/oauth/callback"],
    ["https loopback", "https://127.0.0.1:53111/oauth/callback"],
    ["custom scheme", "synap://oauth/callback"],
    ["relay's scheme", "live.synap.relay:/oauth/callback"],
    ["empty", ""],
  ])("refuses %s", (_why, uri) => {
    expect(matchFirstPartyRedirect(DESKTOP, uri)).toBe(false);
  });
});

describe("matchFirstPartyRedirect — synap-relay (claimed https, private scheme)", () => {
  it.each([
    "https://synap.live/app/oauth/callback",
    "live.synap.relay:/oauth/callback",
  ])("accepts %s", (uri) => {
    expect(matchFirstPartyRedirect(RELAY, uri)).toBe(true);
  });

  it.each([
    ["loopback", "http://127.0.0.1:53111/oauth/callback"],
    ["other host", "https://evil.example/app/oauth/callback"],
    ["subdomain", "https://x.synap.live/app/oauth/callback"],
    ["wrong path", "https://synap.live/oauth/callback"],
    ["http", "http://synap.live/app/oauth/callback"],
    ["double slash scheme", "live.synap.relay://oauth/callback"],
    ["other scheme", "synap://oauth/callback"],
    ["query", "https://synap.live/app/oauth/callback?x=1"],
  ])("refuses %s", (_why, uri) => {
    expect(matchFirstPartyRedirect(RELAY, uri)).toBe(false);
  });
});

describe("clientAcceptsRedirect — one check for every client kind", () => {
  it("uses a first-party client's rules, never its listed uris alone", () => {
    const client = { redirectUris: [], firstPartyRedirects: DESKTOP };
    expect(
      clientAcceptsRedirect(client, "http://127.0.0.1:4242/oauth/callback")
    ).toBe(true);
    expect(
      clientAcceptsRedirect(client, "http://localhost:4242/oauth/callback")
    ).toBe(false);
  });

  it("keeps every other client byte-exact against its registration", () => {
    const client = { redirectUris: ["https://claude.ai/api/mcp/auth_callback"] };
    expect(
      clientAcceptsRedirect(client, "https://claude.ai/api/mcp/auth_callback")
    ).toBe(true);
    // A loopback URI never passes for a registered (non-first-party) client.
    expect(
      clientAcceptsRedirect(client, "http://127.0.0.1:4242/oauth/callback")
    ).toBe(false);
  });
});

describe("the registry is closed and named", () => {
  it("knows exactly the two Synap apps", () => {
    expect([...FIRST_PARTY_CLIENT_IDS].sort()).toEqual([
      "synap-desktop",
      "synap-relay",
    ]);
    expect(isFirstPartyClientId("synap-desktop")).toBe(true);
    expect(isFirstPartyClientId("synap-cli")).toBe(false);
    expect(isFirstPartyClientId("toString")).toBe(false);
    expect(isFirstPartyClientId("__proto__")).toBe(false);
  });

  it("every first-party client has a vocabulary name (never a humanized id)", () => {
    for (const id of FIRST_PARTY_CLIENT_IDS) {
      expect(resolveFirstPartyClientName(id)).toMatch(/^Synap [A-Z]/);
    }
  });

  it("DCR stays https-only: a loopback or private-scheme redirect is refused", () => {
    for (const uri of [
      "http://127.0.0.1:53111/oauth/callback",
      "live.synap.relay:/oauth/callback",
    ]) {
      expect(() =>
        validateDcrRequest(
          {
            redirect_uris: [uri],
            client_name: "x",
            grant_types: ["authorization_code"],
            response_types: ["code"],
            token_endpoint_auth_method: "none",
            scope: "mcp.read",
          },
          ["mcp.read"],
          ["mcp.read"]
        )
      ).toThrow(DcrError);
    }
  });
});
