/**
 * `POST /setup/agent` with a KEY: what the key's person may make it do.
 * Pre-launch audit, 2026-10-28 (rule: `services/privileged-mint.ts`).
 *
 * F7 — a `setup.agent` key is an OPERATOR credential: it names any human as
 *   the new agent's owner (`linkedUserId`, an email works) and mints an ACTIVE
 *   key reading as that human. Any member could mint the scope, so any member
 *   could read any other human's brain. Now the key is operator-grade only
 *   while its person is a pod admin; any other holder is an ordinary key.
 * F6 — a non-uuid `linkedUserId` was resolved (and its 409 listed every
 *   human's id, email and name) for EVERY caller, an agent's key included,
 *   though a surface key's `linkedUserId` is ignored. Now never looked up for
 *   a surface key.
 * F5 — a surface key named ANY workspace id and its new agent became an
 *   editor there. Now the key's person must own or administer that space and
 *   the key must reach it; a non-member gets the same 404 as a missing space.
 *
 * Through the REAL route. Mocked: key lookup, identity, who is a pod admin,
 * the provisioning door, the proposal filer, the grant helpers, the db.
 * Negative control: restore `setup.ts` from main and the refusals here fail.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

const MEMBER = "0aaaaaaa-0000-4000-8000-000000000001";
const ADMIN = "0aaaaaaa-0000-4000-8000-000000000002";
const VICTIM = "0aaaaaaa-0000-4000-8000-000000000003";
const NEW_AGENT = "0bbbbbbb-0000-4000-8000-000000000002";
const WS = "0ddddddd-0000-4000-8000-000000000004";
const OTHER_WS = "0ddddddd-0000-4000-8000-000000000005";
const VICTIM_EMAIL = "victim@example.test";

const h = vi.hoisted(() => ({
  podAdmins: new Set<string>(),
  /** Answers to `workspaceMembers.findFirst`, in call order. */
  memberAnswers: [] as Array<{ role?: string; userId?: string } | undefined>,
  inserts: [] as Array<Record<string, unknown>>,
}));

const validateApiKey = vi.fn();
const resolveKeyIdentity = vi.fn();
const provisionSurfaceAgentKey = vi.fn();
const fileAgentConnectProposal = vi.fn();
const liveGrantsOfKey = vi.fn();
const attachGrantsOrRevoke = vi.fn();
const revokeApiKeys = vi.fn();
const usersFindMany = vi.fn();

vi.mock("../../../utils/workspace-role.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isPodAdmin: vi.fn(async (userId: string) => h.podAdmins.has(userId)),
}));
vi.mock("../../../services/api-keys.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../services/api-keys.js")>();
  return {
    ...actual,
    apiKeyService: {
      ...actual.apiKeyService,
      validateApiKey,
      invalidateVerificationCache: vi.fn(),
    },
  };
});
vi.mock("../../../access/key-identity.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../access/key-identity.js")>()),
  resolveKeyIdentity,
}));
vi.mock(
  "../../../services/agent-identity-service.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../../services/agent-identity-service.js")
    >()),
    provisionSurfaceAgentKey,
  })
);
vi.mock("../../../services/agent-connect.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../services/agent-connect.js")
  >()),
  fileAgentConnectProposal,
}));
vi.mock("../../../services/key-grant.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../services/key-grant.js")>()),
  liveGrantsOfKey,
  attachGrantsOrRevoke,
}));
vi.mock("@synap/database/api-key-revocation", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@synap/database/api-key-revocation")
  >()),
  revokeApiKeys,
}));
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    db: {
      query: {
        users: {
          findFirst: async () => ({ id: MEMBER }),
          findMany: usersFindMany,
        },
        workspaces: {
          findFirst: async () => ({ id: WS }),
        },
        workspaceMembers: {
          findFirst: async () => h.memberAnswers.shift(),
        },
      },
      insert: () => ({
        values: async (v: Record<string, unknown>) => {
          h.inserts.push(v);
        },
      }),
      update: () => ({ set: () => ({ where: async () => undefined }) }),
    },
  };
});

const { registerSetupRoutes } = await import("./setup.js");

const connect = (body: Record<string, unknown>) => {
  const app = new OpenAPIHono();
  registerSetupRoutes(app as never);
  return app.request("/setup/agent", {
    method: "POST",
    headers: {
      authorization: "Bearer synap_hub_not_a_jwt",
      "content-type": "application/json",
    },
    body: JSON.stringify({ agentType: "claude-code", ...body }),
  });
};

const everywhere = { workspaceIds: null as string[] | null };

/** The calling key: held by `person`, with `scope`. */
function key(person: string, scope: string[]) {
  validateApiKey.mockResolvedValue({
    id: "caller-key",
    userId: person,
    linkedUserId: null,
    isActive: true,
    scope,
  });
  resolveKeyIdentity.mockResolvedValue({
    effectiveUserId: person,
    isAgent: false,
  });
}

beforeEach(() => {
  delete process.env.PROVISIONING_TOKEN;
  for (const m of [
    validateApiKey,
    resolveKeyIdentity,
    provisionSurfaceAgentKey,
    fileAgentConnectProposal,
    liveGrantsOfKey,
    attachGrantsOrRevoke,
    revokeApiKeys,
    usersFindMany,
  ])
    m.mockReset();
  h.podAdmins = new Set([ADMIN]);
  h.memberAnswers = [];
  h.inserts = [];
  everywhere.workspaceIds = null;
  usersFindMany.mockResolvedValue([
    { id: VICTIM, email: VICTIM_EMAIL, name: "Victim" },
    { id: ADMIN, email: "admin@example.test", name: "Admin" },
  ]);
  liveGrantsOfKey.mockImplementation(async () => [
    {
      permissions: ["*"],
      workspaceIds: everywhere.workspaceIds,
      projectIds: null,
      entityIds: null,
      expiresAt: null,
    },
  ]);
  provisionSurfaceAgentKey.mockImplementation(
    async (opts: { onAgentUserResolved?: (id: string) => Promise<void> }) => {
      await opts.onAgentUserResolved?.(NEW_AGENT);
      return {
        agentUserId: NEW_AGENT,
        registration: { outcome: "CONNECTED_VERIFIED" },
        apiKey: { id: "new-key", expiresAt: null },
        plainKey: "synap_hub_new",
      };
    }
  );
  fileAgentConnectProposal.mockResolvedValue({ proposalId: "prop-1" });
});

describe("F7 — a setup.agent key acts for another human only for a pod admin", () => {
  it("a MEMBER's setup.agent key naming the victim by email mints nothing", async () => {
    key(MEMBER, ["setup.agent"]);
    const res = await connect({ linkedUserId: VICTIM_EMAIL });
    expect(res.status).toBe(401);
    expect(provisionSurfaceAgentKey).not.toHaveBeenCalled();
  });

  it("with hub-protocol.write too it is an ordinary key: the agent is the MEMBER's own, pending approval", async () => {
    key(MEMBER, ["setup.agent", "hub-protocol.write"]);
    const res = await connect({ linkedUserId: VICTIM_EMAIL });
    expect(res.status).toBe(200);
    expect(provisionSurfaceAgentKey).toHaveBeenCalledWith(
      expect.objectContaining({
        linkedUserId: MEMBER,
        pendingApproval: true,
      })
    );
    expect(provisionSurfaceAgentKey).not.toHaveBeenCalledWith(
      expect.objectContaining({ linkedUserId: VICTIM })
    );
  });

  it("control: a pod admin's setup.agent key binds the named human", async () => {
    key(ADMIN, ["setup.agent"]);
    await connect({ linkedUserId: VICTIM_EMAIL });
    expect(provisionSurfaceAgentKey).toHaveBeenCalledWith(
      expect.objectContaining({
        linkedUserId: VICTIM,
        pendingApproval: false,
      })
    );
  });
});

describe("F6 — a surface key never looks up humans", () => {
  it.each(["x", VICTIM_EMAIL, "Victim"])(
    "linkedUserId %j: no lookup, no candidate list, the key's own person",
    async (named) => {
      key(MEMBER, ["hub-protocol.write"]);
      const res = await connect({ linkedUserId: named });
      expect(res.status).toBe(200);
      expect(usersFindMany).not.toHaveBeenCalled();
      expect(await res.text()).not.toContain(VICTIM_EMAIL);
      expect(provisionSurfaceAgentKey).toHaveBeenCalledWith(
        expect.objectContaining({ linkedUserId: MEMBER })
      );
    }
  );
});

describe("F5 — a surface key adds its AI only to a space its person administers", () => {
  it("not a member: the same 404 as a missing space, nothing minted or inserted", async () => {
    key(MEMBER, ["hub-protocol.write"]);
    h.memberAnswers = [undefined];
    const res = await connect({ workspaceId: WS });
    expect(res.status).toBe(404);
    expect(provisionSurfaceAgentKey).not.toHaveBeenCalled();
    expect(h.inserts).toEqual([]);
  });

  it("an editor: 403, nothing minted", async () => {
    key(MEMBER, ["hub-protocol.write"]);
    h.memberAnswers = [{ role: "editor" }];
    const res = await connect({ workspaceId: WS });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("WORKSPACE_ADMIN_REQUIRED");
    expect(provisionSurfaceAgentKey).not.toHaveBeenCalled();
  });

  it("an admin whose key is confined to another space: 403, nothing minted", async () => {
    key(MEMBER, ["hub-protocol.write"]);
    everywhere.workspaceIds = [OTHER_WS];
    h.memberAnswers = [{ role: "admin" }];
    const res = await connect({ workspaceId: WS });
    expect(res.status).toBe(403);
    expect(provisionSurfaceAgentKey).not.toHaveBeenCalled();
  });

  it("an admin of a space with NO owner row: the agent joins as editor, no human is written in as owner", async () => {
    key(MEMBER, ["hub-protocol.write"]);
    // caller's membership, the owner lookup (none), the agent's existing row (none)
    h.memberAnswers = [{ role: "admin" }, undefined, undefined];
    const res = await connect({ workspaceId: WS });
    expect(res.status).toBe(200);
    expect(h.inserts).toEqual([
      expect.objectContaining({ userId: NEW_AGENT, role: "editor" }),
    ]);
  });

  it("control: the space's owner adds the agent", async () => {
    key(MEMBER, ["hub-protocol.write"]);
    h.memberAnswers = [{ role: "owner" }, { userId: MEMBER }, undefined];
    const res = await connect({ workspaceId: WS });
    expect(res.status).toBe(200);
    expect(provisionSurfaceAgentKey).toHaveBeenCalled();
    expect(h.inserts).toEqual([
      expect.objectContaining({
        workspaceId: WS,
        userId: NEW_AGENT,
        role: "editor",
      }),
    ]);
  });
});
