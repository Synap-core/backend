/**
 * Hub Protocol auth-middleware identity tests — AT THE DOOR.
 *
 * Pins the ORDER OF OPERATIONS between the two identity remaps that both write
 * `c.set("userId", …)`:
 *   1. the X-External-User-Id sub-token remap (external end-user), and
 *   2. the agent-key `linkedUserId` remap (the human the agent acts for).
 *
 * Until this file existed, (2) ran unconditionally whenever the key had a
 * `linkedUserId` and clobbered (1) — silently attributing an external end-user's
 * reads and writes to the pod owner. Nothing pinned either behaviour.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

const getApiKeyStatus = vi.fn();
const resolveExternalUserMapping = vi.fn();
const isSubTokenFeatureEnabled = vi.fn(() => true);
const findFirstUser = vi.fn();

// PARTIAL mock (`importOriginal` + spread) — a TOTAL replacement breaks the
// moment any module in the graph reaches for an export the stub does not list,
// and the `database-mock-total-ratchet` tripwire forbids adding new ones. Only
// `db` is faked; every other export stays real.
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
  isSubTokenFeatureEnabled: () => isSubTokenFeatureEnabled(),
  resolveExternalUserMapping: (...a: unknown[]) =>
    resolveExternalUserMapping(...a),
}));

const { hubAuthMiddleware } = await import("./auth.js");

const OWNER = "agent-principal-user";
const HUMAN = "pod-owner-human";
const EXTERNAL = "external-end-user";

type KeyRecord = Record<string, unknown>;

function keyRecord(over: KeyRecord = {}): KeyRecord {
  return {
    id: "key-1",
    userId: OWNER,
    linkedUserId: HUMAN,
    parentKeyId: null,
    scope: ["hub-protocol.read", "hub-protocol.write"],
    keyType: "hub_inbound",
    workspaceId: null,
    expiresAt: null,
    ...over,
  };
}

/** Runs the real middleware inside a real Hono app and returns the context vars. */
async function callDoor(headers: Record<string, string>) {
  const app = new Hono();
  app.use("/api/hub/*", hubAuthMiddleware as never);
  app.get("/api/hub/probe", (c) =>
    c.json({
      userId: c.get("userId" as never),
      linkedUserId: c.get("linkedUserId" as never),
      agentUserId: c.get("agentUserId" as never),
      parentKeyId: c.get("parentKeyId" as never),
      externalUserId: c.get("externalUserId" as never),
    })
  );
  const res = await app.request("/api/hub/probe", {
    headers: { authorization: "Bearer synap_test", ...headers },
  });
  return {
    status: res.status,
    body: (await res.json()) as Record<string, string | undefined>,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  isSubTokenFeatureEnabled.mockReturnValue(true);
  // Key principal is an agent → agentUserId is derived (the ONE is-agent signal).
  findFirstUser.mockResolvedValue({ userType: "agent" });
  resolveExternalUserMapping.mockResolvedValue({ synapUserId: EXTERNAL });
});

describe("hub auth middleware — sub-token vs linkedUserId identity", () => {
  it("agent parent key + X-External-User-Id → userId is the EXTERNAL user, not the linked human", async () => {
    getApiKeyStatus.mockResolvedValue({ status: "valid", record: keyRecord() });
    const { status, body } = await callDoor({
      "x-external-user-id": "ext-abc",
    });
    expect(status).toBe(200);
    expect(body.userId).toBe(EXTERNAL);
    expect(body.userId).not.toBe(HUMAN);
  });

  it("…and exposes parentKeyId + externalUserId for the remapped request", async () => {
    getApiKeyStatus.mockResolvedValue({ status: "valid", record: keyRecord() });
    const { body } = await callDoor({ "x-external-user-id": "ext-abc" });
    expect(body.parentKeyId).toBe("key-1");
    expect(body.externalUserId).toBe("ext-abc");
  });

  it("…and does NOT leave linkedUserId on the context (the request is the external user's)", async () => {
    getApiKeyStatus.mockResolvedValue({ status: "valid", record: keyRecord() });
    const { body } = await callDoor({ "x-external-user-id": "ext-abc" });
    expect(body.linkedUserId).toBeUndefined();
  });

  it("linked key WITHOUT X-External-User-Id → still the linked human (no regression)", async () => {
    getApiKeyStatus.mockResolvedValue({ status: "valid", record: keyRecord() });
    const { body } = await callDoor({});
    expect(body.userId).toBe(HUMAN);
    expect(body.linkedUserId).toBe(HUMAN);
    expect(body.parentKeyId).toBeUndefined();
  });

  it("service key (linkedUserId: null) + sub-token → external user, unchanged", async () => {
    getApiKeyStatus.mockResolvedValue({
      status: "valid",
      record: keyRecord({ linkedUserId: null, keyType: "service" }),
    });
    const { body } = await callDoor({ "x-external-user-id": "ext-abc" });
    expect(body.userId).toBe(EXTERNAL);
    expect(body.linkedUserId).toBeUndefined();
  });

  it("sub-token mapping FAILS → falls back to the key owner path (linked human), never fails closed", async () => {
    resolveExternalUserMapping.mockResolvedValue(null);
    getApiKeyStatus.mockResolvedValue({ status: "valid", record: keyRecord() });
    const { status, body } = await callDoor({
      "x-external-user-id": "ext-abc",
    });
    expect(status).toBe(200);
    expect(body.userId).toBe(HUMAN);
    expect(body.linkedUserId).toBe(HUMAN);
    expect(body.parentKeyId).toBeUndefined();
  });

  it("agentUserId still names the acting agent principal under a sub-token", async () => {
    getApiKeyStatus.mockResolvedValue({ status: "valid", record: keyRecord() });
    const { body } = await callDoor({ "x-external-user-id": "ext-abc" });
    expect(body.agentUserId).toBe(OWNER);
  });
});

describe("rest/memory.ts identity-link dual-write, evaluated on real context values", () => {
  /** Verbatim shape of the guard in `rest/memory.ts` (saveFact). */
  const dualWriteTarget = (ctx: Record<string, string | undefined>) => {
    const isSubToken = !!ctx.parentKeyId;
    const linkedUserId = ctx.linkedUserId;
    return !isSubToken && linkedUserId && linkedUserId !== ctx.userId
      ? linkedUserId
      : undefined;
  };

  it("sub-token request: the fact is stored for the EXTERNAL user and mirrored nowhere", async () => {
    getApiKeyStatus.mockResolvedValue({ status: "valid", record: keyRecord() });
    const { body } = await callDoor({ "x-external-user-id": "ext-abc" });
    // Pre-fix this read HUMAN, so the external user's memory was written to the
    // pod owner and NOT to the external user at all.
    expect(body.userId).toBe(EXTERNAL);
    expect(dualWriteTarget(body)).toBeUndefined();
  });

  it("non-sub-token linked key: primary write lands on the human (mirror is a no-op, not a skip)", async () => {
    getApiKeyStatus.mockResolvedValue({ status: "valid", record: keyRecord() });
    const { body } = await callDoor({});
    // The `isSubToken` guard does NOT fire here — the mirror is simply
    // redundant because userId already IS linkedUserId.
    expect(body.parentKeyId).toBeUndefined();
    expect(body.userId).toBe(HUMAN);
    expect(body.linkedUserId).toBe(HUMAN);
    expect(dualWriteTarget(body)).toBeUndefined();
  });
});
