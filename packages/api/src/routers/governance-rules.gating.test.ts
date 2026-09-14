/**
 * governanceRules gating — a rule WIDENS or NARROWS governance, so creating
 * or revoking one is itself gated (see file header of governance-rules.ts).
 * Exercises the three gates without a live PG:
 *   - a workspace-scope rule requires editor+ membership in that workspace
 *   - a pod-scope (global) rule requires pod-admin
 *   - an agent-scoped rule the caller doesn't own is denied
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const POD_ADMIN_WS_ID = "99999999-9999-4999-8999-999999999999";
const OWNER_ID = "user-owner";
const OUTSIDER_ID = "user-outsider";
const POD_ADMIN_ID = "user-podadmin";
const OWNED_AGENT_ID = "agent-owned";

const h = vi.hoisted(() => ({
  insertedValues: [] as Record<string, unknown>[],
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();

  return {
    ...actual,
    db: {
      query: {
        workspaces: {
          findFirst: async () => ({ id: POD_ADMIN_WS_ID }),
        },
        workspaceMembers: {
          // Overridden per-test via `setMembership` below — the real query is
          // `and(eq(workspaceId, X), eq(userId, Y))`, which we can't evaluate
          // against drizzle SQL args at this layer.
          findFirst: async () => undefined as { role: string } | undefined,
        },
        users: { findFirst: async () => undefined },
        governanceRules: {
          findFirst: async () => undefined,
          findMany: async () => [],
        },
      },
      insert: () => ({
        values: (v: Record<string, unknown>) => ({
          returning: async () => {
            h.insertedValues.push(v);
            return [{ id: "rule-1", ...v }];
          },
        }),
      }),
      update: () => ({
        set: () => ({
          where: () => ({
            returning: async () => [{ id: "rule-1", revokedAt: new Date() }],
          }),
        }),
      }),
      select: () => ({
        from: () => ({ where: async () => [] }),
      }),
    },
  };
});

vi.mock("../middleware/read-only-guard.js", async () => {
  const { t } = await import("../init-trpc.js");
  return { readOnlyGuardMiddleware: t.middleware(({ next }) => next()) };
});

vi.mock("../middleware/audit-log.js", async () => {
  const { t } = await import("../init-trpc.js");
  return { auditLogMiddleware: t.middleware(({ next }) => next()) };
});

import { db, classifyRuleProvenance, createdByUserId } from "@synap/database";
import { governanceRulesRouter } from "./governance-rules.js";
import type { Context } from "../types/context.js";

function caller(userId: string) {
  return governanceRulesRouter.createCaller({
    authenticated: true,
    userId,
    workspaceId: WORKSPACE_ID,
  } as unknown as Context);
}

// Route the mocked workspaceMembers.findFirst by inspecting which (workspace,
// user) pair a test is exercising — set per-test via this handle.
function setMembership(lookup: () => Promise<{ role: string } | undefined>) {
  (db.query.workspaceMembers as unknown as { findFirst: unknown }).findFirst =
    lookup;
}

beforeEach(() => {
  h.insertedValues.length = 0;
});

describe("governanceRules.create gating", () => {
  it("allows a workspace-scope rule from an editor of that workspace", async () => {
    (db.query.workspaces as unknown as { findFirst: unknown }).findFirst =
      async () => undefined; // no pod-admin workspace configured -> isPodAdmin() = false
    setMembership(async () => ({ role: "editor" }));

    const result = await caller(OWNER_ID).create({
      principalKind: "any",
      scopeKind: "workspace",
      workspaceId: WORKSPACE_ID,
      targetKind: "capability",
      targetPattern: "some.capability",
      verdict: "auto",
    });

    expect(result.rule).toMatchObject({ id: "rule-1" });
    expect(h.insertedValues).toHaveLength(1);
  });

  it("stamps PROVENANCE so an editor-authored rule classifies as 'authored' (and the human id survives)", async () => {
    // This is the ONLY door where a human authors a rule directly, so it is the
    // only one allowed to stamp `user:`. The settings MIRROR
    // (`syncAutoApproveRules`) stamps `system:settings-mirror:<id>` — before
    // both markers existed the two were byte-identical bare user ids, and a
    // machine-minted grant reported "the operator authored this deliberately".
    //
    // BITE PROOF: revert the router to `createdBy: ctx.userId` and the inserted
    // row classifies as "unknown" → both assertions fail. (Driven through the
    // real router + real classifier — no source-text assertion.)
    (db.query.workspaces as unknown as { findFirst: unknown }).findFirst =
      async () => undefined;
    setMembership(async () => ({ role: "editor" }));

    await caller(OWNER_ID).create({
      principalKind: "any",
      scopeKind: "workspace",
      workspaceId: WORKSPACE_ID,
      targetKind: "action",
      // Not `profile.create`: that key is behind the rung-2.08 floor, so an
      // `auto` rule on it is refused (see the non-widenable describe below).
      targetPattern: "property_def.create",
      verdict: "auto",
    });

    const row = h.insertedValues[0] as {
      createdBy: string;
      sourceProposalId: string | null;
    };
    expect(classifyRuleProvenance(row)).toBe("authored");
    expect(createdByUserId(row.createdBy)).toBe(OWNER_ID);
  });

  it("denies a workspace-scope rule from a non-editor", async () => {
    (db.query.workspaces as unknown as { findFirst: unknown }).findFirst =
      async () => undefined;
    setMembership(async () => ({ role: "viewer" }));

    await expect(
      caller(OUTSIDER_ID).create({
        principalKind: "any",
        scopeKind: "workspace",
        workspaceId: WORKSPACE_ID,
        targetKind: "capability",
        targetPattern: "some.capability",
        verdict: "auto",
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("denies a pod-scope (global) rule from a non-pod-admin", async () => {
    (db.query.workspaces as unknown as { findFirst: unknown }).findFirst =
      async () => ({ id: POD_ADMIN_WS_ID });
    setMembership(async () => undefined); // not a member of pod-admin ws

    await expect(
      caller(OUTSIDER_ID).create({
        principalKind: "any",
        scopeKind: "pod",
        targetKind: "action",
        targetPattern: "*",
        verdict: "auto",
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("allows a pod-scope (global) rule from a pod-admin", async () => {
    (db.query.workspaces as unknown as { findFirst: unknown }).findFirst =
      async () => ({ id: POD_ADMIN_WS_ID });
    setMembership(async () => ({ role: "admin" }));

    const result = await caller(POD_ADMIN_ID).create({
      principalKind: "any",
      scopeKind: "pod",
      targetKind: "action",
      targetPattern: "*",
      verdict: "auto",
    });

    expect(result.rule).toMatchObject({ id: "rule-1" });
  });

  it("denies an agent-scoped rule for an agent the caller does not own", async () => {
    (db.query.workspaces as unknown as { findFirst: unknown }).findFirst =
      async () => undefined;
    setMembership(async () => ({ role: "editor" }));
    (db.query.users as unknown as { findFirst: unknown }).findFirst =
      async () => ({ createdByUserId: OWNER_ID });

    await expect(
      caller(OUTSIDER_ID).create({
        principalKind: "agent",
        agentUserId: OWNED_AGENT_ID, // owned by OWNER_ID, not OUTSIDER_ID
        scopeKind: "workspace",
        workspaceId: WORKSPACE_ID,
        targetKind: "capability",
        targetPattern: "some.capability",
        verdict: "auto",
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("allows an agent-scoped rule for an agent the caller owns", async () => {
    (db.query.workspaces as unknown as { findFirst: unknown }).findFirst =
      async () => undefined;
    setMembership(async () => ({ role: "editor" }));
    (db.query.users as unknown as { findFirst: unknown }).findFirst =
      async () => ({ createdByUserId: OWNER_ID });

    const result = await caller(OWNER_ID).create({
      principalKind: "agent",
      agentUserId: OWNED_AGENT_ID,
      scopeKind: "workspace",
      workspaceId: WORKSPACE_ID,
      targetKind: "capability",
      targetPattern: "some.capability",
      verdict: "auto",
    });

    expect(result.rule).toMatchObject({ id: "rule-1" });
  });
});

describe("governanceRules.create — a rule that can never fire is refused (B3)", () => {
  beforeEach(() => {
    (db.query.workspaces as unknown as { findFirst: unknown }).findFirst =
      async () => undefined;
    setMembership(async () => ({ role: "editor" }));
  });

  it("refuses an `auto` rule on agent profile.create (rung 2.08) and stores nothing", async () => {
    await expect(
      caller(OWNER_ID).create({
        principalKind: "any",
        scopeKind: "workspace",
        workspaceId: WORKSPACE_ID,
        targetKind: "action",
        targetPattern: "profile.create",
        verdict: "auto",
      })
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("AGENT_SCHEMA_DEFINITION"),
    });
    expect(h.insertedValues).toHaveLength(0);
  });

  it("still stores a widenable exact key, a glob over the floored key, and a `propose` rule on it", async () => {
    for (const [targetPattern, verdict] of [
      ["property_def.create", "auto"],
      ["profile.*", "auto"],
      ["profile.create", "propose"],
    ] as const) {
      await caller(OWNER_ID).create({
        principalKind: "any",
        scopeKind: "workspace",
        workspaceId: WORKSPACE_ID,
        targetKind: "action",
        targetPattern,
        verdict,
      });
    }
    expect(h.insertedValues).toHaveLength(3);
  });
});

describe("governanceRules.revoke — a connection rule is the owner's consent", () => {
  const CONNECTION_ID = "secret-row-1";
  const connectionRule = {
    id: "33333333-3333-4333-8333-333333333333",
    principalKind: "any",
    agentUserId: null,
    scopeKind: "workspace",
    workspaceId: WORKSPACE_ID,
    targetKind: "connection",
    targetPattern: CONNECTION_ID,
    verdict: "auto",
    revokedAt: null,
  };

  function given(opts: { podAdmin: boolean; connectionOwner: string | null }) {
    (db.query.workspaces as unknown as { findFirst: unknown }).findFirst =
      async () => (opts.podAdmin ? { id: POD_ADMIN_WS_ID } : undefined);
    setMembership(async () => ({ role: "admin" }));
    (db.query.governanceRules as unknown as { findFirst: unknown }).findFirst =
      async () => connectionRule;
    (db.query as unknown as Record<string, unknown>).secrets = {
      findFirst: async () =>
        opts.connectionOwner ? { userId: opts.connectionOwner } : undefined,
    };
    return vi.spyOn(db, "update");
  }

  // Restored even when an assertion throws, so no spy carries calls across cases.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a pod admin cannot revoke another member's connection rule", async () => {
    const update = given({ podAdmin: true, connectionOwner: OWNER_ID });
    await expect(
      caller(POD_ADMIN_ID).revoke({ id: connectionRule.id })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(update).not.toHaveBeenCalled();
  });

  it("the connection's owner revokes it", async () => {
    const update = given({ podAdmin: false, connectionOwner: OWNER_ID });
    const result = await caller(OWNER_ID).revoke({ id: connectionRule.id });
    expect(result.rule).toMatchObject({ id: "rule-1" });
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("a rule whose connection row does not exist is NOT_FOUND, not revoked", async () => {
    const update = given({ podAdmin: true, connectionOwner: null });
    await expect(
      caller(POD_ADMIN_ID).revoke({ id: connectionRule.id })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(update).not.toHaveBeenCalled();
  });
});
