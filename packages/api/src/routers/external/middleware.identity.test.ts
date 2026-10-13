/**
 * `/api/external/*` key identity — the external door resolves a key through the
 * ONE identity door and runs the route inside the acting-agent + grant scope,
 * exactly like the tRPC / Hub / MCP key doors.
 *
 * Driven from a real `api_keys`-shaped record through the REAL
 * `resolveKeyIdentity` (only the users row and the grant read are stubbed) and
 * the real request-write-context ALS, to the values a route handler — and
 * `executeCapability` behind `POST /skills/:id/invoke` — actually receives.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

const h = vi.hoisted(() => ({
  validateApiKey: vi.fn(),
  usersFindFirst: vi.fn(),
  skillsFindFirst: vi.fn(),
  resolveForKey: vi.fn(),
  isGuestPrincipal: vi.fn(),
  executeCapability: vi.fn(),
}));

vi.mock("../../services/api-keys.js", () => ({
  apiKeyService: {
    validateApiKey: h.validateApiKey,
    checkRateLimit: () => true,
  },
}));

vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap/database")>()),
  db: {
    query: {
      users: { findFirst: h.usersFindFirst },
      skills: { findFirst: h.skillsFindFirst },
      workspaceMembers: { findFirst: vi.fn() },
    },
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  },
  GrantRepository: class {
    resolveForKey = h.resolveForKey;
  },
}));

vi.mock("../../access/guest-containment.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../access/guest-containment.js")
  >()),
  isGuestPrincipal: h.isGuestPrincipal,
}));

vi.mock("../../services/capabilities/execute-capability.js", () => ({
  executeCapability: h.executeCapability,
}));

import {
  getActingAgentUserId,
  getRequestGrant,
  type KeyGrant,
} from "@synap/database";
import { externalApiKeyAuth, type ExternalApiVariables } from "./middleware.js";
import { externalSkillsApp } from "./skills.js";

const FULL: KeyGrant = { scopes: [{ permissions: ["*"] }], clientId: null };
const DENY_ALL: KeyGrant = { scopes: [{ permissions: [] }], clientId: null };

function keyRecord(over: Record<string, unknown> = {}) {
  return {
    id: "key-1",
    userId: "agent-1",
    linkedUserId: "human-1",
    scope: ["chat.stream", "skills.invoke"],
    keyType: "hub_inbound",
    keyName: "test",
    workspaceId: null,
    ...over,
  };
}

/** A probe route: reports what the handler sees, from context AND the ALS. */
function probeApp() {
  const app = new Hono<{ Variables: ExternalApiVariables }>();
  app.get("/probe", externalApiKeyAuth("chat.stream"), (c) =>
    c.json({
      userId: c.get("userId"),
      agentUserId: c.get("agentUserId") ?? null,
      alsAgent: getActingAgentUserId() ?? null,
      alsGrant: getRequestGrant() ?? null,
    })
  );
  return app;
}

const auth = { headers: { authorization: "Bearer sk_test" } };

beforeEach(() => {
  vi.clearAllMocks();
  h.isGuestPrincipal.mockResolvedValue(false);
  h.resolveForKey.mockResolvedValue(FULL);
});

describe("externalApiKeyAuth — identity through the one door", () => {
  it("AGENT key: data floor = linked human, agent attributed, grant entered", async () => {
    h.validateApiKey.mockResolvedValue(keyRecord());
    h.usersFindFirst.mockResolvedValue({ userType: "agent" });

    const res = await probeApp().request("/probe", auth);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      userId: "human-1",
      agentUserId: "agent-1",
      alsAgent: "agent-1",
      alsGrant: FULL,
    });
  });

  it("HUMAN key (PAT): unchanged — the key owner, no agent", async () => {
    h.validateApiKey.mockResolvedValue(
      keyRecord({ userId: "human-1", linkedUserId: null })
    );
    h.usersFindFirst.mockResolvedValue({ userType: "human" });

    const res = await probeApp().request("/probe", auth);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      userId: "human-1",
      agentUserId: null,
      alsAgent: null,
    });
  });

  it("an invalid / inactive (pending, revoked) key is refused 401", async () => {
    h.validateApiKey.mockResolvedValue(null);
    const res = await probeApp().request("/probe", auth);
    expect(res.status).toBe(401);
  });

  it("a GUEST principal is refused 403", async () => {
    h.validateApiKey.mockResolvedValue(
      keyRecord({ userId: "guest-1", linkedUserId: null })
    );
    h.usersFindFirst.mockResolvedValue({ userType: "human" });
    h.isGuestPrincipal.mockResolvedValue(true);
    const res = await probeApp().request("/probe", auth);
    expect(res.status).toBe(403);
  });

  it("a SCOPED (fenced) grant fails closed with GRANT_DOOR_UNSUPPORTED", async () => {
    h.validateApiKey.mockResolvedValue(keyRecord());
    h.usersFindFirst.mockResolvedValue({ userType: "agent" });
    h.resolveForKey.mockResolvedValue(DENY_ALL);
    const res = await probeApp().request("/probe", auth);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "GRANT_DOOR_UNSUPPORTED" });
  });
});

describe("POST /api/external/skills/:id/invoke — agent run reaches the gate", () => {
  const SKILL = {
    id: "skill-1",
    name: "do_thing",
    status: "active",
    scope: "pod",
    userId: "human-1",
    workspaceId: null,
    metadata: {},
  };

  it("an AGENT key's run goes through executeCapability WITH the acting agent", async () => {
    h.validateApiKey.mockResolvedValue(keyRecord());
    h.usersFindFirst.mockResolvedValue({ userType: "agent" });
    h.skillsFindFirst.mockResolvedValue(SKILL);
    h.executeCapability.mockResolvedValue({
      kind: "proposed",
      proposalId: "p-1",
      reviewUrl: "/review/p-1",
      ackState: "proposed",
    });

    const res = await externalSkillsApp.request("/skill-1/invoke", {
      method: "POST",
      headers: { ...auth.headers, "content-type": "application/json" },
      body: JSON.stringify({ input: { a: 1 } }),
    });

    expect(h.executeCapability).toHaveBeenCalledWith(
      expect.objectContaining({
        skillId: "skill-1",
        userId: "human-1",
        agentUserId: "agent-1",
        parameters: { a: 1 },
      })
    );
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({
      proposed: true,
      proposalId: "p-1",
    });
  });

  it("a HUMAN key's run is an operator run (agentUserId null), result returned", async () => {
    h.validateApiKey.mockResolvedValue(
      keyRecord({ userId: "human-1", linkedUserId: null })
    );
    h.usersFindFirst.mockResolvedValue({ userType: "human" });
    h.skillsFindFirst.mockResolvedValue(SKILL);
    h.executeCapability.mockResolvedValue({
      kind: "run",
      skillId: "skill-1",
      result: { ok: true },
      ackState: "applied",
    });

    const res = await externalSkillsApp.request("/skill-1/invoke", {
      method: "POST",
      headers: { ...auth.headers, "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(h.executeCapability).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "human-1", agentUserId: null })
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      success: true,
      result: { ok: true },
    });
  });
});
