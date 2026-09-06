import { describe, it, expect } from "vitest";
import { validateExternalUrl } from "./validate-url.js";

/**
 * IPv6 literals must actually be blocked.
 *
 * `new URL("http://[::1]/").hostname` is `"[::1]"` — WITH brackets. Every IPv6
 * rule in `BLOCKED_RANGES` is `^`-anchored on a bare address, so before the
 * hostname was unbracketed those four rules could never match: loopback,
 * unique-local and link-local IPv6 all passed the SSRF guard cleanly while the
 * file read as though they were covered.
 *
 * Found 2026-09-06 by an adversarial review that measured the hostname instead
 * of reading the regex. The IPv4 equivalents were always fine, which is exactly
 * why this survived: the guard looked symmetric.
 */
describe("validateExternalUrl — IPv6 literals are bracketed", () => {
  for (const url of [
    "http://[::1]/",
    "http://[fc00::1]/",
    "http://[fd12:3456::1]/",
    "http://[fe80::1]/",
  ]) {
    it(`blocks ${url}`, () => {
      const res = validateExternalUrl(url);
      expect(res.valid, `${url} reached the network`).toBe(false);
    });
  }

  it("still allows a legitimate public host", () => {
    expect(validateExternalUrl("https://api.vendor.com/v1").valid).toBe(true);
  });

  it("blocks the IPv4 loopback and cloud metadata (unchanged)", () => {
    expect(validateExternalUrl("http://127.0.0.1/").valid).toBe(false);
    expect(validateExternalUrl("http://169.254.169.254/").valid).toBe(false);
  });
});
