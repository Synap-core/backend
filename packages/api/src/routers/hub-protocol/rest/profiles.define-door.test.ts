/**
 * Hub REST `POST /profiles` can define a KIND and a ROLE (with entity scope and
 * fields) through the SAME define door MCP `synap_define_kind` /
 * `synap_define_role` use — and an agent key is governed there.
 *
 * Drives the REAL route → real `getCaller` → real hub `profiles.createProfile`
 * → real `profiles.create` (reserved-slug refusal, role/applicableKinds rule,
 * gate call). Replaced: the DB (no existing slug), the audit log, and the
 * governance gate, which records what reached it.
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

const WS = "33333333-3333-4333-8333-333333333333";

const h = vi.hoisted(() => ({
  gateCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  const fakeDb = {
    query: {
      workspaceMembers: { findFirst: vi.fn(async () => ({ role: "owner" })) },
      workspaces: { findFirst: vi.fn(async () => ({ archivedAt: null })) },
    },
  };
  class FakeProfileRepository {
    async getBySlug() {
      return null;
    }
  }
  return {
    ...actual,
    db: fakeDb,
    getDb: vi.fn(async () => fakeDb),
    ProfileRepository: FakeProfileRepository,
  };
});

vi.mock("../../../utils/split-brain-service.js", () => ({
  isPodReadOnly: vi.fn().mockResolvedValue(false),
}));

vi.mock("../../../utils/audit-log.js", () => ({
  auditLog: vi.fn(async () => ({ id: "evt-1" })),
}));

vi.mock("../../../utils/permission-check.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    checkPermissionOrPropose: vi.fn(async (opts: Record<string, unknown>) => {
      h.gateCalls.push(opts);
      return { proposalId: "prop-profile", proposalType: "profile.create" };
    }),
  };
});

vi.mock("./_shared.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    // Membership + act-as lookups are DB reads; identity is not what this tests.
    resolveActingContext: vi.fn(async () => ({
      ok: true,
      userId: USER,
      workspaceId: WS,
      role: "owner",
    })),
    resolveActorId: vi.fn(
      async (agentUserId: string | undefined, userId: string) => ({
        actorId: agentUserId ?? userId,
      })
    ),
  };
});

const USER = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";

const { registerProfilesRoutes } = await import("./profiles.js");
const { capabilityHandlers } = await import("../../mcp/handlers/capability.js");
const { hubProtocolRouter } = await import("../index.js");
const { createHubProtocolCallerContext } = await import("../utils.js");

function appAs(agentUserId?: string) {
  const app = new OpenAPIHono();
  app.use("*", async (c, next) => {
    c.set("scopes" as never, ["hub-protocol.write"] as never);
    c.set("userId" as never, USER as never);
    if (agentUserId) c.set("agentUserId" as never, agentUserId as never);
    await next();
  });
  registerProfilesRoutes(app as never);
  return app;
}

async function postProfile(
  body: Record<string, unknown>,
  agentUserId?: string
) {
  const res = await appAs(agentUserId).request("/profiles", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId: USER, workspaceId: WS, ...body }),
  });
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
  };
}

beforeEach(() => {
  h.gateCalls.length = 0;
});

describe("POST /profiles — define a kind or a role through the shared door", () => {
  it("an agent key defining a KIND with fields gets `proposed`; fields deferred, the gate saw the agent", async () => {
    const { status, body } = await postProfile(
      {
        slug: "podcast",
        displayName: "Podcast",
        entityScope: "workspace",
        fields: [{ slug: "host", valueType: "string" }],
      },
      AGENT
    );
    expect(status).toBe(200);
    expect(body).toMatchObject({
      status: "proposed",
      proposalId: "prop-profile",
      properties: { status: "deferred", pending: 1 },
    });
    expect(h.gateCalls).toHaveLength(1);
    expect(h.gateCalls[0]).toMatchObject({
      agentUserId: AGENT,
      workspaceId: WS,
      subjectType: "profile",
      action: "create",
      data: { slug: "podcast", profileKind: "kind", entityScope: "workspace" },
    });
  });

  it("an agent key defining a ROLE reaches the gate as a role with its applicable kinds", async () => {
    const { status, body } = await postProfile(
      {
        slug: "sponsor",
        displayName: "Sponsor",
        profileKind: "role",
        applicableKinds: ["company"],
        roleCategory: "commercial",
      },
      AGENT
    );
    expect(status).toBe(200);
    expect(body).toMatchObject({ status: "proposed" });
    expect(h.gateCalls[0]).toMatchObject({
      agentUserId: AGENT,
      data: {
        slug: "sponsor",
        profileKind: "role",
        applicableKinds: ["company"],
      },
    });
  });

  it("fields that are not an array are a 400 before anything reaches the gate", async () => {
    const { status, body } = await postProfile(
      { slug: "podcast", displayName: "Podcast", fields: { host: "string" } },
      AGENT
    );
    expect(status).toBe(400);
    expect(String(body.error)).toContain("fields");
    expect(h.gateCalls).toEqual([]);
  });

  it("MCP synap_define_role and REST reach the gate with the SAME profile data (one door)", async () => {
    await postProfile(
      { slug: "mentor", displayName: "Mentor", profileKind: "role" },
      AGENT
    );
    const hubCaller = hubProtocolRouter.createCaller(
      (await createHubProtocolCallerContext(
        USER,
        ["hub-protocol.write"],
        WS
      )) as never
    );
    await capabilityHandlers.synap_define_role!({
      toolName: "synap_define_role",
      args: { slug: "mentor", displayName: "Mentor" },
      userId: USER,
      apiKeyScopes: ["mcp.write"],
      agentUserId: AGENT,
      caller: hubCaller as never,
      lensCaller: hubCaller as never,
      requestedWorkspaceId: WS,
      workspaceAccessible: true,
    });
    expect(h.gateCalls).toHaveLength(2);
    const strip = (call: Record<string, unknown>) => {
      const { id: _id, ...data } = call.data as Record<string, unknown>;
      return { agentUserId: call.agentUserId, data };
    };
    expect(strip(h.gateCalls[0])).toEqual(strip(h.gateCalls[1]));
    // The role default lives in the shared door, not in one door's handler.
    expect(
      (h.gateCalls[0].data as Record<string, unknown>).applicableKinds
    ).toEqual(["company", "person"]);
  });
});

describe("MCP synap_define_kind parentProfileSlug", () => {
  const PARENT_ID = "44444444-4444-4444-8444-444444444444";

  it("resolves parentProfileSlug → parentProfileId before defineProfile", async () => {
    const createProfile = vi.fn(async () => ({
      status: "proposed",
      proposalId: "prop-kind",
    }));
    const listProfiles = vi.fn(async () => ({
      profiles: [{ id: PARENT_ID, slug: "note" }],
    }));
    const result = await capabilityHandlers.synap_define_kind!({
      toolName: "synap_define_kind",
      args: {
        slug: "journal",
        displayName: "Journal",
        parentProfileSlug: "note",
      },
      userId: USER,
      apiKeyScopes: ["mcp.write"],
      agentUserId: AGENT,
      caller: { profiles: { listProfiles, createProfile } } as never,
      lensCaller: {} as never,
      requestedWorkspaceId: WS,
      workspaceAccessible: true,
    });
    const body = JSON.parse(
      (result.content[0] as { text: string }).text
    ) as Record<string, unknown>;
    expect(body.status).toBe("proposed");
    expect(listProfiles).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER,
        workspaceId: WS,
        profileSlugs: ["note"],
      })
    );
    expect(createProfile).toHaveBeenCalledWith(
      expect.objectContaining({ parentProfileId: PARENT_ID, slug: "journal" })
    );
  });

  it("refuses an unknown parent slug without calling defineProfile", async () => {
    const createProfile = vi.fn();
    const listProfiles = vi.fn(async () => ({ profiles: [] }));
    const result = await capabilityHandlers.synap_define_kind!({
      toolName: "synap_define_kind",
      args: {
        slug: "journal",
        displayName: "Journal",
        parentProfileSlug: "does-not-exist",
      },
      userId: USER,
      apiKeyScopes: ["mcp.write"],
      agentUserId: AGENT,
      caller: { profiles: { listProfiles, createProfile } } as never,
      lensCaller: {} as never,
      requestedWorkspaceId: WS,
      workspaceAccessible: true,
    });
    const body = JSON.parse(
      (result.content[0] as { text: string }).text
    ) as Record<string, unknown>;
    expect(String(body.error)).toContain("does-not-exist");
    expect(createProfile).not.toHaveBeenCalled();
  });
});
