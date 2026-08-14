/**
 * agentUsers.create pod-wide gating — minting a POD-WIDE agent (no workspace
 * membership, visible in every workspace) is a pod-level action, so it is gated
 * by assertPodAdmin, and the scope shape is validated up front. Mirrors
 * governance-ceilings.gating.test.ts; exercises the gates without a live PG.
 *
 * FLOOR under test: a non-pod-admin must NOT be able to mint a pod-wide agent,
 * and a pod-wide create must never write a workspace_members row (that absence
 * is exactly what marks the agent pod-wide in `list`).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const POD_ADMIN_WS_ID = "99999999-9999-4999-8999-999999999999";
const POD_ADMIN_ID = "user-podadmin";
const OUTSIDER_ID = "user-outsider";

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
      },
      // insert door — no .returning() on the create path; awaiting the array is fine
      insert: () => ({
        values: async (v: Record<string, unknown>) => {
          h.insertedValues.push(v);
          return [{ id: "row-1", ...v }];
        },
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

vi.mock("../utils/audit-log.js", () => ({ auditLog: () => {} }));

import { db } from "@synap/database";
import { agentUsersRouter } from "./agent-users.js";
import type { Context } from "../types/context.js";

function caller(userId: string) {
  return agentUsersRouter.createCaller({
    authenticated: true,
    userId,
    workspaceId: WORKSPACE_ID,
  } as unknown as Context);
}

function setPodAdmin(isAdmin: boolean) {
  (db.query.workspaces as unknown as { findFirst: unknown }).findFirst =
    async () => ({ id: POD_ADMIN_WS_ID });
  (db.query.workspaceMembers as unknown as { findFirst: unknown }).findFirst =
    async () => (isAdmin ? { role: "admin" } : undefined);
}

beforeEach(() => {
  h.insertedValues.length = 0;
});

describe("agentUsers.create pod-wide gating", () => {
  // ── Scope shape guards (throw before any DB / authz) ──────────────────────
  it("rejects podWide together with a workspaceId", async () => {
    await expect(
      caller(POD_ADMIN_ID).create({
        podWide: true,
        workspaceId: WORKSPACE_ID,
        name: "Ops",
        agentType: "custom",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("rejects a non-pod-wide create with no workspaceId", async () => {
    await expect(
      caller(POD_ADMIN_ID).create({ name: "Ops", agentType: "custom" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("rejects a pod-wide twin (twin is inherently workspace-scoped)", async () => {
    await expect(
      caller(POD_ADMIN_ID).create({
        podWide: true,
        template: "twin",
        name: "Twin",
        agentType: "twin",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  // ── Authorization floor ───────────────────────────────────────────────────
  it("denies a pod-wide agent from a non-pod-admin", async () => {
    setPodAdmin(false);
    await expect(
      caller(OUTSIDER_ID).create({
        podWide: true,
        name: "Ops",
        agentType: "custom",
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("allows a pod-wide agent from a pod-admin and writes NO membership row", async () => {
    setPodAdmin(true);
    const result = await caller(POD_ADMIN_ID).create({
      podWide: true,
      name: "Ops",
      agentType: "custom",
    });

    expect(result.podWide).toBe(true);
    expect(result.role).toBeNull();
    // exactly one insert (the users row); NO workspace_members insert
    expect(h.insertedValues).toHaveLength(1);
    expect(h.insertedValues[0]).toMatchObject({ userType: "agent" });
    expect(h.insertedValues.some((v) => "invitedBy" in v)).toBe(false);
  });
});
