import { describe, expect, it, vi } from "vitest";
import {
  isPublicInternetAddress,
  normalizeIssuerUrl,
  resolvePublicIssuerEndpoint,
} from "./issuer-url-safety.js";

describe("issuer URL safety", () => {
  it("uses one canonical HTTPS issuer identifier, including an optional path", () => {
    expect(normalizeIssuerUrl("https://issuer.example.test/tenant/")).toBe(
      "https://issuer.example.test/tenant"
    );
    expect(normalizeIssuerUrl("https://issuer.example.test/")).toBe(
      "https://issuer.example.test"
    );
  });

  it("rejects issuer URL components that cannot be a trust identifier", () => {
    expect(normalizeIssuerUrl("http://issuer.example.test")).toBeNull();
    expect(
      normalizeIssuerUrl("https://user:pass@issuer.example.test")
    ).toBeNull();
    expect(normalizeIssuerUrl("https://issuer.example.test?next=/")).toBeNull();
    expect(
      normalizeIssuerUrl("https://issuer.example.test#fragment")
    ).toBeNull();
  });

  it("rejects loopback literals before DNS resolution", async () => {
    const lookup = vi.fn();

    await expect(
      resolvePublicIssuerEndpoint("https://127.0.0.1", lookup)
    ).rejects.toThrow("non-public IP");

    expect(lookup).not.toHaveBeenCalled();
  });

  it("rejects localhost with no test-only exception", async () => {
    const lookup = vi.fn();

    await expect(
      resolvePublicIssuerEndpoint("https://localhost", lookup)
    ).rejects.toThrow("local hostname");

    expect(lookup).not.toHaveBeenCalled();
  });

  it("rejects private, link-local, and IPv4-mapped IPv6 addresses", () => {
    expect(isPublicInternetAddress("10.0.0.1")).toBe(false);
    expect(isPublicInternetAddress("169.254.169.254")).toBe(false);
    expect(isPublicInternetAddress("::1")).toBe(false);
    expect(isPublicInternetAddress("fe80::1")).toBe(false);
    expect(isPublicInternetAddress("::ffff:127.0.0.1")).toBe(false);
  });

  it("rejects a mixed public/private DNS answer to prevent rebinding", async () => {
    const lookup = vi.fn().mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]);

    await expect(
      resolvePublicIssuerEndpoint("https://issuer.example.test", lookup)
    ).rejects.toThrow("non-public IP");

    expect(lookup).toHaveBeenCalledWith("issuer.example.test");
  });

  it("pins a public DNS result and builds the issuer-relative JWKS path", async () => {
    const lookup = vi
      .fn()
      .mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);

    await expect(
      resolvePublicIssuerEndpoint("https://issuer.example.test/oidc/", lookup)
    ).resolves.toMatchObject({
      hostname: "issuer.example.test",
      hostHeader: "issuer.example.test",
      address: "93.184.216.34",
      family: 4,
      port: 443,
      jwksPath: "/oidc/.well-known/jwks.json",
    });
  });

  it("only accepts public Internet addresses", () => {
    expect(isPublicInternetAddress("93.184.216.34")).toBe(true);
    expect(isPublicInternetAddress("2001:4860:4860::8888")).toBe(true);
    expect(isPublicInternetAddress("192.0.2.1")).toBe(false);
    expect(isPublicInternetAddress("2001:db8::1")).toBe(false);
  });
});
