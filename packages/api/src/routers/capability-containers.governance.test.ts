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
  /** Whether the caller passes `requirePodAdmin` — addPart's pod-scope floor. */
  isPodAdmin: false,
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

// NOT a no-op stub: it REPRODUCES the real pod-wide rule
// (workspace-write-access.ts — "allow only the owner, if there is one") so the
// tests assert an OUTCOME (throws / nothing written) rather than that a mock was
// called. A no-op here is exactly what let a MISSING floor pass this file green.
// This is `removePart`'s / `delete`'s floor; `addPart`'s pod floor is
// `requirePodAdmin` (below) — the two must stay distinguishable, since the
// attach/detach asymmetry is what exposed the original hole.
vi.mock("../utils/workspace-write-access.js", async () => {
  const { TRPCError } = await import("@trpc/server");
  return {
    assertWorkspaceWrite: vi.fn(
      async (
        _db: unknown,
        userId: string,
        row: { workspaceId: string | null; ownerId?: string | null }
      ) => {
        if (row.workspaceId === null && row.ownerId !== userId) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Only the owner can modify this pod-wide resource.",
          });
        }
      }
    ),
  };
});

// `requirePodAdmin` is the pod-scope half of `addPart`'s floor, so — like
// `assertWorkspaceWrite` below — it must REFUSE, not resolve. A no-op here would
// make the floor untestable in exactly the direction that matters.
vi.mock("../utils/workspace-role.js", async () => {
  const { TRPCError } = await import("@trpc/server");
  return {
    getWorkspaceRole: vi.fn(async () => "owner"),
    requirePodAdmin: vi.fn(async () => {
      if (!h.isPodAdmin) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Pod admin required.",
        });
      }
    }),
  };
});

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

import { uninstallCapability } from "../services/capabilities/uninstall-capability.js";
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
  h.isPodAdmin = false;
  vi.mocked(uninstallCapability).mockClear();
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

/**
 * The governance gate is NOT an authorization floor at pod scope.
 * `checkPermissionOrPropose` performs workspace-membership RBAC only when a
 * workspace lens is present — at pod scope it explicitly does none ("the
 * authenticated bearer is the owner"). So for a pod-wide container these tests
 * are the ONLY thing standing between any authenticated pod member and silently
 * changing what someone else's bundle grants. `removePart` never lost this floor,
 * which is why its absence on `addPart` produced the tell: you could attach to a
 * container you were not allowed to detach from.
 */
describe("containers.addPart — pod-wide floor beneath the gate", () => {
  it("refuses a non-owner who is NOT a pod admin, writing nothing", async () => {
    h.capabilityRow = {
      id: "cap-1",
      workspaceId: null, // pod-wide → the gate does no RBAC at all
      createdBy: "someone-else",
      name: "Google",
    };

    await expect(
      caller().addPart({
        capabilityId: CAP_ID,
        partType: "tool",
        partId: PART_ID,
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(h.insertedLinks).toHaveLength(0);
  });

  /**
   * Owner-only was too narrow and BROKE INSTALL: `create-from-definition`
   * resolves an existing container by NAME + scope, never by creator, so the
   * second installer of a pod-scoped capability is routinely not its `createdBy`.
   * Pod admin is the same floor `containers.delete` already applies at pod scope.
   */
  it("lets a POD ADMIN attach to a pod-wide container they do not own", async () => {
    h.isPodAdmin = true;
    h.capabilityRow = {
      id: "cap-1",
      workspaceId: null,
      createdBy: "someone-else",
      name: "Google",
    };

    const result = await caller().addPart({
      capabilityId: CAP_ID,
      partType: "tool",
      partId: PART_ID,
    });

    expect(result).toMatchObject({ ok: true, status: "created" });
    expect(h.insertedLinks).toHaveLength(1);
  });

  it("lets the OWNER attach to their own pod-wide container", async () => {
    h.capabilityRow = {
      id: "cap-1",
      workspaceId: null,
      createdBy: "user-1",
      name: "Google",
    };

    const result = await caller().addPart({
      capabilityId: CAP_ID,
      partType: "tool",
      partId: PART_ID,
    });

    expect(result).toMatchObject({ ok: true, status: "created" });
    expect(h.insertedLinks).toHaveLength(1);
  });

  it("does NOT apply the owner floor to a workspace-scoped container", async () => {
    // Workspace rows are the gate's job. Double-gating here would hard-deny a
    // non-owner MEMBER who is perfectly entitled, and would kill the agent's
    // "ask to join" proposal path.
    h.capabilityRow = {
      id: "cap-1",
      workspaceId: WS,
      createdBy: "someone-else",
      name: "Google",
    };

    const result = await caller().addPart({
      capabilityId: CAP_ID,
      partType: "tool",
      partId: PART_ID,
    });

    expect(result).toMatchObject({ ok: true, status: "created" });
    expect(h.insertedLinks).toHaveLength(1);
  });
});

/**
 * The SAME pod floor on the destructive side. `delete` cascades (it routes
 * through `uninstallCapability`, dropping orphaned member tools/skills), so an
 * unfloored pod branch here is strictly worse than the `addPart` hole was.
 * Untested until now — every other case in this file uses a workspace-scoped
 * fixture and never reaches `requirePodAdmin`.
 */
describe("containers.delete — pod floor on the destructive path", () => {
  it("refuses a non-pod-admin and deletes nothing", async () => {
    h.capabilityRow = {
      id: "cap-1",
      workspaceId: null,
      createdBy: "someone-else",
      name: "Google",
    };

    await expect(caller().delete({ id: CAP_ID })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(uninstallCapability).not.toHaveBeenCalled();
  });

  it("refuses even the CREATOR when they are not a pod admin", async () => {
    // Deliberately unlike `addPart`, which short-circuits on `createdBy`.
    // Delete cascades, so it holds the stricter floor — pin that difference.
    h.capabilityRow = {
      id: "cap-1",
      workspaceId: null,
      createdBy: "user-1",
      name: "Google",
    };

    await expect(caller().delete({ id: CAP_ID })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(uninstallCapability).not.toHaveBeenCalled();
  });

  it("lets a pod admin delete a pod-wide container", async () => {
    h.isPodAdmin = true;
    h.capabilityRow = {
      id: "cap-1",
      workspaceId: null,
      createdBy: "someone-else",
      name: "Google",
    };

    const result = await caller().delete({ id: CAP_ID });
    expect(result).toMatchObject({ ok: true });
    expect(uninstallCapability).toHaveBeenCalled();
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
