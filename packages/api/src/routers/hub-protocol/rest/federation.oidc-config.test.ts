/**
 * POST /federation/oidc-config — SECURITY-KEYS-2026-10-13 C2.
 *
 * Before the fix the route verified the push with the bare verifier and NO
 * pinned issuer: the token's own unverified `iss` chose the JWKS host, so any
 * HTTPS host could sign an `oidc-config-push` for itself and repoint this
 * pod's Kratos "cp" sign-in provider at itself.
 *
 * This drives the SEAM: the REAL `jwks-client` door (signature, registry,
 * scopes, audience, purpose, durable jti) behind the REAL route. Only the
 * network (JWKS fetch), the registry row, the receipt store and the
 * pod_settings write are faked.
 */
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const CP = "https://api.cp.example.test";
const POD = "https://pod.example.test";

const m = vi.hoisted(() => ({
  getByUrl: vi.fn(),
  consumeReceipt: vi.fn(),
  httpsRequest: vi.fn(),
  resolve: vi.fn(),
  update: vi.fn(),
  insert: vi.fn(),
}));

vi.mock("@synap/database", () => ({
  TrustedIssuerService: class {
    getByUrl = m.getByUrl;
  },
  consumeFederatedAssertionReceipt: m.consumeReceipt,
  TRUSTED_ISSUER_CAPABILITIES: {
    USER_EXCHANGE: "auth:exchange-user",
    IDENTITY_LINK: "identity:link-user",
    MEMBERSHIP_GRANT: "membership:grant",
    SOURCE_CONFIG_WRITE: "source-config:write",
  },
  db: {
    select: () => ({
      from: () => ({
        orderBy: () => ({ limit: () => Promise.resolve([{ id: "ps-1" }]) }),
      }),
    }),
    update: (...a: unknown[]) => {
      m.update(...a);
      return {
        set: (v: unknown) => {
          m.update(v);
          return { where: () => Promise.resolve() };
        },
      };
    },
    insert: (...a: unknown[]) => {
      m.insert(...a);
      return { values: () => Promise.resolve() };
    },
  },
  podSettings: { id: "id", settings: "settings", createdAt: "created_at" },
  drizzleSql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
    strings,
    values,
  }),
  eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
}));

vi.mock("node:https", () => ({ request: m.httpsRequest }));

vi.mock("../../../utils/issuer-url-safety.js", () => ({
  normalizeIssuerUrl: (value: string) => {
    try {
      const u = new URL(value);
      if (u.protocol !== "https:") return null;
      return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
    } catch {
      return null;
    }
  },
  resolvePublicIssuerEndpoint: m.resolve,
}));

vi.mock("./_shared.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  httpStatusForTrpcError: () => 500,
}));
vi.mock("./_codecs/_register.js", () => ({ registerOpenApi: () => {} }));

import { registerFederationRoutes } from "./federation.js";
import { clearJwksCache } from "../../../utils/jwks-client.js";

const CP_ENTRY = {
  id: "00000000-0000-4000-8000-00000000c0de",
  issuerUrl: CP,
  status: "approved",
  allowedScopes: [
    "auth:exchange-user",
    "identity:link-user",
    "membership:grant",
    "source-config:write",
  ],
};

let keys: ReturnType<typeof crypto.generateKeyPairSync>;

function serveJwks() {
  const jwk = {
    ...keys.publicKey.export({ format: "jwk" }),
    kid: "cp-key",
    alg: "ES256",
  };
  m.httpsRequest.mockImplementation(((
    _o: unknown,
    cb: (r: unknown) => void
  ) => {
    let onData: ((c: Buffer) => void) | undefined;
    const res = {
      statusCode: 200,
      destroy: vi.fn(),
      resume: vi.fn(),
      on: vi.fn((e: string, l: (c: Buffer) => void) => {
        if (e === "data") onData = l;
        return res;
      }),
      once: vi.fn((e: string, l: () => void) => {
        if (e === "end") {
          queueMicrotask(() => {
            onData?.(Buffer.from(JSON.stringify({ keys: [jwk] })));
            l();
          });
        }
        return res;
      }),
    };
    cb(res);
    return { destroy: vi.fn(), end: vi.fn(), once: vi.fn() };
  }) as never);
}

/** The assertion as the FIXED CP signs it (`aud: podOrigin` added). */
function assertion(over: Record<string, unknown> = {}, iss = CP) {
  return jwt.sign(
    {
      iss,
      jti: crypto.randomUUID(),
      type: "oidc-config-push",
      aud: POD,
      podOrigin: POD,
      clientId: "pod:pod.example.test",
      clientSecret: "test-secret-client",
      issuer: CP,
      redirectUri: `${POD}/self-service/methods/oidc/callback/cp`,
      ...over,
    },
    keys.privateKey,
    { algorithm: "ES256", expiresIn: "5m", keyid: "cp-key" }
  );
}

function app() {
  const a = new Hono();
  registerFederationRoutes(a as never);
  return a;
}

async function push(token: string) {
  return app().request("/federation/oidc-config", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ assertion: token }),
  });
}

const originalPublicUrl = process.env.PUBLIC_URL;

describe("POST /federation/oidc-config — one issuer door (C2)", () => {
  beforeEach(() => {
    process.env.PUBLIC_URL = POD;
    clearJwksCache();
    keys = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    m.httpsRequest.mockReset();
    serveJwks();
    m.getByUrl
      .mockReset()
      .mockImplementation(async (url: string) =>
        url === CP ? CP_ENTRY : null
      );
    m.consumeReceipt.mockReset().mockResolvedValue("consumed");
    m.update.mockReset();
    m.insert.mockReset();
    m.resolve.mockReset().mockImplementation(async (issuerUrl: string) => {
      const host = new URL(issuerUrl).hostname;
      return {
        issuerUrl,
        hostname: host,
        hostHeader: host,
        address: "93.184.216.34",
        family: 4,
        port: 443,
        jwksPath: "/.well-known/jwks.json",
      };
    });
  });
  afterEach(() => {
    if (originalPublicUrl === undefined) delete process.env.PUBLIC_URL;
    else process.env.PUBLIC_URL = originalPublicUrl;
  });

  it("stores the client pushed by the approved Control Plane for THIS pod", async () => {
    const res = await push(assertion());
    expect(res.status).toBe(200);
    expect(m.update).toHaveBeenCalled();
    expect(m.consumeReceipt).toHaveBeenCalledWith(
      expect.objectContaining({ issuerId: CP_ENTRY.id })
    );
  });

  it("refuses a push signed by a host this pod never approved — no JWKS fetch, no write", async () => {
    const res = await push(
      assertion(
        { issuer: "https://evil.example.test" },
        "https://evil.example.test"
      )
    );
    expect(res.status).toBe(401);
    expect(m.httpsRequest).not.toHaveBeenCalled();
    expect(m.update).not.toHaveBeenCalled();
    expect(m.insert).not.toHaveBeenCalled();
  });

  it("refuses an approved issuer that is not this pod's Control Plane (no CP scopes)", async () => {
    m.getByUrl.mockResolvedValue({ ...CP_ENTRY, allowedScopes: [] });
    const res = await push(assertion());
    expect(res.status).toBe(401);
    expect(m.update).not.toHaveBeenCalled();
  });

  it("refuses a push with no audience (the pre-fix CP shape) and one minted for another pod", async () => {
    expect((await push(assertion({ aud: undefined }))).status).toBe(401);
    expect(
      (await push(assertion({ aud: "https://other.example.test" }))).status
    ).toBe(401);
    expect(m.update).not.toHaveBeenCalled();
  });

  it("refuses a push whose OIDC issuer is not its signer", async () => {
    const res = await push(assertion({ issuer: "https://evil.example.test" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "OIDC_ISSUER_MISMATCH" });
    expect(m.update).not.toHaveBeenCalled();
  });

  it("refuses another CP purpose replayed here, without consuming its jti", async () => {
    const res = await push(assertion({ type: "sync-setup" }));
    expect(res.status).toBe(401);
    expect(m.consumeReceipt).not.toHaveBeenCalled();
    expect(m.update).not.toHaveBeenCalled();
  });

  it("refuses a replayed push (durable receipt)", async () => {
    m.consumeReceipt.mockResolvedValue("replayed");
    expect((await push(assertion())).status).toBe(401);
    expect(m.update).not.toHaveBeenCalled();
  });

  it("fails closed when the pod does not know its own URL", async () => {
    delete process.env.PUBLIC_URL;
    const res = await push(assertion());
    expect(res.status).toBe(500);
    expect(m.update).not.toHaveBeenCalled();
  });
});
