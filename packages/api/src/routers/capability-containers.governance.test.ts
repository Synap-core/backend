/**
 * capability-containers.ts governance — `containers.create` and `containers.addPart`
 * are the doors that create a capability container ("Google") and attach parts
 * (tools/skills) to it. They are human-only today, so an ungoverned direct
 * `db.insert` was latent — this proves both now route through
 * `checkPermissionOrPropose()`, the SAME gate `tools.create` uses:
 *
 *  1. An AGENT caller is gated — on "proposed" NOTHING is written.
 *  2. A gate denial is FORBIDDEN, not a silent write.
 *  3. An OPERATOR caller (granted) still writes, unchanged.
 *  4. `status: "proposed"` is returned verbatim as a SUCCESS shape, never thrown.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  gateCalls: [] as Array<Record<string, unknown>>,
  gateResult: { granted: true } as Record<string, unknown>,
  insertedCapabilities: [] as Array<Record<string, unknown>>,
  insertedLinks: [] as Array<Record<string, unknown>>,
  capabilityRow: {
    id: "cap-1",
    workspaceId: "11111111-1111-4111-8111-111111111111",
    createdBy: "user-1",
    name: "Google",
  } as Record<string, unknown> | null,
  partRow: { id: "part-1" } as Record<string, unknown> | null,
}));

// Schema tables are plain identity markers — only used for reference equality
// inside the mocked query builder below, never for real column introspection.
// Hoisted (with `h`) since vi.mock factories run before top-level `const`s.
const { capabilitiesTable, toolsTable, skillsTable, linksTable } = vi.hoisted(
  () => ({
    capabilitiesTable: { __table: "capabilities" },
    toolsTable: { __table: "tools" },
    skillsTable: { __table: "skills" },
    linksTable: { __table: "links" },
  })
);

vi.mock("@synap/database/schema", () => ({
  capabilities: capabilitiesTable,
  tools: toolsTable,
  skills: skillsTable,
  links: linksTable,
}));

vi.mock("@synap/database", () => ({
  db: {
    select: vi.fn(() => ({
      from: (table: unknown) => ({
        where: async () => {
          if (table === capabilitiesTable) {
            return h.capabilityRow ? [h.capabilityRow] : [];
          }
          if (table === toolsTable || table === skillsTable) {
            return h.partRow ? [h.partRow] : [];
          }
          return [];
        },
      }),
    })),
    insert: vi.fn((table: unknown) => ({
      values: (v: Record<string, unknown>) => {
        if (table === capabilitiesTable) {
          h.insertedCapabilities.push(v);
          return {
            returning: async () => [{ id: "new-cap-1", ...v }],
          };
        }
        if (table === linksTable) {
          h.insertedLinks.push(v);
          return { onConflictDoNothing: async () => undefined };
        }
        return { returning: async () => [v] };
      },
    })),
  },
  eq: vi.fn((a, b) => ({ op: "eq", a, b })),
  and: vi.fn((...c) => ({ op: "and", c })),
  or: vi.fn((...c) => ({ op: "or", c })),
  isNull: vi.fn((a) => ({ op: "isNull", a })),
  inArray: vi.fn((a, b) => ({ op: "inArray", a, b })),
  desc: vi.fn((a) => ({ op: "desc", a })),
}));

vi.mock("../utils/permission-check.js", () => ({
  checkPermissionOrPropose: async (opts: Record<string, unknown>) => {
    h.gateCalls.push(opts);
    return h.gateResult;
  },
}));

vi.mock("../utils/user-scoped.js", () => ({
  requireUserId: (id: string | undefined) => id ?? "user-1",
}));

vi.mock("../utils/user-visible-where.js", () => ({
  userVisibleWhere: vi.fn(() => ({ op: "userVisibleWhere" })),
}));

vi.mock("../utils/workspace-write-access.js", () => ({
  assertWorkspaceWrite: vi.fn(async () => undefined),
}));

vi.mock("../utils/workspace-role.js", () => ({
  getWorkspaceRole: vi.fn(async () => "owner"),
  requirePodAdmin: vi.fn(async () => undefined),
}));

vi.mock("../services/capabilities/uninstall-capability.js", () => ({
  uninstallCapability: vi.fn(async () => ({ deleted: {} })),
}));

// protectedProcedure's two DB-touching middlewares — stubbed so the router
// can be exercised without a live PG (mirrors automations.trigger-governance.test.ts).
vi.mock("../middleware/read-only-guard.js", async () => {
  const { t } = await import("../init-trpc.js");
  return { readOnlyGuardMiddleware: t.middleware(({ next }) => next()) };
});

vi.mock("../middleware/audit-log.js", async () => {
  const { t } = await import("../init-trpc.js");
  return { auditLogMiddleware: t.middleware(({ next }) => next()) };
});

import { capabilityContainersRouter } from "./capability-containers.js";
import type { Context } from "../types/context.js";

const AGENT = "22222222-2222-4222-8222-222222222222";
const WS = "11111111-1111-4111-8111-111111111111";
const CAP_ID = "33333333-3333-4333-8333-333333333333";
const PART_ID = "44444444-4444-4444-8444-444444444444";

function caller(ctx: Partial<Context> = {}) {
  return capabilityContainersRouter.createCaller({
    authenticated: true,
    userId: "user-1",
    ...ctx,
  } as unknown as Context);
}

beforeEach(() => {
  h.gateCalls.length = 0;
  h.gateResult = { granted: true };
  h.insertedCapabilities.length = 0;
  h.insertedLinks.length = 0;
  h.capabilityRow = {
    id: "cap-1",
    workspaceId: WS,
    createdBy: "user-1",
    name: "Google",
  };
  h.partRow = { id: "part-1" };
});

describe("containers.create — agent caller is governed", () => {
  it("proposes instead of inserting", async () => {
    h.gateResult = {
      granted: false,
      proposalId: "proposal-1",
      proposalType: "capability.create",
      summary: 'Create capability "Google"',
      reasoning: "r",
      reviewPath: "/open/proposal-1",
      reviewUrl: "u",
    };

    const result = await caller().create({
      name: "Google",
      workspaceId: WS,
      agentUserId: AGENT,
    });

    expect(result).toMatchObject({
      capability: null,
      status: "proposed",
      proposalId: "proposal-1",
    });
    expect(h.insertedCapabilities).toHaveLength(0);
  });

  it("gates with {capability, create} carrying the agent + workspace", async () => {
    await caller().create({
      name: "Google",
      workspaceId: WS,
      agentUserId: AGENT,
    });

    expect(h.gateCalls).toHaveLength(1);
    expect(h.gateCalls[0]).toMatchObject({
      subjectType: "capability",
      action: "create",
      agentUserId: AGENT,
      workspaceId: WS,
    });
  });

  it("hard-denies (FORBIDDEN) without inserting when the gate denies", async () => {
    h.gateResult = { denied: true, reason: "Permission denied" };

    await expect(
      caller().create({ name: "Google", workspaceId: WS, agentUserId: AGENT })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(h.insertedCapabilities).toHaveLength(0);
  });

  it("inserts normally when the gate grants", async () => {
    const result = await caller().create({
      name: "Google",
      workspaceId: WS,
      agentUserId: AGENT,
    });

    expect(result).toMatchObject({ status: "created" });
    expect(result.capability).toMatchObject({
      id: "new-cap-1",
      name: "Google",
    });
    expect(h.insertedCapabilities).toHaveLength(1);
  });
});

describe("containers.create — operator caller is NOT regressed", () => {
  it("inserts directly and reports created", async () => {
    const result = await caller().create({ name: "Google", workspaceId: WS });

    expect(result.status).toBe("created");
    expect(h.insertedCapabilities).toHaveLength(1);
  });
});

describe("containers.addPart — agent caller is governed", () => {
  it("proposes instead of inserting the member_of link", async () => {
    h.gateResult = {
      granted: false,
      proposalId: "proposal-2",
      proposalType: "capability.attach",
      summary: "Attach part",
      reasoning: "r",
      reviewPath: "/open/proposal-2",
      reviewUrl: "u",
    };

    const result = await caller().addPart({
      capabilityId: CAP_ID,
      partType: "tool",
      partId: PART_ID,
      agentUserId: AGENT,
    });

    expect(result).toMatchObject({
      ok: false,
      status: "proposed",
      proposalId: "proposal-2",
    });
    // No link written — the part was NOT attached.
    expect(h.insertedLinks).toHaveLength(0);
  });

  it("gates with {capability, attach} on the capability's real workspace", async () => {
    await caller().addPart({
      capabilityId: CAP_ID,
      partType: "tool",
      partId: PART_ID,
      agentUserId: AGENT,
    });

    expect(h.gateCalls).toHaveLength(1);
    expect(h.gateCalls[0]).toMatchObject({
      subjectType: "capability",
      action: "attach",
      agentUserId: AGENT,
      workspaceId: WS,
    });
  });

  it("hard-denies (FORBIDDEN) without inserting when the gate denies", async () => {
    h.gateResult = { denied: true, reason: "Permission denied" };

    await expect(
      caller().addPart({
        capabilityId: CAP_ID,
        partType: "tool",
        partId: PART_ID,
        agentUserId: AGENT,
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(h.insertedLinks).toHaveLength(0);
  });

  it("attaches normally when the gate grants", async () => {
    const result = await caller().addPart({
      capabilityId: CAP_ID,
      partType: "tool",
      partId: PART_ID,
      agentUserId: AGENT,
    });

    expect(result).toMatchObject({ ok: true, status: "created" });
    expect(h.insertedLinks).toHaveLength(1);
  });
});

describe("containers.addPart — operator caller is NOT regressed", () => {
  it("attaches directly, still 404s when the capability is missing", async () => {
    h.capabilityRow = null;

    await expect(
      caller().addPart({
        capabilityId: CAP_ID,
        partType: "tool",
        partId: PART_ID,
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("attaches directly when granted", async () => {
    const result = await caller().addPart({
      capabilityId: CAP_ID,
      partType: "tool",
      partId: PART_ID,
    });

    expect(result).toMatchObject({ ok: true, status: "created" });
    expect(h.insertedLinks).toHaveLength(1);
  });
});
