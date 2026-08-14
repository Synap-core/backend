/**
 * governanceCeilings gating — a ceiling TIGHTENS governance, so creating or
 * revoking one is itself gated (see file header of governance-ceilings.ts).
 * Mirrors governance-rules.gating.test.ts. Exercises the three gates without a
 * live PG:
 *   - a workspace-scope ceiling requires editor+ membership in that workspace
 *   - a pod-scope (global) ceiling requires pod-admin
 *   - an agent-scoped ceiling the caller doesn't own is denied
 * The FLOOR under test: a non-admin/non-owner must NOT be able to author a
 * ceiling for a workspace/agent they don't control.
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
          findFirst: async () => undefined as { role: string } | undefined,
        },
        users: { findFirst: async () => undefined },
        governanceCeilings: {
          findFirst: async () => undefined,
          findMany: async () => [],
        },
      },
      insert: () => ({
        values: (v: Record<string, unknown>) => ({
          returning: async () => {
            h.insertedValues.push(v);
            return [{ id: "ceiling-1", ...v }];
          },
        }),
      }),
      update: () => ({
        set: () => ({
          where: () => ({
            returning: async () => [{ id: "ceiling-1", revokedAt: new Date() }],
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
import { governanceCeilingsRouter } from "./governance-ceilings.js";
import type { Context } from "../types/context.js";

function caller(userId: string) {
  return governanceCeilingsRouter.createCaller({
    authenticated: true,
    userId,
    workspaceId: WORKSPACE_ID,
  } as unknown as Context);
}

function setMembership(lookup: () => Promise<{ role: string } | undefined>) {
  (db.query.workspaceMembers as unknown as { findFirst: unknown }).findFirst =
    lookup;
}

beforeEach(() => {
  h.insertedValues.length = 0;
});

describe("governanceCeilings.create gating", () => {
  it("allows a workspace-scope ceiling from an editor of that workspace", async () => {
    (db.query.workspaces as unknown as { findFirst: unknown }).findFirst =
      async () => undefined; // no pod-admin workspace -> isPodAdmin() = false
    setMembership(async () => ({ role: "editor" }));

    const result = await caller(OWNER_ID).create({
      principalKind: "any",
      scopeKind: "workspace",
      workspaceId: WORKSPACE_ID,
      limitValue: 200,
    });

    expect(result.ceiling).toMatchObject({ id: "ceiling-1" });
    expect(h.insertedValues).toHaveLength(1);
    expect(h.insertedValues[0]).toMatchObject({
      axis: "daily_write_count",
      limitValue: 200,
    });
  });

  it("denies a workspace-scope ceiling from a non-editor", async () => {
    (db.query.workspaces as unknown as { findFirst: unknown }).findFirst =
      async () => undefined;
    setMembership(async () => ({ role: "viewer" }));

    await expect(
      caller(OUTSIDER_ID).create({
        principalKind: "any",
        scopeKind: "workspace",
        workspaceId: WORKSPACE_ID,
        limitValue: 200,
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("denies a pod-scope (global) ceiling from a non-pod-admin", async () => {
    (db.query.workspaces as unknown as { findFirst: unknown }).findFirst =
      async () => ({ id: POD_ADMIN_WS_ID });
    setMembership(async () => undefined); // not a member of pod-admin ws

    await expect(
      caller(OUTSIDER_ID).create({
        principalKind: "any",
        scopeKind: "pod",
        limitValue: 200,
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("allows a pod-scope (global) ceiling from a pod-admin", async () => {
    (db.query.workspaces as unknown as { findFirst: unknown }).findFirst =
      async () => ({ id: POD_ADMIN_WS_ID });
    setMembership(async () => ({ role: "admin" }));

    const result = await caller(POD_ADMIN_ID).create({
      principalKind: "any",
      scopeKind: "pod",
      limitValue: 200,
    });

    expect(result.ceiling).toMatchObject({ id: "ceiling-1" });
  });

  it("denies an agent-scoped ceiling for an agent the caller does not own", async () => {
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
        limitValue: 50,
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("allows an agent-scoped ceiling for an agent the caller owns", async () => {
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
      limitValue: 50,
    });

    expect(result.ceiling).toMatchObject({ id: "ceiling-1" });
  });
});

describe("governanceCeilings.revoke gating", () => {
  it("denies revoking a pod-scope ceiling from a non-pod-admin", async () => {
    // The row loaded by revoke is a pod-scope ceiling; revoking it re-runs the
    // same assertCanManageCeiling → pod-admin required.
    const CEILING_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    (
      db.query as unknown as {
        governanceCeilings: { findFirst: unknown };
      }
    ).governanceCeilings.findFirst = async () => ({
      id: CEILING_ID,
      scopeKind: "pod",
      principalKind: "any",
      workspaceId: null,
      agentUserId: null,
      revokedAt: null,
    });
    (db.query.workspaces as unknown as { findFirst: unknown }).findFirst =
      async () => ({ id: POD_ADMIN_WS_ID });
    setMembership(async () => undefined); // not a member of the pod-admin ws

    await expect(
      caller(OUTSIDER_ID).revoke({ id: CEILING_ID })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
