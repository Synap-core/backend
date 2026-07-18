import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  httpsRequest: vi.fn(),
  resolvePublicIssuerEndpoint: vi.fn(),
}));

vi.mock("node:https", () => ({
  request: mocks.httpsRequest,
}));

vi.mock("./issuer-url-safety.js", () => ({
  normalizeIssuerUrl: (value: string) => {
    try {
      const parsed = new URL(value);
      if (
        parsed.protocol !== "https:" ||
        parsed.username ||
        parsed.password ||
        parsed.search ||
        parsed.hash
      ) {
        return null;
      }
      return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
    } catch {
      return null;
    }
  },
  resolvePublicIssuerEndpoint: mocks.resolvePublicIssuerEndpoint,
}));

import { fetchFederationMetadata } from "./federation-metadata-client.js";

const controlPlaneUrl = "https://cp.example.test";

function installResponse(statusCode: number, bodyText: string) {
  mocks.httpsRequest.mockImplementation(((
    _options: Record<string, unknown>,
    callback: (response: unknown) => void
  ) => {
    let onData: ((chunk: Buffer) => void) | undefined;
    const response = {
      statusCode,
      destroy: vi.fn(),
      resume: vi.fn(),
      on: vi.fn((event: string, listener: (chunk: Buffer) => void) => {
        if (event === "data") onData = listener;
        return response;
      }),
      once: vi.fn((event: string, listener: () => void) => {
        if (event === "end") {
          queueMicrotask(() => {
            onData?.(Buffer.from(bodyText));
            listener();
          });
        }
        return response;
      }),
    };
    callback(response);
    return { destroy: vi.fn(), end: vi.fn(), once: vi.fn() };
  }) as never);
}

describe("fetchFederationMetadata", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolvePublicIssuerEndpoint.mockResolvedValue({
      issuerUrl: "https://cp.example.test",
      hostname: "cp.example.test",
      hostHeader: "cp.example.test",
      address: "203.0.113.10",
      family: 4,
      port: 443,
      jwksPath: "/.well-known/jwks.json",
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns the DECLARED issuer + scopes when the CP differs from transport", async () => {
    // Transport is cp.example.test; the CP declares a DIFFERENT signing issuer.
    installResponse(
      200,
      JSON.stringify({
        issuer: "https://api.synap.live",
        jwks_uri: "https://api.synap.live/.well-known/jwks.json",
        scopes: ["auth:exchange-user", "identity:link-user"],
      })
    );

    const md = await fetchFederationMetadata(controlPlaneUrl);
    expect(md.issuer).toBe("https://api.synap.live");
    expect(md.jwksUri).toBe("https://api.synap.live/.well-known/jwks.json");
    expect(md.scopes).toEqual(["auth:exchange-user", "identity:link-user"]);
  });

  it("throws on a non-2xx response (caller falls back)", async () => {
    installResponse(404, "not found");
    await expect(fetchFederationMetadata(controlPlaneUrl)).rejects.toThrow(
      /federation metadata fetch failed: 404/i
    );
  });

  it("throws on a non-canonical declared issuer", async () => {
    installResponse(
      200,
      JSON.stringify({ issuer: "http://insecure.example", scopes: ["x"] })
    );
    await expect(fetchFederationMetadata(controlPlaneUrl)).rejects.toThrow(
      /non-canonical issuer/i
    );
  });

  it("throws on missing/empty scopes", async () => {
    installResponse(
      200,
      JSON.stringify({ issuer: "https://api.synap.live", scopes: [] })
    );
    await expect(fetchFederationMetadata(controlPlaneUrl)).rejects.toThrow(
      /invalid scopes/i
    );
  });
});
