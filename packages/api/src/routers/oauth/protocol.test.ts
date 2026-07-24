/**
 * Pod OAuth 2.1 authorization server — protocol layer.
 *
 * `protocol.ts` is pure (no db, no env, no Hono), so these tests need no mocks
 * and cover the parts a client's security depends on:
 *   - issuer canonicality (RFC 8414 §2) and its agreement with the pod's
 *     INBOUND rule, `normalizeIssuerUrl`
 *   - metadata documents: self-consistent, S256-only, no lie about refresh
 *   - PKCE: a wrong or ABSENT verifier must throw, never pass
 *   - redirect_uri matching is exact, not prefix
 *   - DCR validation: https-only, public-client-only
 */

import { describe, it, expect } from "vitest";

import { normalizeIssuerUrl } from "../../utils/issuer-url-safety.js";
import {
  DcrError,
  OAuthError,
  assertPkceChallenge,
  buildAuthorizationServerMetadata,
  buildDcrResponse,
  buildProtectedResourceMetadata,
  canonicalizeIssuerUrl,
  computeS256Challenge,
  isRegisteredRedirectUri,
  narrowScopes,
  parseScopeParam,
  validateDcrRequest,
  verifyPkce,
} from "./protocol.js";

const SCOPES = ["mcp.read", "mcp.write"] as const;

// ─── Issuer canonicality ─────────────────────────────────────────────────────

describe("canonicalizeIssuerUrl", () => {
  it("strips a trailing slash so the issuer is byte-comparable", () => {
    expect(canonicalizeIssuerUrl("https://pod.test.synap.live/")).toBe(
      "https://pod.test.synap.live"
    );
    expect(canonicalizeIssuerUrl("https://pod.test.synap.live")).toBe(
      "https://pod.test.synap.live"
    );
  });

  it("rejects credentials, query and fragment — each makes one pod spellable twice", () => {
    expect(canonicalizeIssuerUrl("https://u:p@pod.test.synap.live")).toBeNull();
    expect(canonicalizeIssuerUrl("https://pod.test.synap.live?a=1")).toBeNull();
    expect(canonicalizeIssuerUrl("https://pod.test.synap.live#x")).toBeNull();
  });

  it("rejects non-https by default and accepts http loopback only when opted in", () => {
    expect(canonicalizeIssuerUrl("http://pod.test.synap.live")).toBeNull();
    expect(canonicalizeIssuerUrl("http://localhost:4000")).toBeNull();
    expect(
      canonicalizeIssuerUrl("http://localhost:4000", {
        allowInsecureLoopback: true,
      })
    ).toBe("http://localhost:4000");
    // Loopback allowance is LOOPBACK only — never a public host over http.
    expect(
      canonicalizeIssuerUrl("http://pod.test.synap.live", {
        allowInsecureLoopback: true,
      })
    ).toBeNull();
  });

  it("agrees with normalizeIssuerUrl (the INBOUND trusted-issuer rule) on https", () => {
    // The two functions guard opposite directions and must not drift: a pod
    // whose own issuer string differs from what a peer would canonicalize it to
    // produces a `iss` mismatch that is very hard to debug.
    for (const raw of [
      "https://pod.test.synap.live/",
      "https://pod.test.synap.live",
      "https://pod.test.synap.live/tenant/",
    ]) {
      expect(canonicalizeIssuerUrl(raw)).toBe(normalizeIssuerUrl(raw));
    }
  });

  it("returns null for empty/garbage input rather than throwing", () => {
    expect(canonicalizeIssuerUrl(undefined)).toBeNull();
    expect(canonicalizeIssuerUrl("")).toBeNull();
    expect(canonicalizeIssuerUrl("not-a-url")).toBeNull();
  });
});

// ─── Metadata documents ──────────────────────────────────────────────────────

describe("buildAuthorizationServerMetadata", () => {
  const issuer = "https://pod.test.synap.live";
  const doc = buildAuthorizationServerMetadata(issuer, SCOPES);

  it("uses the canonical issuer verbatim and derives every endpoint from it", () => {
    expect(doc.issuer).toBe(issuer);
    expect(doc.authorization_endpoint).toBe(`${issuer}/authorize`);
    expect(doc.token_endpoint).toBe(`${issuer}/token`);
    expect(doc.registration_endpoint).toBe(`${issuer}/register`);
  });

  it("advertises S256 ONLY — OAuth 2.1 removes `plain`", () => {
    expect(doc.code_challenge_methods_supported).toEqual(["S256"]);
  });

  it("does not advertise a refresh_token grant or offline_access", () => {
    // This AS issues no refresh token; advertising one is a lie a client acts on.
    expect(doc.grant_types_supported).toEqual(["authorization_code"]);
    expect(doc.scopes_supported).not.toContain("offline_access");
  });

  it("declares public clients (token_endpoint_auth_methods = none)", () => {
    expect(doc.token_endpoint_auth_methods_supported).toEqual(["none"]);
    expect(doc.response_types_supported).toEqual(["code"]);
  });
});

describe("buildProtectedResourceMetadata", () => {
  it("names /mcp as the resource and this same pod as its only AS", () => {
    const issuer = "https://pod.test.synap.live";
    const doc = buildProtectedResourceMetadata(issuer, SCOPES);
    expect(doc.resource).toBe(`${issuer}/mcp`);
    // claude.ai reads authorization_servers[0] and ignores the rest.
    expect(doc.authorization_servers).toEqual([issuer]);
  });
});

// ─── PKCE ────────────────────────────────────────────────────────────────────

describe("verifyPkce", () => {
  const verifier = "a".repeat(64);
  const challenge = computeS256Challenge(verifier);

  it("accepts the matching verifier", () => {
    expect(() => verifyPkce(challenge, verifier)).not.toThrow();
  });

  it("THROWS on a wrong verifier", () => {
    expect(() => verifyPkce(challenge, "b".repeat(64))).toThrow(OAuthError);
  });

  it("THROWS on an ABSENT verifier — there is no skip-PKCE branch", () => {
    // The classic hole: treating a missing verifier as "this client doesn't do
    // PKCE" and passing. Every code this AS issues is challenge-bound, so a
    // missing verifier can only ever be an attack or a broken client.
    expect(() => verifyPkce(challenge, undefined)).toThrow(OAuthError);
    expect(() => verifyPkce(challenge, null)).toThrow(OAuthError);
    expect(() => verifyPkce(challenge, "")).toThrow(OAuthError);
  });

  it("THROWS on a malformed verifier (RFC 7636 §4.1 charset/length)", () => {
    expect(() => verifyPkce(challenge, "too-short")).toThrow(OAuthError);
    expect(() => verifyPkce(challenge, "a".repeat(200))).toThrow(OAuthError);
    // '+' is outside the unreserved set
    expect(() => verifyPkce(challenge, `${"a".repeat(63)}+`)).toThrow(
      OAuthError
    );
  });

  it("computes the RFC 7636 S256 transform (base64url, unpadded, 43 chars)", () => {
    expect(challenge).toMatch(/^[A-Za-z0-9\-_]{43}$/);
  });
});

describe("assertPkceChallenge", () => {
  const challenge = computeS256Challenge("a".repeat(64));

  it("accepts a well-formed S256 challenge", () => {
    expect(assertPkceChallenge(challenge, "S256")).toBe(challenge);
  });

  it("rejects an absent challenge — PKCE is mandatory", () => {
    expect(() => assertPkceChallenge(undefined, "S256")).toThrow(OAuthError);
  });

  it("rejects `plain` and an ABSENT method (which defaults to plain per RFC 7636 §4.3)", () => {
    expect(() => assertPkceChallenge(challenge, "plain")).toThrow(OAuthError);
    expect(() => assertPkceChallenge(challenge, undefined)).toThrow(OAuthError);
  });

  it("rejects a malformed challenge", () => {
    expect(() => assertPkceChallenge("short", "S256")).toThrow(OAuthError);
  });
});

// ─── redirect_uri ────────────────────────────────────────────────────────────

describe("isRegisteredRedirectUri", () => {
  const registered = ["https://claude.ai/api/mcp/auth_callback"];

  it("matches byte-for-byte", () => {
    expect(
      isRegisteredRedirectUri(
        registered,
        "https://claude.ai/api/mcp/auth_callback"
      )
    ).toBe(true);
  });

  it("is NOT a prefix or origin match", () => {
    // Each of these is a real-world code-exfiltration shape that a prefix or
    // origin comparison would wave through.
    expect(
      isRegisteredRedirectUri(
        registered,
        "https://claude.ai/api/mcp/auth_callback/../evil"
      )
    ).toBe(false);
    expect(
      isRegisteredRedirectUri(
        registered,
        "https://claude.ai.attacker.tld/api/mcp/auth_callback"
      )
    ).toBe(false);
    expect(
      isRegisteredRedirectUri(
        registered,
        "https://claude.ai/api/mcp/auth_callback?x=1"
      )
    ).toBe(false);
  });
});

// ─── Scopes ──────────────────────────────────────────────────────────────────

describe("scope handling", () => {
  it("parses the space-delimited RFC 6749 §3.3 form", () => {
    expect(parseScopeParam("mcp.read  mcp.write")).toEqual([
      "mcp.read",
      "mcp.write",
    ]);
    expect(parseScopeParam(undefined)).toEqual([]);
  });

  it("narrows to the intersection with what the client registered", () => {
    expect(narrowScopes(SCOPES, ["mcp.read"])).toEqual(["mcp.read"]);
  });

  it("never widens beyond the registered set", () => {
    expect(narrowScopes(["mcp.read"], ["mcp.read", "mcp.write"])).toEqual([
      "mcp.read",
    ]);
  });

  it("falls back to the registered set when nothing was requested", () => {
    expect(narrowScopes(SCOPES, [])).toEqual([...SCOPES]);
  });
});

// ─── Dynamic client registration ─────────────────────────────────────────────

describe("validateDcrRequest", () => {
  const ok = {
    redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
    client_name: "Claude",
    token_endpoint_auth_method: "none",
  };

  it("accepts a well-formed public-client registration", () => {
    const md = validateDcrRequest(ok, SCOPES, SCOPES);
    expect(md.clientName).toBe("Claude");
    expect(md.redirectUris).toEqual([
      "https://claude.ai/api/mcp/auth_callback",
    ]);
    expect(md.scopes).toEqual([...SCOPES]);
  });

  it("requires a non-empty redirect_uris array", () => {
    expect(() => validateDcrRequest({}, SCOPES, SCOPES)).toThrow(DcrError);
    expect(() =>
      validateDcrRequest({ redirect_uris: [] }, SCOPES, SCOPES)
    ).toThrow(DcrError);
  });

  it("rejects non-https redirect_uris (no http, no custom scheme)", () => {
    for (const uri of [
      "http://claude.ai/cb",
      "http://127.0.0.1:8080/cb",
      "myapp://cb",
      "not-a-uri",
    ]) {
      expect(() =>
        validateDcrRequest({ ...ok, redirect_uris: [uri] }, SCOPES, SCOPES)
      ).toThrow(DcrError);
    }
  });

  it("rejects a confidential auth method — the pod issues no client_secret", () => {
    expect(() =>
      validateDcrRequest(
        { ...ok, token_endpoint_auth_method: "client_secret_basic" },
        SCOPES,
        SCOPES
      )
    ).toThrow(DcrError);
  });

  it("tolerates refresh_token in the request but never echoes it back", () => {
    // claude.ai always asks for it; the AS implements authorization_code only.
    const md = validateDcrRequest(
      { ...ok, grant_types: ["authorization_code", "refresh_token"] },
      SCOPES,
      SCOPES
    );
    const res = buildDcrResponse("dcr_x", md, new Date());
    expect(res.grant_types).toEqual(["authorization_code"]);
    expect(res.token_endpoint_auth_method).toBe("none");
    expect(res).not.toHaveProperty("client_secret");
  });

  it("drops unsupported scopes rather than failing the whole registration", () => {
    const md = validateDcrRequest(
      { ...ok, scope: "mcp.read offline_access" },
      SCOPES,
      SCOPES
    );
    expect(md.scopes).toEqual(["mcp.read"]);
  });

  it("caps the number of redirect_uris", () => {
    expect(() =>
      validateDcrRequest(
        { ...ok, redirect_uris: Array(20).fill("https://claude.ai/cb") },
        SCOPES,
        SCOPES
      )
    ).toThrow(DcrError);
  });
});
