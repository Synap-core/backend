/**
 * agentUsers "Require approval for writes" — the switch must go through THE
 * posture writer (an agent-scoped `ask-first` override), never persist the raw
 * rung-5 flag (which the pod default at rung 2.8 outranks — a lying control).
 * And the switch's state is READ from the effective inputs (`governance`).
 *
 * The decision half (override ⇒ a reversible write proposes) is pinned on real
 * Postgres in @synap/database `agent-posture.pglite.test.ts`; this pins the SEAM.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";
const ADMIN_ID = "user-admin";

const h = vi.hoisted(() => ({
  userUpdates: [] as Record<string, unknown>[],
  applied: [] as Array<{ agentUserId: string; posture: string | null }>,
  governance: {
    posture: null as string | null,
    writesRequireProposal: true,
    rules: [],
    configured: false,
  },
  podDefault: { enabled: true, ruleId: "r1" },
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    verifyPermission: async () => ({ allowed: true, role: "admin" }),
    readReversibleDefault: async () => h.podDefault,
    db: {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [
              {
                id: AGENT_ID,
                userType: "agent",
                agentMetadata: { writesRequireProposal: true },
              },
            ],
          }),
        }),
      }),
      update: () => ({
        set: (v: Record<string, unknown>) => ({
          where: async () => {
            h.userUpdates.push(v);
          },
        }),
      }),
    },
  };
});

vi.mock("@synap/database/agent-governance", () => ({
  applyAgentPosture: async (input: {
    agentUserId: string;
    posture: string | null;
  }) => {
    h.applied.push({ agentUserId: input.agentUserId, posture: input.posture });
    return { posture: input.posture, writesRequireProposal: true };
  },
  readAgentGovernance: async () => h.governance,
}));

vi.mock("../middleware/read-only-guard.js", async () => {
  const { t } = await import("../init-trpc.js");
  return { readOnlyGuardMiddleware: t.middleware(({ next }) => next()) };
});
vi.mock("../middleware/audit-log.js", async () => {
  const { t } = await import("../init-trpc.js");
  return { auditLogMiddleware: t.middleware(({ next }) => next()) };
});
vi.mock("../utils/audit-log.js", () => ({ auditLog: () => {} }));

import { agentUsersRouter } from "./agent-users.js";
import type { Context } from "../types/context.js";

const caller = () =>
  agentUsersRouter.createCaller({
    authenticated: true,
    userId: ADMIN_ID,
    workspaceId: WORKSPACE_ID,
  } as unknown as Context);

beforeEach(() => {
  h.userUpdates.length = 0;
  h.applied.length = 0;
  h.governance = {
    posture: null,
    writesRequireProposal: true,
    rules: [],
    configured: false,
  };
  h.podDefault = { enabled: true, ruleId: "r1" };
});

describe("agentUsers.update — Require approval for writes", () => {
  it("ON applies the ask-first override and never writes the raw flag", async () => {
    await caller().update({
      workspaceId: WORKSPACE_ID,
      agentUserId: AGENT_ID,
      writesRequireProposal: true,
    });
    expect(h.applied).toEqual([
      { agentUserId: AGENT_ID, posture: "ask-first" },
    ]);
    for (const u of h.userUpdates)
      expect(u).not.toHaveProperty("agentMetadata");
  });

  it("OFF clears the override (follow the pod default)", async () => {
    await caller().update({
      workspaceId: WORKSPACE_ID,
      agentUserId: AGENT_ID,
      writesRequireProposal: false,
    });
    expect(h.applied).toEqual([{ agentUserId: AGENT_ID, posture: null }]);
  });

  it("an update that does not touch the switch leaves the override alone", async () => {
    await caller().update({
      workspaceId: WORKSPACE_ID,
      agentUserId: AGENT_ID,
      name: "Renamed",
    });
    expect(h.applied).toEqual([]);
  });
});

describe("agentUsers.governance — the switch reads the EFFECTIVE decision", () => {
  it("a strict-flag agent with no override follows the pod default (switch OFF, true copy)", async () => {
    const g = await caller().governance({ agentUserId: AGENT_ID });
    expect(g).toMatchObject({
      askFirst: false,
      writeMode: "pod-default",
      line: "Creates and edits apply directly with Undo; deletions and structural changes ask you.",
    });
  });

  it("the ask-first override reads ON with 'Every change asks you first.'", async () => {
    h.governance = { ...h.governance, posture: "ask-first", configured: true };
    const g = await caller().governance({ agentUserId: AGENT_ID });
    expect(g).toMatchObject({
      askFirst: true,
      writeMode: "ask-first",
      line: "Every change asks you first.",
    });
  });

  it("pod default off: a strict agent reads 'Every change asks you first.'", async () => {
    h.podDefault = { enabled: false, ruleId: null as unknown as string };
    const g = await caller().governance({ agentUserId: AGENT_ID });
    expect(g).toMatchObject({
      askFirst: false,
      writeMode: "ask-first",
      podDefaultEnabled: false,
    });
  });
});
