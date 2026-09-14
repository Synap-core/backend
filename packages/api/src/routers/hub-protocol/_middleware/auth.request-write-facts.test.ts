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

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    db: {
      query: {
        users: { findFirst: (...a: unknown[]) => findFirstUser(...a) },
      },
    },
  };
});

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
const { getActingAgentUserId, isProbeWriteContext, KEY_PREFIXES } =
  await import("@synap/database");

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

async function factsSeenDownstream() {
  const app = new Hono();
  app.use("/api/hub/*", hubAuthMiddleware as never);
  app.get("/api/hub/facts", async (c) => {
    await new Promise((r) => setTimeout(r, 1));
    return c.json({
      actingAgent: getActingAgentUserId() ?? null,
      probe: isProbeWriteContext(),
    });
  });
  const res = await app.request("/api/hub/facts", {
    headers: { authorization: "Bearer synap_test" },
  });
  return (await res.json()) as { actingAgent: string | null; probe: boolean };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("hub auth door enters the request write facts", () => {
  it("agent key principal → acting agent is set downstream (D6 floor can see it)", async () => {
    findFirstUser.mockResolvedValue({ userType: "agent" });
    getApiKeyStatus.mockResolvedValue({ status: "valid", record: keyRecord() });
    expect(await factsSeenDownstream()).toEqual({
      actingAgent: AGENT,
      probe: false,
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
});
