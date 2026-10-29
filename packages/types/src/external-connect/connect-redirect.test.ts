/**
 * Where /connect may deliver a freshly minted key (pre-launch audit
 * 2026-10-28, F3). The old rule was `uri.startsWith(prefix)`, so
 * `http://localhost:@attacker.example/` (userinfo `localhost:`, host
 * attacker.example) received a full-access key. These cases pin the parsed rule.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONNECT_REDIRECT_PREFIXES,
  isAllowedConnectRedirectUri,
} from "./index";

describe("isAllowedConnectRedirectUri", () => {
  it.each([
    "http://localhost:@attacker.example/cb",
    "http://127.0.0.1:@attacker.example/cb",
    "http://127.0.0.1:80@attacker.example/",
    "http://user:pass@127.0.0.1:5000/cb",
    "http://localhost.attacker.example:8080/cb",
    "http://127.0.0.1.attacker.example/cb",
    "https://127.0.0.1:5000/cb",
    "https://attacker.example/cb",
    "raycast://extensions/someone-else/ext/cb",
    "javascript:alert(1)",
    "not a url",
    "",
  ])("refuses %s", (uri) => {
    expect(isAllowedConnectRedirectUri(uri)).toBe(false);
  });

  it.each([
    "http://127.0.0.1:53123/callback",
    "http://localhost:53123/callback",
    "http://[::1]:53123/callback",
    "raycast://extensions/synap-core/synap/connect",
    "synap://connect",
  ])("admits %s", (uri) => {
    expect(isAllowedConnectRedirectUri(uri)).toBe(true);
  });

  it("an extra https prefix admits its own origin only, by host and path", () => {
    const allowed = [
      ...DEFAULT_CONNECT_REDIRECT_PREFIXES,
      "https://cp.example.com/",
    ];
    expect(
      isAllowedConnectRedirectUri(
        "https://cp.example.com/pods/1/connect-mcp/callback",
        allowed
      )
    ).toBe(true);
    for (const uri of [
      "https://cp.example.com@attacker.example/cb",
      "https://cp.example.com.attacker.example/cb",
      "https://cp.example.com:8443/cb",
      "http://cp.example.com/cb",
    ]) {
      expect(isAllowedConnectRedirectUri(uri, allowed)).toBe(false);
    }
  });
});
