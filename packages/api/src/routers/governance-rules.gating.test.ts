/**
 * governanceRules gating — a rule WIDENS or NARROWS governance, so creating
 * or revoking one is itself gated (see file header of governance-rules.ts).
 * Exercises the three gates without a live PG:
 *   - a workspace-scope rule requires editor+ membership in that workspace
 *   - a pod-scope (global) rule requires pod-admin
 *   - an agent-scoped rule the caller doesn't own is denied
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

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

import { db } from "@synap/database";
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
