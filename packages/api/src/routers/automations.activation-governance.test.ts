/**
 * D2 — an AGENT switching an automation on always proposes; a person does not.
 *
 * Before: `automations.activate` and `automations.update({status:"active"})`
 * only ran `assertWorkspaceWrite`, so an agent key (hub REST
 * `POST /automations/:id/activate`, `PATCH /automations/:id`, hub tRPC
 * `activateAutomation`/`updateAutomation`) undid the forced-draft create in one
 * call. The agent is read from the request's acting-agent scope — driven here
 * with the REAL `runWithActingAgent`, the same entry the key-auth doors use.
 *
 * NOT covered: definition edits to an already-active automation (no status
 * transition) stay ungated — `rules/update.ts` re-enters `update` inside an
 * agent's scope under its own `rule.update` gate.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  updates: [] as Array<Record<string, unknown>>,
  gateCalls: [] as Array<Record<string, unknown>>,
  gateResult: {
    granted: false,
    proposalId: "proposal-1",
    proposalType: "automation.activate",
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

import { runWithActingAgent } from "@synap/database";
import { automationsRouter } from "./automations.js";
import type { Context } from "../types/context.js";

const AGENT = "22222222-2222-4222-8222-222222222222";
const ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function caller() {
  return automationsRouter.createCaller({
    authenticated: true,
    userId: "user-1",
    workspaceId: "11111111-1111-4111-8111-111111111111",
  } as unknown as Context);
}

beforeEach(() => {
  h.updates.length = 0;
  h.gateCalls.length = 0;
  h.automation = {
    id: ID,
    name: "Daily recap",
    workspaceId: "11111111-1111-4111-8111-111111111111",
    createdBy: AGENT,
    status: "draft",
    triggerType: "manual",
    triggerConfig: {},
    flowDefinition: { nodes: [], edges: [] },
    metadata: {},
    version: 1,
  };
});

describe("automations.activate — acting agent", () => {
  it("proposes automation.activate and writes nothing", async () => {
    const result = await runWithActingAgent(AGENT, () =>
      caller().activate({ id: ID })
    );
    expect(result).toMatchObject({
      status: "proposed",
      proposalId: "proposal-1",
    });
    expect(h.gateCalls).toHaveLength(1);
    expect(h.gateCalls[0]).toMatchObject({
      agentUserId: AGENT,
      subjectType: "automation",
      action: "activate",
      data: { automationId: ID },
    });
    expect(h.updates).toEqual([]);
  });

  it("a person (no acting agent) activates directly, ungated", async () => {
    const result = await caller().activate({ id: ID });
    expect(result).toMatchObject({ status: "activated" });
    expect(h.gateCalls).toEqual([]);
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0]).toMatchObject({ status: "active" });
  });
});

describe("automations.update — acting agent", () => {
  it("status draft → active proposes the whole update and writes nothing", async () => {
    const result = await runWithActingAgent(AGENT, () =>
      caller().update({ id: ID, name: "Renamed", status: "active" })
    );
    expect(result).toMatchObject({ status: "proposed" });
    expect(h.gateCalls[0]).toMatchObject({
      action: "activate",
      data: {
        automationId: ID,
        update: { id: ID, name: "Renamed", status: "active" },
      },
    });
    expect(h.updates).toEqual([]);
  });

  it("an edit with no status transition is not gated (rule re-entry path)", async () => {
    const result = await runWithActingAgent(AGENT, () =>
      caller().update({ id: ID, name: "Renamed" })
    );
    expect(result).toMatchObject({ status: "updated" });
    expect(h.gateCalls).toEqual([]);
    expect(h.updates).toHaveLength(1);
  });
});
