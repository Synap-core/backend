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
const resolveCeiling = vi.fn();
vi.mock("../../../services/synap-ai-ceiling.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../services/synap-ai-ceiling.js")
  >()),
  resolveSynapAiCeiling: (...a: unknown[]) => resolveCeiling(...a),
}));
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
const {
  _resetPodIdentityForTest,
  mintIsDelegationToken,
  getRequestGrant,
  getRequestClientKey,
} = await import("@synap/database");

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
      clientKey: getRequestClientKey() ?? null,
    })
  );
  const res = await app.request("/api/hub/probe", { headers });
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
  };
}

beforeEach(() => {
  resolveCeiling.mockReset();
  resolveCeiling.mockResolvedValue({ status: "not-applicable" });
});

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
      // No named run: no client — a channel turn groups by its channel.
      clientKey: null,
    });
    expect(getApiKeyStatus).not.toHaveBeenCalled();
  });

  it("W-A4: a non-channel run that names itself is its own client", async () => {
    const run = "is:5b0f1e2a-9c4d-4e8f-8a1b-2c3d4e5f6a7b";
    const { status, body } = await callDoor({
      authorization: `Bearer ${delegation({ channelId: null })}`,
      "x-synap-conversation": run,
    });
    expect(status).toBe(200);
    expect(body.clientKey).toBe(`is:${IS}|conv:${run}`);
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

// ── The app grant claim (`app_grant`): the turn runs under the app's grant ──

const appGrantOf = (
  permissions: string[],
  workspaceIds: string[] | null = null
) => ({
  scopes: [{ permissions, workspaceIds, projectIds: null, entityIds: null }],
  clientId: "app_public_test",
});

async function callAt(
  method: string,
  path: string,
  headers: Record<string, string>
) {
  const app = new Hono();
  app.use("/api/hub/*", hubAuthMiddleware as never);
  app.all("/api/hub/*", (c) =>
    c.json({
      ok: true,
      fullGrant:
        getRequestGrant()?.scopes.every((s) => s.permissions.includes("*")) ??
        null,
    })
  );
  const res = await app.request(path, { method, headers });
  return {
    status: res.status,
    body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
  };
}

describe("IS delegation with an app grant (app_grant claim)", () => {
  it("(a) a claim's grant refuses a read door outside it (403), and admits one inside it", async () => {
    const readOnlyEntities = delegation({
      appGrant: appGrantOf(["entity.read"]),
    });
    const outside = await callAt("GET", "/api/hub/messaging/accounts", {
      authorization: `Bearer ${readOnlyEntities}`,
    });
    expect(outside.status).toBe(403);
    expect(outside.body).toMatchObject({ code: "GRANT_DOOR_UNSUPPORTED" });

    const inside = await callAt("GET", "/api/hub/messaging/accounts", {
      authorization: `Bearer ${delegation({ appGrant: appGrantOf(["messaging.read"]) })}`,
    });
    expect(inside.status).not.toBe(403);
  });

  it("(a2) the grant is what the turn runs under: not the full-access grant", async () => {
    const r = await callAt("GET", "/api/hub/messaging/accounts", {
      authorization: `Bearer ${delegation({ appGrant: appGrantOf(["messaging.read"]) })}`,
    });
    expect(r.status).not.toBe(403);
    const probe = await callAt("POST", "/api/hub/anything-unlisted", {
      authorization: `Bearer ${delegation({ appGrant: appGrantOf(["messaging.read"]) })}`,
    });
    expect(probe.body.fullGrant).not.toBe(true);
  });

  it.each([
    ["a claim that is not an object", "not-an-object"],
    ["a claim with no scopes", { scopes: [], clientId: null }],
    [
      "a claim whose permission does not parse",
      { scopes: [{ permissions: ["entity..read"] }], clientId: null },
    ],
  ])("(b) %s is 401, never a fallback to '*'", async (_name, claim) => {
    const token = delegation({ appGrant: claim as never });
    const r = await callAt("GET", "/api/hub/messaging/accounts", {
      authorization: `Bearer ${token}`,
    });
    expect(r.status).toBe(401);
  });

  it("(c) a delegation with NO claim keeps the full-access grant", async () => {
    const r = await callAt("GET", "/api/hub/anything-unlisted", {
      authorization: `Bearer ${delegation()}`,
    });
    expect(r.status).toBe(200);
    expect(r.body.fullGrant).toBe(true);
  });

  it("(f) a refresh keeps the app grant (a refresh never widens it to '*')", async () => {
    const { refreshIsDelegationToken, verifyIsDelegationToken } =
      await import("@synap/database");
    const token = delegation({ appGrant: appGrantOf(["messaging.read"]) });
    const refreshed = await refreshIsDelegationToken(token, {
      isKnownAudience: (a) => a === IS,
    });
    const verified = await verifyIsDelegationToken(refreshed.token, {
      isKnownAudience: (a) => a === IS,
    });
    expect(verified.appGrant).toEqual(appGrantOf(["messaging.read"]));
  });

  it("(g) a claim too large to sign is refused at the mint, not sent", () => {
    const huge = appGrantOf(
      Array.from({ length: 400 }, (_, i) => `chat.${"x".repeat(40)}${i}.read`)
    );
    expect(() => delegation({ appGrant: huge })).toThrow();
  });
});

// ── Synap AI's ceiling (`act.sub` = the operator's personal agent) ──────────────

const ceilingOf = (
  permissions: string[],
  workspaceIds: string[] | null = null
) => ({
  status: "ok" as const,
  grant: {
    scopes: [{ permissions, workspaceIds, projectIds: null, entityIds: null }],
    clientId: "synap-ai",
  },
});

describe("IS delegation naming the operator's Synap AI (act.sub)", () => {
  it("(a) the ceiling is the turn's grant: a door it covers is admitted, one it does not is refused (403), never the full grant", async () => {
    const headers = {
      authorization: `Bearer ${delegation({ agentUserId: "synap-ai-agent" })}`,
    };
    resolveCeiling.mockResolvedValue(ceilingOf(["messaging.read"]));
    const inside = await callAt("GET", "/api/hub/messaging/accounts", headers);
    expect(inside.status).not.toBe(403);
    expect(inside.body.fullGrant).not.toBe(true);
    resolveCeiling.mockResolvedValue(ceilingOf(["entity.read"]));
    const outside = await callAt("GET", "/api/hub/messaging/accounts", headers);
    expect(outside.status).toBe(403);
    expect(outside.body).toMatchObject({ code: "GRANT_DOOR_UNSUPPORTED" });
    // The resolver is asked about the TOKEN's operator and agent (not a header's).
    expect(resolveCeiling).toHaveBeenCalledWith(OPERATOR, "synap-ai-agent");
  });

  it("(b) an app's claim narrows the ceiling: a permission the ceiling has but the app does not is refused", async () => {
    resolveCeiling.mockResolvedValue(
      ceilingOf(["messaging.read", "entity.read"])
    );
    const onlyEntities = delegation({
      agentUserId: "synap-ai-agent",
      appGrant: appGrantOf(["entity.read"]),
    });
    const r = await callAt("GET", "/api/hub/messaging/accounts", {
      authorization: `Bearer ${onlyEntities}`,
    });
    expect(r.status).toBe(403);
    const both = delegation({
      agentUserId: "synap-ai-agent",
      appGrant: appGrantOf(["messaging.read"]),
    });
    const ok = await callAt("GET", "/api/hub/messaging/accounts", {
      authorization: `Bearer ${both}`,
    });
    expect(ok.status).not.toBe(403);
  });

  it("(c) an app's claim cannot WIDEN the ceiling: an app that holds messaging.read over a ceiling without it gets nothing", async () => {
    resolveCeiling.mockResolvedValue(ceilingOf(["entity.read"]));
    const wider = delegation({
      agentUserId: "synap-ai-agent",
      appGrant: appGrantOf(["messaging.read", "entity.read"]),
    });
    const r = await callAt("GET", "/api/hub/messaging/accounts", {
      authorization: `Bearer ${wider}`,
    });
    expect(r.status).toBe(403);
  });

  it("(d) no ceiling set (none) or another agent (not-applicable): today's behaviour, unchanged", async () => {
    for (const status of ["none", "not-applicable"] as const) {
      resolveCeiling.mockResolvedValue({ status });
      const full = await callAt("GET", "/api/hub/anything-unlisted", {
        authorization: `Bearer ${delegation({ agentUserId: "synap-ai-agent" })}`,
      });
      expect(full.body.fullGrant, status).toBe(true);
      const app = await callAt("GET", "/api/hub/messaging/accounts", {
        authorization: `Bearer ${delegation({ agentUserId: "synap-ai-agent", appGrant: appGrantOf(["entity.read"]) })}`,
      });
      expect(app.status, status).toBe(403); // the app's claim still bounds it
    }
  });

  it("(e) a paused Synap AI is refused (401), not widened to the full grant", async () => {
    resolveCeiling.mockResolvedValue({ status: "refused", reason: "paused" });
    const r = await callAt("GET", "/api/hub/anything-unlisted", {
      authorization: `Bearer ${delegation({ agentUserId: "synap-ai-agent" })}`,
    });
    expect(r.status).toBe(401);
  });

  it("(f) a ceiling that cannot be read fails the request; it never reads as 'none' and widens", async () => {
    resolveCeiling.mockRejectedValue(new Error("database down"));
    const r = await callAt("GET", "/api/hub/anything-unlisted", {
      authorization: `Bearer ${delegation({ agentUserId: "synap-ai-agent" })}`,
    });
    expect(r.status).toBeGreaterThanOrEqual(500);
    expect(r.body.fullGrant).not.toBe(true);
  });

  it("(g) a delegation that names no agent never asks (and keeps the full grant)", async () => {
    const r = await callAt("GET", "/api/hub/anything-unlisted", {
      authorization: `Bearer ${delegation({ agentUserId: null })}`,
    });
    expect(r.status).toBe(200);
    expect(r.body.fullGrant).toBe(true);
    expect(resolveCeiling).not.toHaveBeenCalled();
  });
});
