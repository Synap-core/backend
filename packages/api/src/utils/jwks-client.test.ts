import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getByUrl: vi.fn(),
  httpsRequest: vi.fn(),
  resolvePublicIssuerEndpoint: vi.fn(),
}));

vi.mock("@synap/database", () => ({
  TrustedIssuerService: class {
    getByUrl = mocks.getByUrl;
  },
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

import {
  clearJtiCache,
  clearJwksCache,
  verifyCpJwt,
  verifyIssuerJwt,
  verifyTrustedIssuerJwt,
} from "./jwks-client.js";

const originalControlPlaneUrl = process.env.CONTROL_PLANE_URL;
const issuerUrl = "https://issuer.example.test";
const podUrl = "https://pod.example.test";

function restoreControlPlaneUrl() {
  if (originalControlPlaneUrl === undefined) {
    delete process.env.CONTROL_PLANE_URL;
  } else {
    process.env.CONTROL_PLANE_URL = originalControlPlaneUrl;
  }
}

function installJwksResponse(publicJwk: JsonWebKey) {
  mocks.httpsRequest.mockImplementation(((
    _options: Record<string, unknown>,
    callback: (response: unknown) => void
  ) => {
    let onData: ((chunk: Buffer) => void) | undefined;
    const response = {
      statusCode: 200,
      destroy: vi.fn(),
      resume: vi.fn(),
      on: vi.fn((event: string, listener: (chunk: Buffer) => void) => {
        if (event === "data") {
          onData = listener;
        }
        return response;
      }),
      once: vi.fn((event: string, listener: () => void) => {
        if (event === "end") {
          queueMicrotask(() => {
            onData?.(
              Buffer.from(
                JSON.stringify({
                  keys: [{ ...publicJwk, alg: "ES256", kid: "issuer-key" }],
                })
              )
            );
            listener();
          });
        }
        return response;
      }),
    };

    callback(response);
    return {
      destroy: vi.fn(),
      end: vi.fn(),
      once: vi.fn(),
    };
  }) as never);
}

describe("trusted issuer JWT verification", () => {
  beforeEach(() => {
    clearJwksCache();
    clearJtiCache();
    mocks.getByUrl.mockReset();
    mocks.httpsRequest.mockReset();
    mocks.resolvePublicIssuerEndpoint.mockReset().mockResolvedValue({
      issuerUrl,
      hostname: "issuer.example.test",
      hostHeader: "issuer.example.test",
      address: "93.184.216.34",
      family: 4,
      port: 443,
      jwksPath: "/.well-known/jwks.json",
    });
  });

  afterEach(() => {
    clearJwksCache();
    clearJtiCache();
    restoreControlPlaneUrl();
  });

  it("uses a registry-approved token issuer instead of CONTROL_PLANE_URL", async () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
    });
    const publicJwk = publicKey.export({ format: "jwk" });
    installJwksResponse(publicJwk);
    process.env.CONTROL_PLANE_URL = "https://wrong.example.test";
    mocks.getByUrl.mockResolvedValue({
      status: "approved",
      allowedScopes: ["auth:exchange-user"],
    });

    const token = jwt.sign(
      {
        iss: issuerUrl,
        sub: "external-user-1",
        aud: podUrl,
        jti: crypto.randomUUID(),
      },
      privateKey,
      { algorithm: "ES256", expiresIn: "5m", keyid: "issuer-key" }
    );

    const result = await verifyTrustedIssuerJwt<{ sub: string }>(token, {
      audience: podUrl,
      requiredScope: "auth:exchange-user",
    });

    expect(result).toMatchObject({ sub: "external-user-1" });
    expect(mocks.getByUrl).toHaveBeenCalledWith(issuerUrl);
    expect(mocks.resolvePublicIssuerEndpoint).toHaveBeenCalledWith(issuerUrl);
    expect(mocks.httpsRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        hostname: "93.184.216.34",
        servername: "issuer.example.test",
        path: "/.well-known/jwks.json",
      }),
      expect.any(Function)
    );
  });

  it("does not fetch a JWKS before the issuer is approved by this Pod", async () => {
    mocks.getByUrl.mockResolvedValue(null);
    const token = jwt.sign(
      {
        iss: "https://untrusted.example.test",
        sub: "external-user-1",
        aud: podUrl,
        jti: crypto.randomUUID(),
      },
      "test-secret"
    );

    const result = await verifyTrustedIssuerJwt(token, { audience: podUrl });

    expect(result).toBeNull();
    expect(mocks.getByUrl).toHaveBeenCalledWith(
      "https://untrusted.example.test"
    );
    expect(mocks.resolvePublicIssuerEndpoint).not.toHaveBeenCalled();
    expect(mocks.httpsRequest).not.toHaveBeenCalled();
  });

  it("rejects a non-canonical issuer claim before a registry or network lookup", async () => {
    const token = jwt.sign(
      {
        iss: `${issuerUrl}/`,
        sub: "external-user-1",
        aud: podUrl,
        jti: crypto.randomUUID(),
      },
      "test-secret"
    );

    const result = await verifyTrustedIssuerJwt(token, { audience: podUrl });

    expect(result).toBeNull();
    expect(mocks.getByUrl).not.toHaveBeenCalled();
    expect(mocks.resolvePublicIssuerEndpoint).not.toHaveBeenCalled();
    expect(mocks.httpsRequest).not.toHaveBeenCalled();
  });

  it("requires an audience before consulting the registry or network", async () => {
    const token = jwt.sign(
      {
        iss: issuerUrl,
        sub: "external-user-1",
        jti: crypto.randomUUID(),
      },
      "test-secret"
    );

    const result = await verifyTrustedIssuerJwt(token, { audience: "" });

    expect(result).toBeNull();
    expect(mocks.getByUrl).not.toHaveBeenCalled();
    expect(mocks.resolvePublicIssuerEndpoint).not.toHaveBeenCalled();
    expect(mocks.httpsRequest).not.toHaveBeenCalled();
  });

  it("scopes the local JTI replay cache to the issuer", async () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
    });
    const publicJwk = publicKey.export({ format: "jwk" });
    const secondIssuerUrl = "https://second-issuer.example.test";
    installJwksResponse(publicJwk);
    mocks.getByUrl.mockResolvedValue({
      status: "approved",
      allowedScopes: ["auth:exchange-user"],
    });
    mocks.resolvePublicIssuerEndpoint.mockImplementation(
      async (value: string) => {
        const hostname = new URL(value).hostname;
        return {
          issuerUrl: value,
          hostname,
          hostHeader: hostname,
          address: "93.184.216.34",
          family: 4,
          port: 443,
          jwksPath: "/.well-known/jwks.json",
        };
      }
    );

    const jti = "shared-across-issuers";
    const makeToken = (iss: string) =>
      jwt.sign({ iss, sub: "external-user-1", aud: podUrl, jti }, privateKey, {
        algorithm: "ES256",
        expiresIn: "5m",
        keyid: "issuer-key",
      });

    await expect(
      verifyTrustedIssuerJwt(makeToken(issuerUrl), {
        audience: podUrl,
        requiredScope: "auth:exchange-user",
      })
    ).resolves.not.toBeNull();
    await expect(
      verifyTrustedIssuerJwt(makeToken(secondIssuerUrl), {
        audience: podUrl,
        requiredScope: "auth:exchange-user",
      })
    ).resolves.not.toBeNull();
  });

  it("leaves durable-receipt assertions retriable until their route persists the receipt", async () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
    });
    installJwksResponse(publicKey.export({ format: "jwk" }));
    mocks.getByUrl.mockResolvedValue({
      status: "approved",
      allowedScopes: ["auth:exchange-user"],
    });
    const token = jwt.sign(
      {
        iss: issuerUrl,
        sub: "external-user-1",
        aud: podUrl,
        jti: crypto.randomUUID(),
      },
      privateKey,
      { algorithm: "ES256", expiresIn: "5m", keyid: "issuer-key" }
    );

    const options = {
      audience: podUrl,
      requiredScope: "auth:exchange-user",
      consumeJti: false,
    };
    await expect(
      verifyTrustedIssuerJwt(token, options)
    ).resolves.not.toBeNull();
    await expect(
      verifyTrustedIssuerJwt(token, options)
    ).resolves.not.toBeNull();
  });

  it("keeps the old CP verifier name as a source-compatible alias", () => {
    expect(verifyCpJwt).toBe(verifyIssuerJwt);
  });
});
