/**
 * automations.trigger governance — triggering an automation runs the whole flow
 * (including `webhook` and `command` nodes), i.e. CODE EXECUTION, strictly wider
 * than `run_command` which IS gated (hub-protocol/rest/commands.ts
 * `POST /commands/execute`). This proves the agent caller is gated with the same
 * shape, and that the OPERATOR path is not regressed.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  runInserts: [] as Array<Record<string, unknown>>,
  bossSends: [] as Array<{ queue: string; payload: Record<string, unknown> }>,
  gateCalls: [] as Array<Record<string, unknown>>,
  gateResult: { granted: true } as Record<string, unknown>,
  automation: {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    name: "Daily recap",
    workspaceId: "11111111-1111-4111-8111-111111111111",
    createdBy: "user-1",
    status: "active",
    triggerType: "cron",
  } as Record<string, unknown>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    getDb: async () => ({
      query: {
        automations: { findFirst: async () => h.automation },
      },
      insert: () => ({
        values: (v: Record<string, unknown>) => ({
          returning: async () => {
            h.runInserts.push(v);
            return [{ id: "run-1" }];
          },
        }),
      }),
    }),
  };
});

vi.mock("../utils/workspace-write-access.js", () => ({
  assertWorkspaceWrite: async () => undefined,
}));

// protectedProcedure's two DB-touching middlewares (split-brain read-only guard
// + audit log) — stubbed so the router can be exercised without a live PG.
vi.mock("../middleware/read-only-guard.js", async () => {
  const { t } = await import("../init-trpc.js");
  return {
    readOnlyGuardMiddleware: t.middleware(({ next }) => next()),
  };
});

vi.mock("../middleware/audit-log.js", async () => {
  const { t } = await import("../init-trpc.js");
  return { auditLogMiddleware: t.middleware(({ next }) => next()) };
});

vi.mock("../utils/permission-check.js", () => ({
  checkPermissionOrPropose: async (opts: Record<string, unknown>) => {
    h.gateCalls.push(opts);
    return h.gateResult;
  },
}));

vi.mock("@synap/jobs", () => ({
  getBoss: () => ({
    send: async (queue: string, payload: Record<string, unknown>) => {
      h.bossSends.push({ queue, payload });
    },
  }),
}));

import { automationsRouter } from "./automations.js";
import type { Context } from "../types/context.js";

const AGENT = "22222222-2222-4222-8222-222222222222";

function caller(ctx: Partial<Context> = {}) {
  return automationsRouter.createCaller({
    authenticated: true,
    userId: "user-1",
    workspaceId: h.automation.workspaceId as string,
    ...ctx,
  } as unknown as Context);
}

beforeEach(() => {
  h.runInserts.length = 0;
  h.bossSends.length = 0;
  h.gateCalls.length = 0;
  h.gateResult = { granted: true };
});

describe("automations.trigger — agent caller is governed", () => {
  it("proposes instead of enqueuing the run", async () => {
    h.gateResult = {
      granted: false,
      proposalId: "proposal-1",
      proposalType: "automation.execute",
      summary: "Execute automation",
      reasoning: "r",
      reviewPath: "/open/proposal-1",
      reviewUrl: "u",
    };

    const result = await caller().trigger({
      id: h.automation.id as string,
      agentUserId: AGENT,
    });

    expect(result).toMatchObject({
      status: "proposed",
      runId: null,
      proposalId: "proposal-1",
    });
    // No run row, no job — the automation did NOT execute.
    expect(h.runInserts).toHaveLength(0);
    expect(h.bossSends).toHaveLength(0);
  });

  it("gates with {automation, execute} on the automation's REAL workspace", async () => {
    await caller().trigger({
      id: h.automation.id as string,
      agentUserId: AGENT,
    });

    expect(h.gateCalls).toHaveLength(1);
    expect(h.gateCalls[0]).toMatchObject({
      subjectType: "automation",
      action: "execute",
      agentUserId: AGENT,
      workspaceId: h.automation.workspaceId,
    });
  });

  it("gates on ctx.agentUserId when the input omits it", async () => {
    await caller({ agentUserId: AGENT }).trigger({
      id: h.automation.id as string,
    });

    expect(h.gateCalls).toHaveLength(1);
    expect(h.gateCalls[0]).toMatchObject({ agentUserId: AGENT });
  });

  it("hard-denies (FORBIDDEN) without enqueuing when the gate denies", async () => {
    h.gateResult = { denied: true, reason: "Permission denied" };

    await expect(
      caller().trigger({ id: h.automation.id as string, agentUserId: AGENT })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(h.bossSends).toHaveLength(0);
  });

  it("enqueues normally when the gate grants", async () => {
    const result = await caller().trigger({
      id: h.automation.id as string,
      agentUserId: AGENT,
    });

    expect(result).toMatchObject({ status: "triggered", runId: "run-1" });
    expect(h.bossSends[0]?.queue).toBe("automation-execute");
  });
});

describe("automations.trigger — operator caller is NOT regressed", () => {
  it("runs directly, without invoking the gate", async () => {
    const result = await caller().trigger({ id: h.automation.id as string });

    expect(result).toMatchObject({ status: "triggered", runId: "run-1" });
    expect(h.gateCalls).toHaveLength(0);
    expect(h.runInserts).toHaveLength(1);
    expect(h.bossSends).toHaveLength(1);
  });
});
