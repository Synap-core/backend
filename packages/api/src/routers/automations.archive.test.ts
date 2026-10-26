/**
 * automations.archive — W-B3 (supervision plan, founder Q-B1).
 *
 * An agent archives its OWN automation that NEVER RAN at once: it made it, the
 * `automation_runs` ledger is empty, and the row stays (`archived`). Every
 * other agent archive — a person's automation, another agent's, or its own
 * that ran — goes through the gate as `automation/archive` (the destructive
 * floor: it proposes). A person archives directly. Every key is bounded by its
 * grant.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  updates: [] as Array<Record<string, unknown>>,
  gateCalls: [] as Array<Record<string, unknown>>,
  runCounts: new Map<string, number>(),
  runCountReads: 0,
  automation: {} as Record<string, unknown>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    getDb: async () => ({
      query: { automations: { findFirst: async () => h.automation } },
      update: () => ({
        set: (v: Record<string, unknown>) => ({
          where: async () => {
            h.updates.push(v);
          },
        }),
      }),
    }),
  };
});

vi.mock("../services/proposals/automation-health.js", () => ({
  loadRunCounts: async () => {
    h.runCountReads++;
    return h.runCounts;
  },
}));

vi.mock("../utils/workspace-write-access.js", () => ({
  assertWorkspaceWrite: async () => undefined,
}));

vi.mock("../middleware/read-only-guard.js", async () => {
  const { t } = await import("../init-trpc.js");
  return { readOnlyGuardMiddleware: t.middleware(({ next }) => next()) };
});

vi.mock("../middleware/audit-log.js", async () => {
  const { t } = await import("../init-trpc.js");
  return { auditLogMiddleware: t.middleware(({ next }) => next()) };
});

vi.mock("../utils/permission-check.js", () => ({
  checkPermissionOrPropose: async (opts: Record<string, unknown>) => {
    h.gateCalls.push(opts);
    return {
      granted: false,
      proposalId: "proposal-1",
      proposalType: "automation.archive",
    };
  },
  proposedMessageFor: (_t: unknown, fallback: string) => fallback,
}));

import {
  runWithActingAgent,
  runWithGrant,
  type KeyGrant,
} from "@synap/database";
import { agentArchivesDirectly, automationsRouter } from "./automations.js";
import type { Context } from "../types/context.js";

const PERSON = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const OTHER_AGENT = "33333333-3333-4333-8333-333333333333";
const ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WS = "44444444-4444-4444-8444-444444444444";

function caller() {
  return automationsRouter.createCaller({
    authenticated: true,
    userId: PERSON,
    workspaceId: WS,
  } as unknown as Context);
}

const grantOf = (permissions: string[]) =>
  ({ scopes: [{ permissions }] }) as unknown as KeyGrant;

beforeEach(() => {
  h.updates.length = 0;
  h.gateCalls.length = 0;
  h.runCounts = new Map();
  h.runCountReads = 0;
  h.automation = {
    id: ID,
    workspaceId: WS,
    createdBy: AGENT,
    status: "draft",
  };
});

describe("agentArchivesDirectly — the own-and-never-ran rule", () => {
  it("own and never ran → direct", () => {
    expect(
      agentArchivesDirectly({ createdBy: AGENT, agentUserId: AGENT, runs: 0 })
    ).toBe(true);
  });

  it("own but ran once → proposes", () => {
    expect(
      agentArchivesDirectly({ createdBy: AGENT, agentUserId: AGENT, runs: 1 })
    ).toBe(false);
  });

  it("a person's, or another agent's → proposes", () => {
    expect(
      agentArchivesDirectly({ createdBy: PERSON, agentUserId: AGENT, runs: 0 })
    ).toBe(false);
    expect(
      agentArchivesDirectly({
        createdBy: OTHER_AGENT,
        agentUserId: AGENT,
        runs: 0,
      })
    ).toBe(false);
    expect(
      agentArchivesDirectly({ createdBy: null, agentUserId: AGENT, runs: 0 })
    ).toBe(false);
  });
});

describe("an acting agent", () => {
  it("archives its own never-run automation at once, no proposal", async () => {
    const result = await runWithActingAgent(AGENT, () =>
      caller().archive({ id: ID })
    );
    expect(result).toEqual({ status: "archived", previousStatus: "draft" });
    expect(h.gateCalls).toEqual([]);
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0]).toMatchObject({ status: "archived", nextRunAt: null });
  });

  it("proposes for its own automation once it has run", async () => {
    h.runCounts = new Map([[ID, 3]]);
    const result = await runWithActingAgent(AGENT, () =>
      caller().archive({ id: ID })
    );
    expect(result).toMatchObject({
      status: "proposed",
      proposalId: "proposal-1",
    });
    expect(h.gateCalls[0]).toMatchObject({
      agentUserId: AGENT,
      workspaceId: WS,
      subjectType: "automation",
      action: "archive",
      data: { automationId: ID },
    });
    expect(h.updates).toEqual([]);
  });

  it("proposes for a person's automation, even one that never ran", async () => {
    h.automation.createdBy = PERSON;
    h.automation.status = "active";
    const result = await runWithActingAgent(AGENT, () =>
      caller().archive({ id: ID })
    );
    expect(result).toMatchObject({ status: "proposed" });
    expect(h.gateCalls).toHaveLength(1);
    expect(h.updates).toEqual([]);
  });

  it("proposes for another agent's never-run automation", async () => {
    h.automation.createdBy = OTHER_AGENT;
    const result = await runWithActingAgent(AGENT, () =>
      caller().archive({ id: ID })
    );
    expect(result).toMatchObject({ status: "proposed" });
    expect(h.updates).toEqual([]);
  });
});

describe("a person archives directly", () => {
  it("any automation, ungated, without reading the ledger", async () => {
    h.automation.createdBy = PERSON;
    h.automation.status = "active";
    const result = await caller().archive({ id: ID });
    expect(result).toEqual({ status: "archived", previousStatus: "active" });
    expect(h.gateCalls).toEqual([]);
    expect(h.runCountReads).toBe(0);
    expect(h.updates).toHaveLength(1);
  });

  it("an archived automation is already archived: nothing written", async () => {
    h.automation.status = "archived";
    const result = await caller().archive({ id: ID });
    expect(result).toEqual({ status: "already_archived" });
    expect(h.updates).toEqual([]);
  });
});

describe("a key is bounded by its grant", () => {
  it("refuses an archive the grant does not name", async () => {
    await expect(
      runWithGrant(grantOf(["automation.read", "automation.delete"]), () =>
        caller().archive({ id: ID })
      )
    ).rejects.toThrow(/automation\.archive/);
    expect(h.updates).toEqual([]);
  });

  it("archives when the grant names the verb", async () => {
    h.automation.createdBy = PERSON;
    await runWithGrant(grantOf(["automation.archive"]), () =>
      caller().archive({ id: ID })
    );
    expect(h.updates).toHaveLength(1);
  });
});
