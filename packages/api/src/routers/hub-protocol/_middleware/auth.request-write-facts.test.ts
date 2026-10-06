/**
 * Hub auth door → request write facts (@synap/database request-write-context).
 *
 * The floors below the door (`ProfileRepository.create` for D6, the probe
 * stamps for D8) only work if the DOOR enters the facts. Asserted from inside a
 * real downstream handler, through the real middleware:
 *  - an agent key principal → `getActingAgentUserId()` is that agent;
 *  - a human key → no acting agent;
 *  - a key whose stored scopes carry `probe` → probe context; a key merely on
 *    the TEST prefix with a dev hubId → NOT a probe.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

const getApiKeyStatus = vi.fn();
const findFirstUser = vi.fn();
/** The `grants` rows GrantRepository.resolveForKey reads (newest first). */
let grantRows: Array<Record<string, unknown>> = [];

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    db: {
      query: {
        users: { findFirst: (...a: unknown[]) => findFirstUser(...a) },
      },
      // W1: these keys carry no grant (GrantRepository.resolveForKey → null).
      select: () => ({
        from: () => ({
          where: () => ({ orderBy: () => ({ limit: async () => grantRows }) }),
        }),
      }),
    },
  };
});

// Guest containment is its own door with its own tests
// (__tripwires__/guest-containment-hub-routes.test.ts); here the principal is a
// participant, and the audience probe would need the stubbed database.
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
  getActingAgentUserId,
  getRequestGrant,
  isProbeWriteContext,
  KEY_PREFIXES,
} = await import("@synap/database");

const AGENT = "agent-principal-user";

function keyRecord(over: Record<string, unknown> = {}) {
  return {
    id: "key-1",
    userId: AGENT,
    linkedUserId: "pod-owner-human",
    parentKeyId: null,
    scope: ["hub-protocol.read", "hub-protocol.write"],
    keyType: "hub_inbound",
    workspaceId: null,
    expiresAt: null,
    ...over,
  };
}

// A seamed read path (`/entities/:id`), so a scoped key passes the W1 door
// fence and the facts it entered can be observed downstream.
async function factsSeenDownstream() {
  const app = new Hono();
  app.use("/api/hub/*", hubAuthMiddleware as never);
  app.get("/api/hub/entities/facts", async (c) => {
    await new Promise((r) => setTimeout(r, 1));
    return c.json({
      actingAgent: getActingAgentUserId() ?? null,
      probe: isProbeWriteContext(),
      grant: getRequestGrant() ?? null,
    });
  });
  const res = await app.request("/api/hub/entities/facts", {
    headers: { authorization: "Bearer synap_test" },
  });
  return (await res.json()) as {
    actingAgent: string | null;
    probe: boolean;
    grant: { permissions: string[] } | null;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  grantRows = [];
});

describe("hub auth door enters the request write facts", () => {
  it("agent key principal → acting agent is set downstream (D6 floor can see it)", async () => {
    findFirstUser.mockResolvedValue({ userType: "agent" });
    getApiKeyStatus.mockResolvedValue({ status: "valid", record: keyRecord() });
    expect(await factsSeenDownstream()).toEqual({
      actingAgent: AGENT,
      probe: false,
      grant: null,
    });
  });

  it("human key → no acting agent", async () => {
    findFirstUser.mockResolvedValue({ userType: "human" });
    getApiKeyStatus.mockResolvedValue({
      status: "valid",
      record: keyRecord({ linkedUserId: null }),
    });
    expect(await factsSeenDownstream()).toEqual({
      actingAgent: null,
      probe: false,
      grant: null,
    });
  });

  it("TEST prefix + dev hubId is NOT a probe; an explicit probe scope is", async () => {
    findFirstUser.mockResolvedValue({ userType: "human" });
    getApiKeyStatus.mockResolvedValue({
      status: "valid",
      record: keyRecord({
        linkedUserId: null,
        keyPrefix: KEY_PREFIXES.HUB_TEST,
        hubId: "devplane",
      }),
    });
    expect((await factsSeenDownstream()).probe).toBe(false);

    getApiKeyStatus.mockResolvedValue({
      status: "valid",
      record: keyRecord({
        linkedUserId: null,
        scope: ["hub-protocol.write", "probe"],
      }),
    });
    expect((await factsSeenDownstream()).probe).toBe(true);
  });

  it("a key with a grant → the grant is the request's grant downstream (W1)", async () => {
    findFirstUser.mockResolvedValue({ userType: "agent" });
    getApiKeyStatus.mockResolvedValue({ status: "valid", record: keyRecord() });
    grantRows = [
      {
        id: "g1",
        permissions: ["entity.knowledge.read"],
        workspaceIds: null,
        projectIds: null,
        entityIds: null,
        expiresAt: null,
        revokedAt: null,
      },
    ];
    expect((await factsSeenDownstream()).grant).toMatchObject({
      permissions: ["entity.knowledge.read"],
    });
  });

  it("a key whose grant was revoked → deny-all downstream, never 'no grant'", async () => {
    findFirstUser.mockResolvedValue({ userType: "agent" });
    getApiKeyStatus.mockResolvedValue({ status: "valid", record: keyRecord() });
    grantRows = [
      {
        id: "g1",
        permissions: ["*"],
        workspaceIds: null,
        projectIds: null,
        entityIds: null,
        expiresAt: null,
        revokedAt: new Date(),
      },
    ];
    expect((await factsSeenDownstream()).grant).toMatchObject({
      permissions: [],
    });
  });

  it("the fence refuses a scoped key on an unseamed read, admits a seamed one (W1)", async () => {
    findFirstUser.mockResolvedValue({ userType: "agent" });
    getApiKeyStatus.mockResolvedValue({ status: "valid", record: keyRecord() });
    grantRows = [
      {
        id: "g1",
        permissions: ["entity.read"],
        workspaceIds: null,
        projectIds: null,
        entityIds: null,
        expiresAt: null,
        revokedAt: null,
      },
    ];
    const app = new Hono();
    app.use("/api/hub/*", hubAuthMiddleware as never);
    app.get("/api/hub/*", (c) => c.json({ ok: true }));
    const status = async (path: string) =>
      (
        await app.request(path, {
          headers: { authorization: "Bearer synap_test" },
        })
      ).status;
    expect(await status("/api/hub/search")).toBe(403);
    expect(await status("/api/hub/entities/abc")).toBe(200);
  });
});
