import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getByUrl: vi.fn(),
  consumeReceipt: vi.fn(),
  httpsRequest: vi.fn(),
  resolvePublicIssuerEndpoint: vi.fn(),
}));

vi.mock("@synap/database", () => ({
  TrustedIssuerService: class {
    getByUrl = mocks.getByUrl;
  },
  consumeFederatedAssertionReceipt: mocks.consumeReceipt,
  TRUSTED_ISSUER_CAPABILITIES: {
    USER_EXCHANGE: "auth:exchange-user",
    IDENTITY_LINK: "identity:link-user",
    MEMBERSHIP_GRANT: "membership:grant",
    SOURCE_CONFIG_WRITE: "source-config:write",
  },
  CONTROL_PLANE_ISSUER_SCOPES: [
    "auth:exchange-user",
    "identity:link-user",
    "membership:grant",
    "source-config:write",
  ],
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
  controlPlaneIssuerScopes,
  verifyIssuerJwt,
  verifyTrustedIssuerJwt,
} from "./jwks-client.js";

const originalControlPlaneUrl = process.env.CONTROL_PLANE_URL;
const issuerUrl = "https://issuer.example.test";
const podUrl = "https://pod.example.test";

type JwkWithMetadata = JsonWebKey & {
  kid?: string;
  alg?: string;
  use?: string;
};

function restoreControlPlaneUrl() {
  if (originalControlPlaneUrl === undefined) {
    delete process.env.CONTROL_PLANE_URL;
  } else {
    process.env.CONTROL_PLANE_URL = originalControlPlaneUrl;
  }
}

function installJwksResponse(publicJwk: JwkWithMetadata | JwkWithMetadata[]) {
  const inputKeys = Array.isArray(publicJwk) ? publicJwk : [publicJwk];
  const keys = inputKeys.map((key, index) => ({
    ...key,
    alg: "ES256",
    kid:
      key.kid ??
      (inputKeys.length === 1 ? "issuer-key" : `issuer-key-${index}`),
  }));
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
                  keys,
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
    mocks.consumeReceipt.mockReset().mockResolvedValue("consumed");
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

  it("selects the exact JWT kid when an issuer publishes rotating ES256 keys", async () => {
    const first = crypto.generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
    });
    const second = crypto.generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
    });
    installJwksResponse([
      { ...first.publicKey.export({ format: "jwk" }), kid: "old-key" },
      { ...second.publicKey.export({ format: "jwk" }), kid: "new-key" },
    ]);
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
      second.privateKey,
      { algorithm: "ES256", expiresIn: "5m", keyid: "new-key" }
    );

    await expect(
      verifyTrustedIssuerJwt(token, {
        audience: podUrl,
        requiredScope: "auth:exchange-user",
      })
    ).resolves.toMatchObject({ sub: "external-user-1" });
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
});

// ─────────────────────────────────────────────────────────────────────────────
// SECURITY-KEYS-2026-10-13 C2/C3: the ONE door binds issuer + audience +
// purpose + durable single use.
// ─────────────────────────────────────────────────────────────────────────────
describe("issuer→pod token door (aud, purpose, durable jti)", () => {
  const CP_ENTRY = {
    id: "00000000-0000-4000-8000-0000000000cp",
    status: "approved",
    allowedScopes: [
      "auth:exchange-user",
      "identity:link-user",
      "membership:grant",
      "source-config:write",
    ],
  };
  let keys: ReturnType<typeof crypto.generateKeyPairSync>;

  function sign(
    claims: Record<string, unknown>,
    expiresIn: string | null = "5m"
  ) {
    return jwt.sign(
      { iss: issuerUrl, jti: crypto.randomUUID(), ...claims },
      keys.privateKey,
      {
        algorithm: "ES256",
        keyid: "issuer-key",
        ...(expiresIn ? { expiresIn } : {}),
      } as jwt.SignOptions
    );
  }

  beforeEach(() => {
    clearJwksCache();
    clearJtiCache();
    keys = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    mocks.getByUrl.mockReset().mockResolvedValue(CP_ENTRY);
    mocks.httpsRequest.mockReset();
    mocks.consumeReceipt.mockReset().mockResolvedValue("consumed");
    mocks.resolvePublicIssuerEndpoint.mockReset().mockResolvedValue({
      issuerUrl,
      hostname: "issuer.example.test",
      hostHeader: "issuer.example.test",
      address: "93.184.216.34",
      family: 4,
      port: 443,
      jwksPath: "/.well-known/jwks.json",
    });
    installJwksResponse(keys.publicKey.export({ format: "jwk" }));
  });

  const opts = () => ({
    audience: podUrl,
    requiredScope: controlPlaneIssuerScopes(),
    expectedType: "sync-setup",
  });

  it("accepts a CP token for this pod and consumes its jti DURABLY under the registry entry", async () => {
    const token = sign({ type: "sync-setup", aud: podUrl });
    const jti = (jwt.decode(token) as { jti: string; exp: number }).jti;

    await expect(verifyTrustedIssuerJwt(token, opts())).resolves.toMatchObject({
      type: "sync-setup",
    });
    expect(mocks.consumeReceipt).toHaveBeenCalledTimes(1);
    expect(mocks.consumeReceipt).toHaveBeenCalledWith({
      issuerId: CP_ENTRY.id,
      jti,
      expiresAt: expect.any(Date),
    });
  });

  it("refuses a replay the durable receipt has already seen (survives restarts)", async () => {
    mocks.consumeReceipt.mockResolvedValue("replayed");
    const token = sign({ type: "sync-setup", aud: podUrl });
    await expect(verifyTrustedIssuerJwt(token, opts())).resolves.toBeNull();
  });

  it("fails closed when the receipt store is down", async () => {
    mocks.consumeReceipt.mockRejectedValue(new Error("db down"));
    const token = sign({ type: "sync-setup", aud: podUrl });
    await expect(verifyTrustedIssuerJwt(token, opts())).resolves.toBeNull();
  });

  it("refuses a token minted with NO audience (the pre-fix CP shape)", async () => {
    const token = sign({ type: "sync-setup" });
    await expect(verifyTrustedIssuerJwt(token, opts())).resolves.toBeNull();
    expect(mocks.consumeReceipt).not.toHaveBeenCalled();
  });

  it("refuses a token minted for ANOTHER pod (cross-pod replay)", async () => {
    const token = sign({
      type: "sync-setup",
      aud: "https://other-pod.example.test",
    });
    await expect(verifyTrustedIssuerJwt(token, opts())).resolves.toBeNull();
    expect(mocks.consumeReceipt).not.toHaveBeenCalled();
  });

  it("refuses one purpose presented as another, without burning its jti", async () => {
    const token = sign({ type: "oidc-config-push", aud: podUrl });
    await expect(verifyTrustedIssuerJwt(token, opts())).resolves.toBeNull();
    const untyped = sign({ aud: podUrl });
    await expect(verifyTrustedIssuerJwt(untyped, opts())).resolves.toBeNull();
    expect(mocks.consumeReceipt).not.toHaveBeenCalled();
  });

  it("accepts any type of an expected set", async () => {
    const token = sign({ type: "addon_activate", aud: podUrl });
    await expect(
      verifyTrustedIssuerJwt(token, {
        ...opts(),
        expectedType: ["agent_setup", "addon_activate"],
      })
    ).resolves.not.toBeNull();
  });

  it("requires EVERY scope of an array — an app-connection issuer (no issuer-wide scope) is not the CP", async () => {
    mocks.getByUrl.mockResolvedValue({ ...CP_ENTRY, allowedScopes: [] });
    const token = sign({ type: "sync-setup", aud: podUrl });
    await expect(verifyTrustedIssuerJwt(token, opts())).resolves.toBeNull();
    mocks.getByUrl.mockResolvedValue({
      ...CP_ENTRY,
      allowedScopes: ["auth:exchange-user", "identity:link-user"],
    });
    const token2 = sign({ type: "sync-setup", aud: podUrl });
    await expect(verifyTrustedIssuerJwt(token2, opts())).resolves.toBeNull();
    expect(mocks.httpsRequest).not.toHaveBeenCalled();
  });

  it("refuses a token with no exp when it must be single-use", async () => {
    const token = sign({ type: "sync-setup", aud: podUrl }, null);
    await expect(verifyTrustedIssuerJwt(token, opts())).resolves.toBeNull();
    expect(mocks.consumeReceipt).not.toHaveBeenCalled();
  });

  it("the low-level verifier refuses a missing audience or issuer before any fetch", async () => {
    const token = sign({ type: "sync-setup", aud: podUrl });
    await expect(verifyIssuerJwt(token, issuerUrl, "")).resolves.toBeNull();
    await expect(verifyIssuerJwt(token, "", podUrl)).resolves.toBeNull();
    expect(mocks.httpsRequest).not.toHaveBeenCalled();
  });
});
