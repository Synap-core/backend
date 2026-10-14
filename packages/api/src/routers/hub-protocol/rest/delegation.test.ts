/**
 * POST /api/hub/delegation/refresh (D4) — AT THE DOOR: the real hub auth
 * middleware, the real route, real tokens from the real minting door. Only the
 * database (`users` lookup), the api-key store and the AI-service origin list
 * are stubbed. Pins: the refreshed token keeps sub/act/channel/run/aud/max_exp
 * with a new jti and authenticates as the same operator; the body can widen
 * nothing; a stored key cannot refresh; past max_exp is refused.
 */

import crypto from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";

const getApiKeyStatus = vi.fn();
const findFirstUser = vi.fn();
const knownOrigins = new Set<string>();

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    db: {
      query: {
        users: { findFirst: (...a: unknown[]) => findFirstUser(...a) },
      },
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: async () => [
              {
                permissions: ["*"],
                workspaceIds: null,
                projectIds: null,
                entityIds: null,
                expiresAt: null,
                revokedAt: null,
                clientId: null,
              },
            ],
          }),
        }),
      }),
    },
  };
});
vi.mock("@synap/intelligence-client", () => ({
  isIntelligenceServiceOrigin: async (origin: string) =>
    knownOrigins.has(origin),
}));
vi.mock("../../../access/guest-containment.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isGuestPrincipal: vi.fn(async () => false),
}));
vi.mock("../../../services/api-keys.js", () => ({
  apiKeyService: {
    getApiKeyStatus: (...a: unknown[]) => getApiKeyStatus(...a),
    recordKeyUse: vi.fn(),
    checkRateLimit: () => true,
  },
}));
vi.mock("../../../services/external-user-mapping.js", () => ({
  isSubTokenFeatureEnabled: () => false,
  resolveExternalUserMapping: vi.fn(),
}));

const { hubAuthMiddleware } = await import("../_middleware/auth.js");
const { registerDelegationRoutes } = await import("./delegation.js");
const {
  _resetPodIdentityForTest,
  mintIsDelegationToken,
  verifyIsDelegationToken,
} = await import("@synap/database");

const IS = "https://intelligence.synap.test";
const OPERATOR = "operator-human";
const dir = mkdtempSync(path.join(tmpdir(), "hub-delegation-refresh-"));

function writeKey(): string {
  const { privateKey } = crypto.generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const file = path.join(dir, `k-${crypto.randomUUID()}.pem`);
  writeFileSync(
    file,
    privateKey.export({ format: "pem", type: "pkcs8" }) as string,
    { mode: 0o600 }
  );
  return file;
}

const saved = {
  file: process.env.SYNAP_POD_IDENTITY_KEY_FILE,
  url: process.env.PUBLIC_URL,
};
function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  process.env.SYNAP_POD_IDENTITY_KEY_FILE = writeKey();
  process.env.PUBLIC_URL = "https://pod.lab1.synap.test";
  _resetPodIdentityForTest();
  knownOrigins.clear();
  knownOrigins.add(IS);
  getApiKeyStatus.mockReset();
  findFirstUser.mockReset();
  findFirstUser.mockImplementation(async () => ({
    id: OPERATOR,
    userType: "human",
  }));
});
afterEach(() => {
  vi.useRealTimers();
  restore("SYNAP_POD_IDENTITY_KEY_FILE", saved.file);
  restore("PUBLIC_URL", saved.url);
  _resetPodIdentityForTest();
});

const known = { isKnownAudience: (aud: string) => aud === IS };

function delegation(over: Record<string, unknown> = {}): string {
  return mintIsDelegationToken({
    isUrl: IS,
    operatorUserId: OPERATOR,
    agentUserId: "persona-agent",
    channelId: "channel-1",
    runId: "run-1",
    ...over,
  });
}

function app() {
  const hub = new Hono();
  hub.use("/*", hubAuthMiddleware as never);
  registerDelegationRoutes(hub as never);
  hub.get("/probe", (c) => c.json({ userId: c.get("userId" as never) }));
  const root = new Hono();
  root.route("/api/hub", hub);
  return root;
}

async function refresh(bearer: string, body?: unknown) {
  const res = await app().request("/api/hub/delegation/refresh", {
    method: "POST",
    headers: {
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
  };
}

describe("POST /delegation/refresh", () => {
  it("returns a new token: same sub/act/channel/run/aud/max_exp, new jti, exp <= max_exp", async () => {
    const current = delegation();
    const before = await verifyIsDelegationToken(current, known);
    const { status, body } = await refresh(current);
    expect(status).toBe(200);
    const after = await verifyIsDelegationToken(body.token as string, known);
    expect(after).toMatchObject({
      operatorUserId: OPERATOR,
      agentUserId: "persona-agent",
      channelId: "channel-1",
      runId: "run-1",
      audience: IS,
      maxExpiresAt: before.maxExpiresAt,
    });
    expect(after.jti).not.toBe(before.jti);
    expect(body.expiresAt).toBe(after.expiresAt);
    expect(body.maxExpiresAt).toBe(before.maxExpiresAt);
    expect(after.expiresAt).toBeLessThanOrEqual(after.maxExpiresAt);

    // The refreshed token authenticates at the door as the same operator.
    const probe = await app().request("/api/hub/probe", {
      headers: { authorization: `Bearer ${body.token as string}` },
    });
    expect(probe.status).toBe(200);
    expect(await probe.json()).toEqual({ userId: OPERATOR });
  });

  it("reads nothing from the body: a request naming another operator or a later max_exp widens nothing", async () => {
    const current = delegation();
    const before = await verifyIsDelegationToken(current, known);
    const { status, body } = await refresh(current, {
      sub: "someone-else",
      operatorUserId: "someone-else",
      max_exp: before.maxExpiresAt + 86_400,
      maxExpiresAt: before.maxExpiresAt + 86_400,
    });
    expect(status).toBe(200);
    const after = await verifyIsDelegationToken(body.token as string, known);
    expect(after.operatorUserId).toBe(OPERATOR);
    expect(after.maxExpiresAt).toBe(before.maxExpiresAt);
  });

  it("a stored API key cannot refresh (only a delegation can)", async () => {
    getApiKeyStatus.mockResolvedValue({
      status: "valid",
      record: {
        id: "key-is-internal",
        userId: "system",
        linkedUserId: null,
        scope: ["hub-protocol.read", "hub-protocol.write"],
        keyType: "is_internal",
        workspaceId: null,
        expiresAt: null,
        parentKeyId: null,
      },
    });
    const { status, body } = await refresh("synap_hub_test_" + "0".repeat(64));
    expect(status).toBe(401);
    expect(body.reason).toBe("key_revoked");
  });

  it("is refused past max_exp", async () => {
    const t0 = Date.now();
    const current = delegation({
      maxExpiresAt: Math.floor(t0 / 1000) + 60,
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(t0 + 61_000);
    const { status, body } = await refresh(current);
    expect(status).toBe(401);
    expect(body.reason).toBe("expired");
  });

  it("refuses a delegation for an AI service this pod no longer uses", async () => {
    const current = delegation();
    knownOrigins.clear();
    const { status } = await refresh(current);
    expect(status).toBe(401);
  });
});
