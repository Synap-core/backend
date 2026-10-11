/**
 * agentUsers.update — an agent's capabilities are its ONE limit, and its keys
 * carry them. The seam pinned here: a capability edit that is applied re-grants
 * the agent's live keys (`reapplyAgentKeyGrants`); one that is only PROPOSED
 * does not; and a list that cannot be a grant (a malformed pattern, too many
 * permissions) is refused before anything is written or proposed.
 *
 * `reapplyAgentKeyGrants` itself (which keys, what grant) runs on PGlite in
 * `services/agent-connect.pglite.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";
const ADMIN_ID = "user-admin";

const h = vi.hoisted(() => ({
  userUpdates: [] as Record<string, unknown>[],
  reapplied: [] as Array<{ agentUserId: string; createdBy: string }>,
  gated: [] as unknown[],
  verdict: { granted: true } as Record<string, unknown>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    verifyPermission: async () => ({ allowed: true, role: "admin" }),
    db: {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [
              { id: AGENT_ID, userType: "agent", agentMetadata: {} },
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

vi.mock("../utils/permission-check.js", () => ({
  checkPermissionOrPropose: async (input: unknown) => {
    h.gated.push(input);
    return h.verdict;
  },
}));

vi.mock("../services/agent-identity-service.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    reapplyAgentKeyGrants: async (args: {
      agentUserId: string;
      createdBy: string;
    }) => {
      h.reapplied.push(args);
      return 1;
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

import { agentUsersRouter } from "./agent-users.js";
import type { Context } from "../types/context.js";
import { MAX_GRANT_PERMISSIONS } from "@synap-core/types/grants";

const caller = () =>
  agentUsersRouter.createCaller({
    authenticated: true,
    userId: ADMIN_ID,
    workspaceId: WORKSPACE_ID,
  } as unknown as Context);

const update = (capabilities: string[]) =>
  caller().update({
    workspaceId: WORKSPACE_ID,
    agentUserId: AGENT_ID,
    capabilities,
  });

beforeEach(() => {
  h.userUpdates.length = 0;
  h.reapplied.length = 0;
  h.gated.length = 0;
  h.verdict = { granted: true };
});

describe("agentUsers.update — capabilities bind the agent's keys", () => {
  it("an applied edit stores the list and re-grants its live keys", async () => {
    await expect(update(["entity.note.create"])).resolves.toEqual({
      status: "updated",
    });
    expect(h.userUpdates[0]).toMatchObject({
      agentMetadata: { capabilities: ["entity.note.create"] },
    });
    expect(h.reapplied).toEqual([
      { agentUserId: AGENT_ID, createdBy: ADMIN_ID },
    ]);
  });

  it("a PROPOSED edit changes nothing yet — no store, no re-grant", async () => {
    h.verdict = { granted: false, proposalId: "p-1" };
    await expect(update(["entity.note.create"])).resolves.toEqual({
      status: "proposed",
      proposalId: "p-1",
    });
    expect(h.userUpdates).toEqual([]);
    expect(h.reapplied).toEqual([]);
  });

  it("a pattern that is not a grant is refused before the gate", async () => {
    await expect(update(["Entity.Create"])).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(h.gated).toEqual([]);
    expect(h.userUpdates).toEqual([]);
  });

  it("a list that cannot fit one grant is refused", async () => {
    const many = Array.from(
      { length: MAX_GRANT_PERMISSIONS + 1 },
      (_, i) => `entity.k${i}.create`
    );
    await expect(update(many)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(h.gated).toEqual([]);
  });

  it("the legacy full-access spellings stay accepted", async () => {
    await expect(update(["*.*"])).resolves.toEqual({ status: "updated" });
    await expect(update([])).resolves.toEqual({ status: "updated" });
  });
});
