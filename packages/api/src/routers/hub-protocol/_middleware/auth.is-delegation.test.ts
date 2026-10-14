/**
 * The hub auth door with the IS delegation (D4) — AT THE DOOR.
 *
 * A real key file, real tokens from the real minting door
 * (`mintIsDelegationToken`), the real middleware inside a real Hono app. Only
 * the database (`users` lookup), the api-key store and the AI-service origin
 * list are stubbed. Pins:
 *   - a valid delegation authenticates AS ITS `sub`, with the same principal
 *     the legacy is_internal key + header produced (keyType, no acting agent)
 *     and no api key id (so no body `userId` may name anyone else);
 *   - every refusal: forged, wrong audience, expired, operator not a pod user,
 *     header/sub mismatch;
 *   - the legacy key + header: accepted and logged while the switch allows it,
 *     refused once it says `refuse`.
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

const { hubAuthMiddleware } = await import("./auth.js");
const { _resetPodIdentityForTest, mintIsDelegationToken, getRequestGrant } =
  await import("@synap/database");

const IS = "https://intelligence.synap.test";
const OPERATOR = "operator-human";
const dir = mkdtempSync(path.join(tmpdir(), "hub-auth-delegation-"));

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
  legacy: process.env.SYNAP_IS_LEGACY_DELEGATION,
};
function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  process.env.SYNAP_POD_IDENTITY_KEY_FILE = writeKey();
  process.env.PUBLIC_URL = "https://pod.lab1.synap.test";
  delete process.env.SYNAP_IS_LEGACY_DELEGATION;
  _resetPodIdentityForTest();
  knownOrigins.clear();
  knownOrigins.add(IS);
  getApiKeyStatus.mockReset();
  findFirstUser.mockReset();
  // Every id names a real pod user unless a test says otherwise.
  findFirstUser.mockImplementation(async () => ({
    id: OPERATOR,
    userType: "human",
  }));
});
afterEach(() => {
  restore("SYNAP_POD_IDENTITY_KEY_FILE", saved.file);
  restore("PUBLIC_URL", saved.url);
  restore("SYNAP_IS_LEGACY_DELEGATION", saved.legacy);
  _resetPodIdentityForTest();
});

function delegation(over: Record<string, unknown> = {}): string {
  return mintIsDelegationToken({
    isUrl: IS,
    operatorUserId: OPERATOR,
    agentUserId: "persona-agent",
    channelId: "channel-1",
    ...over,
  });
}

async function callDoor(headers: Record<string, string>) {
  const app = new Hono();
  app.use("/api/hub/*", hubAuthMiddleware as never);
  app.get("/api/hub/probe", (c) =>
    c.json({
      userId: c.get("userId" as never),
      linkedUserId: c.get("linkedUserId" as never),
      agentUserId: c.get("agentUserId" as never) ?? null,
      apiKeyId: c.get("apiKeyId" as never) ?? null,
      keyType: c.get("keyType" as never),
      scopes: c.get("scopes" as never),
      fullGrant:
        getRequestGrant()?.scopes.every((s) => s.permissions.includes("*")) ??
        null,
    })
  );
  const res = await app.request("/api/hub/probe", { headers });
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
  };
}

describe("hub auth: IS delegation token", () => {
  it("authenticates AS sub, with the legacy is_internal principal and no api key id", async () => {
    const { status, body } = await callDoor({
      authorization: `Bearer ${delegation()}`,
    });
    expect(status).toBe(200);
    expect(body).toEqual({
      userId: OPERATOR,
      linkedUserId: OPERATOR,
      agentUserId: null,
      apiKeyId: null,
      keyType: "is_internal",
      scopes: ["hub-protocol.read", "hub-protocol.write"],
      fullGrant: true,
    });
    expect(getApiKeyStatus).not.toHaveBeenCalled();
  });

  it("accepts a matching X-Delegated-Operator-Id (an IS mid-rollout may send both)", async () => {
    const { status } = await callDoor({
      authorization: `Bearer ${delegation()}`,
      "x-delegated-operator-id": OPERATOR,
    });
    expect(status).toBe(200);
  });

  it("refuses a header that names another operator than the token", async () => {
    const { status, body } = await callDoor({
      authorization: `Bearer ${delegation()}`,
      "x-delegated-operator-id": "someone-else",
    });
    expect(status).toBe(401);
    expect(body.reason).toBe("key_revoked");
  });

  it("refuses an operator that is not a pod user", async () => {
    findFirstUser.mockImplementation(async () => undefined);
    const { status } = await callDoor({
      authorization: `Bearer ${delegation()}`,
    });
    expect(status).toBe(401);
  });

  it("refuses a forged signature", async () => {
    const [h, p] = delegation().split(".");
    const other = crypto.generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
    });
    const sig = crypto
      .sign("sha256", Buffer.from(`${h}.${p}`), {
        key: other.privateKey,
        dsaEncoding: "ieee-p1363",
      })
      .toString("base64url");
    const { status } = await callDoor({
      authorization: `Bearer ${h}.${p}.${sig}`,
    });
    expect(status).toBe(401);
  });

  it("refuses a token for an AI service this pod does not use (wrong aud)", async () => {
    knownOrigins.clear();
    const { status } = await callDoor({
      authorization: `Bearer ${delegation()}`,
    });
    expect(status).toBe(401);
  });

  it("refuses an expired token as `expired`", async () => {
    const token = delegation();
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 16 * 60_000);
    try {
      const { status, body } = await callDoor({
        authorization: `Bearer ${token}`,
      });
      expect(status).toBe(401);
      expect(body.reason).toBe("expired");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("hub auth: the legacy is_internal key + header (transition)", () => {
  function legacyKey() {
    getApiKeyStatus.mockResolvedValue({
      status: "valid",
      record: {
        id: "is-key-1",
        userId: "system",
        linkedUserId: null,
        parentKeyId: null,
        scope: ["hub-protocol.read", "hub-protocol.write"],
        keyType: "is_internal",
        workspaceId: null,
        expiresAt: null,
      },
    });
  }

  it("is accepted while the switch allows it (missing token → legacy path)", async () => {
    legacyKey();
    const { status, body } = await callDoor({
      authorization: "Bearer synap_hub_test_x",
      "x-delegated-operator-id": OPERATOR,
    });
    expect(status).toBe(200);
    expect(body.userId).toBe(OPERATOR);
  });

  it("is refused once SYNAP_IS_LEGACY_DELEGATION=refuse", async () => {
    legacyKey();
    process.env.SYNAP_IS_LEGACY_DELEGATION = "refuse";
    const { status } = await callDoor({
      authorization: "Bearer synap_hub_test_x",
      "x-delegated-operator-id": OPERATOR,
    });
    expect(status).toBe(401);
  });
});
