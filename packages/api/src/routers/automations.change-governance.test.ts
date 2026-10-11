/**
 * automations.update / delete / pause — governed like create.
 *
 * Before: the three doors ran `assertWorkspaceWrite` only, so an agent key
 * edited, paused or deleted an automation directly, and a narrow human key was
 * never bounded by its grant. Now every key is bounded by its grant
 * (`assertKeyMayWrite`), and an acting agent goes through
 * `checkPermissionOrPropose` (`automation.update` — pause included — and
 * `automation.delete`), whose proposal the `automation/update|delete`
 * executor replays. A rule edit's own rewrite (`governedByParentWrite`) is not
 * proposed twice.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  updates: [] as Array<Record<string, unknown>>,
  deletes: 0,
  gateCalls: [] as Array<Record<string, unknown>>,
  gateResult: {
    granted: false,
    proposalId: "proposal-1",
    proposalType: "automation.update",
  } as Record<string, unknown>,
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
      delete: () => ({
        where: async () => {
          h.deletes++;
        },
      }),
    }),
  };
});

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
    return h.gateResult;
  },
  proposedMessageFor: (_t: unknown, fallback: string) => fallback,
}));

import {
  runWithActingAgent,
  runWithGrant,
  type KeyGrant,
} from "@synap/database";
import { automationsRouter } from "./automations.js";
import type { Context } from "../types/context.js";

const AGENT = "22222222-2222-4222-8222-222222222222";
const ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WS = "11111111-1111-4111-8111-111111111111";

function caller(extra: Record<string, unknown> = {}) {
  return automationsRouter.createCaller({
    authenticated: true,
    userId: "user-1",
    workspaceId: WS,
    ...extra,
  } as unknown as Context);
}

const grantOf = (permissions: string[]) =>
  ({ scopes: [{ permissions }] }) as unknown as KeyGrant;

beforeEach(() => {
  h.updates.length = 0;
  h.deletes = 0;
  h.gateCalls.length = 0;
  h.automation = {
    id: ID,
    name: "Daily recap",
    workspaceId: WS,
    createdBy: "user-1",
    status: "active",
    triggerType: "manual",
    triggerConfig: {},
    flowDefinition: { nodes: [], edges: [] },
    metadata: {},
    version: 1,
  };
});

describe("an acting agent proposes instead of writing", () => {
  it("update → automation.update proposal carrying the edit", async () => {
    const result = await runWithActingAgent(AGENT, () =>
      caller().update({ id: ID, name: "Renamed" })
    );
    expect(result).toMatchObject({
      status: "proposed",
      proposalId: "proposal-1",
    });
    expect(h.gateCalls[0]).toMatchObject({
      agentUserId: AGENT,
      workspaceId: WS,
      subjectType: "automation",
      action: "update",
      data: { automationId: ID, update: { id: ID, name: "Renamed" } },
    });
    expect(h.updates).toEqual([]);
  });

  it("pause → automation.update proposal with status paused", async () => {
    const result = await runWithActingAgent(AGENT, () =>
      caller().pause({ id: ID })
    );
    expect(result).toMatchObject({ status: "proposed" });
    expect(h.gateCalls[0]).toMatchObject({
      action: "update",
      data: { automationId: ID, update: { status: "paused" } },
    });
    expect(h.updates).toEqual([]);
  });

  it("delete → automation.delete proposal, nothing deleted", async () => {
    const result = await runWithActingAgent(AGENT, () =>
      caller().delete({ id: ID })
    );
    expect(result).toMatchObject({ status: "proposed" });
    expect(h.gateCalls[0]).toMatchObject({
      action: "delete",
      data: { automationId: ID },
    });
    expect(h.deletes).toBe(0);
  });

  it("a denial from the gate is a FORBIDDEN, nothing written", async () => {
    h.gateResult = { denied: true, reason: "no" };
    await expect(
      runWithActingAgent(AGENT, () => caller().delete({ id: ID }))
    ).rejects.toThrow("no");
    expect(h.deletes).toBe(0);
  });

  it("a rule edit's own rewrite is not proposed twice", async () => {
    const result = await runWithActingAgent(AGENT, () =>
      caller({ governedByParentWrite: "rule.update" }).update({
        id: ID,
        name: "Renamed",
      })
    );
    expect(result).toMatchObject({ status: "updated" });
    expect(h.gateCalls).toEqual([]);
  });
});

describe("a person writes directly", () => {
  it("update, pause and delete run ungated", async () => {
    await caller().update({ id: ID, name: "Renamed" });
    await caller().pause({ id: ID });
    await caller().delete({ id: ID });
    expect(h.gateCalls).toEqual([]);
    expect(h.updates).toHaveLength(2);
    expect(h.deletes).toBe(1);
  });
});

describe("a key that is not an agent is bounded by its grant", () => {
  it("refuses update / pause / delete / activate the grant does not name", async () => {
    const g = grantOf(["automation.read", "automation.create"]);
    await expect(
      runWithGrant(g, () => caller().update({ id: ID, name: "x" }))
    ).rejects.toThrow(/automation\.update/);
    await expect(
      runWithGrant(g, () => caller().pause({ id: ID }))
    ).rejects.toThrow(/automation\.update/);
    await expect(
      runWithGrant(g, () => caller().delete({ id: ID }))
    ).rejects.toThrow(/automation\.delete/);
    h.automation.status = "draft";
    await expect(
      runWithGrant(g, () => caller().activate({ id: ID }))
    ).rejects.toThrow(/automation\.activate/);
    expect(h.updates).toEqual([]);
    expect(h.deletes).toBe(0);
  });

  it("writes when the grant names the verb", async () => {
    const g = grantOf(["automation.update", "automation.delete"]);
    await runWithGrant(g, () => caller().pause({ id: ID }));
    await runWithGrant(g, () => caller().delete({ id: ID }));
    expect(h.updates).toHaveLength(1);
    expect(h.deletes).toBe(1);
  });
});
