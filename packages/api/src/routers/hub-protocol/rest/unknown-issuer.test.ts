/**
 * Audit 2026-10-28 F1 — an unregistered issuer can no longer file a pending
 * `trusted_issuers` row (and notify every admin) with an unsigned token.
 *
 * Through the REAL `/setup/agent` and `/setup/service` routes. Mocked: the
 * issuer registry, the admin lookup, the notification door, and the JWKS
 * fetch. The fetch mock still checks a REAL ES256 signature against the key
 * pair below (the key the "issuer publishes"), so an unsigned or wrongly
 * signed token fails for the real reason. The fetch itself (SSRF guard,
 * caching) is covered by `utils/jwks-client.test.ts`.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import { beforeEach, describe, expect, it, vi } from "vitest";

const POD = "https://pod.test";

// The key pair the issuer "publishes" at its JWKS.
const published = generateKeyPairSync("ec", { namedCurve: "P-256" });
const keys = {
  privatePem: published.privateKey.export({ type: "pkcs8", format: "pem" }),
  publicPem: published.publicKey.export({ type: "spki", format: "pem" }),
};

const registry = vi.hoisted(() => ({
  getByUrl: vi.fn(),
  registerPending: vi.fn(),
  list: vi.fn(),
}));
const notify = vi.hoisted(() => vi.fn());
const appendEvent = vi.hoisted(() => vi.fn());
const verifyIssuerJwt = vi.hoisted(() => vi.fn());

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    TrustedIssuerService: class {
      getByUrl = registry.getByUrl;
      registerPending = registry.registerPending;
      list = registry.list;
    },
    eventRepository: { append: appendEvent },
    db: {
      query: {
        workspaces: { findFirst: async () => ({ id: "ws-pod-admin" }) },
        workspaceMembers: {
          findMany: async () => [{ userId: "admin-1" }, { userId: "admin-2" }],
        },
      },
    },
  };
});
vi.mock("../../../notifications/NotificationService.js", () => ({
  NotificationService: { create: notify },
}));
vi.mock("../../../utils/jwks-client.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../utils/jwks-client.js")>();
  return { ...actual, verifyIssuerJwt };
});
vi.mock("../../../services/api-keys.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../services/api-keys.js")>();
  return {
    ...actual,
    apiKeyService: {
      ...actual.apiKeyService,
      validateApiKey: async () => null,
    },
  };
});

const { registerSetupRoutes } = await import("./setup.js");
const { resetUnknownIssuerAttempts, UNKNOWN_ISSUER_ATTEMPTS_PER_SOURCE } =
  await import("./unknown-issuer.js");

function post(path: string, token: string, ip = "203.0.113.7") {
  const app = new OpenAPIHono();
  registerSetupRoutes(app as never);
  return app.request(path, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-forwarded-for": ip,
    },
    body: JSON.stringify({ agentType: "my-agent", name: "svc" }),
  });
}

function claims(iss: string, extra: Record<string, unknown> = {}) {
  return {
    iss,
    aud: POD,
    type: "agent_setup",
    jti: randomUUID(),
    exp: Math.floor(Date.now() / 1000) + 300,
    ...extra,
  };
}

/** Signed with the key the issuer publishes: the only token that may file a row. */
function signed(iss: string, extra: Record<string, unknown> = {}) {
  return jwt.sign(claims(iss, extra), keys.privatePem, {
    algorithm: "ES256",
    keyid: "k1",
  });
}

/** The audit's probe: no signature at all, any `iss`. */
function unsigned(iss: string) {
  const enc = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc({ alg: "ES256", kid: "k1", typ: "JWT" })}.${enc(claims(iss))}.`;
}

/** Well-formed and ES256, signed by a key the issuer does NOT publish. */
function forged(iss: string) {
  const other = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return jwt.sign(claims(iss), other.privateKey, {
    algorithm: "ES256",
    keyid: "k1",
  });
}

let n = 0;
const freshIssuer = () => `https://issuer-${++n}.example`;

beforeEach(() => {
  process.env.PUBLIC_URL = POD;
  resetUnknownIssuerAttempts();
  registry.getByUrl.mockReset().mockResolvedValue(null);
  registry.list.mockReset().mockResolvedValue([]);
  registry.registerPending
    .mockReset()
    .mockImplementation(async (url: string) => ({
      id: `row-${url}`,
      issuerUrl: url,
      status: "pending",
    }));
  notify.mockReset();
  appendEvent.mockReset();
  verifyIssuerJwt
    .mockReset()
    .mockImplementation(async (token: string, iss: string, aud: string) => {
      try {
        return jwt.verify(token, keys.publicPem, {
          algorithms: ["ES256"],
          issuer: iss,
          audience: aud,
        });
      } catch {
        return null;
      }
    });
});

const DOORS = ["/setup/agent", "/setup/service"] as const;

describe.each(DOORS)("%s — an unregistered issuer", (door) => {
  it("an UNSIGNED token files no row, notifies nobody, and is refused 401", async () => {
    const res = await post(door, unsigned(freshIssuer()));
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe(
      "ISSUER_NOT_VERIFIED"
    );
    expect(registry.registerPending).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(appendEvent).not.toHaveBeenCalled();
  });

  it("a token signed by a key the issuer does not publish files no row", async () => {
    const res = await post(door, forged(freshIssuer()));
    expect(res.status).toBe(401);
    expect(verifyIssuerJwt).toHaveBeenCalledTimes(1);
    expect(registry.registerPending).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("a token addressed to ANOTHER pod is refused before any fetch", async () => {
    const res = await post(
      door,
      signed(freshIssuer(), { aud: "https://other-pod.test" })
    );
    expect(res.status).toBe(401);
    expect(verifyIssuerJwt).not.toHaveBeenCalled();
    expect(registry.registerPending).not.toHaveBeenCalled();
  });

  it("a token for another purpose is refused before any fetch", async () => {
    const res = await post(door, signed(freshIssuer(), { type: "mcp-revoke" }));
    expect(res.status).toBe(401);
    expect(verifyIssuerJwt).not.toHaveBeenCalled();
  });

  it("a SIGNED token addressed to this pod files ONE pending row and notifies the admins (positive control)", async () => {
    const iss = freshIssuer();
    const res = await post(door, signed(iss));
    expect(res.status).toBe(202);
    const body = (await res.json()) as { code: string; issuerUrl: string };
    expect(body).toMatchObject({
      code: "ISSUER_PENDING_APPROVAL",
      issuerUrl: iss,
    });
    expect(registry.registerPending).toHaveBeenCalledTimes(1);
    expect(registry.registerPending.mock.calls[0][0]).toBe(iss);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(appendEvent).toHaveBeenCalledTimes(1);
  });

  it("one source is capped; another source is not", async () => {
    for (let i = 0; i < UNKNOWN_ISSUER_ATTEMPTS_PER_SOURCE; i++) {
      expect((await post(door, forged(freshIssuer()))).status).toBe(401);
    }
    const capped = await post(door, signed(freshIssuer()));
    expect(capped.status).toBe(429);
    expect(((await capped.json()) as { code: string }).code).toBe(
      "ISSUER_REQUESTS_LIMITED"
    );
    expect(verifyIssuerJwt).toHaveBeenCalledTimes(
      UNKNOWN_ISSUER_ATTEMPTS_PER_SOURCE
    );
    expect(registry.registerPending).not.toHaveBeenCalled();

    const elsewhere = await post(door, signed(freshIssuer()), "198.51.100.9");
    expect(elsewhere.status).toBe(202);
  });

  it("past the pending ceiling no new row is filed", async () => {
    registry.list.mockResolvedValue(
      Array.from({ length: 20 }, (_, i) => ({ id: `p${i}`, status: "pending" }))
    );
    const res = await post(door, signed(freshIssuer()));
    expect(res.status).toBe(429);
    expect(registry.registerPending).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
});
