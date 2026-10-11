/**
 * hubAutomationsRouter.triggerAutomation — identity threading.
 *
 * Prior state: `automations.ts` `trigger` procedure had a governance gate
 * (`checkPermissionOrPropose`) keyed on `agentUserId`, but NO caller ever
 * supplied it — this hub-protocol door rebuilt the caller context and called
 * `caller.trigger({id, workspaceId, payload})`, silently dropping
 * `agentUserId`/`reasoning`. The gate typechecked fine while being dead code.
 *
 * This proves the door now forwards both fields to the underlying `trigger`
 * procedure — the same shape `createAutomation` in this file already used as
 * the precedent — and that an operator call (no agentUserId) is unaffected.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  triggerCalls: [] as Array<Record<string, unknown>>,
  createCalls: [] as Array<Record<string, unknown>>,
  ctxAgents: [] as Array<unknown>,
  triggerResult: { status: "triggered", runId: "run-1" } as Record<
    string,
    unknown
  >,
}));

vi.mock("../automations.js", () => ({
  automationsRouter: {
    createCaller: () => ({
      trigger: async (input: Record<string, unknown>) => {
        h.triggerCalls.push(input);
        return h.triggerResult;
      },
      create: async (input: Record<string, unknown>) => {
        h.createCalls.push(input);
        return { id: "auto-1" };
      },
    }),
  },
}));

vi.mock("./utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./utils.js")>()),
  createHubProtocolCallerContext: async (...args: unknown[]) => {
    h.ctxAgents.push(args[5]);
    return {};
  },
}));

import { hubAutomationsRouter } from "./automations.js";
import type { Context } from "../../types/context.js";

const AUTOMATION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENT = "22222222-2222-4222-8222-222222222222";
const OTHER_AGENT = "33333333-3333-4333-8333-333333333333";

function caller(agentUserId?: string) {
  return hubAutomationsRouter.createCaller({
    authenticated: true,
    userId: "user-1",
    agentUserId,
    scopes: ["hub-protocol.write"],
    apiKeyId: "hub-protocol",
    apiKeyName: "Hub Protocol",
  } as unknown as Context & { scopes: string[] });
}

beforeEach(() => {
  h.triggerCalls.length = 0;
  h.createCalls.length = 0;
  h.ctxAgents.length = 0;
  h.triggerResult = { status: "triggered", runId: "run-1" };
});

describe("hubAutomationsRouter.triggerAutomation — agent identity threading", () => {
  it("forwards agentUserId and reasoning to the underlying trigger procedure", async () => {
    await caller().triggerAutomation({
      userId: "user-1",
      id: AUTOMATION_ID,
      agentUserId: AGENT,
      reasoning: "user asked to run the digest now",
    });

    expect(h.triggerCalls).toHaveLength(1);
    expect(h.triggerCalls[0]).toMatchObject({
      id: AUTOMATION_ID,
      agentUserId: AGENT,
      reasoning: "user asked to run the digest now",
    });
  });

  it("returns the proposal envelope untouched when the underlying gate proposes", async () => {
    h.triggerResult = {
      status: "proposed",
      runId: null,
      proposalId: "proposal-1",
      message: 'Running "Daily recap" proposed for review',
    };

    const result = await caller().triggerAutomation({
      userId: "user-1",
      id: AUTOMATION_ID,
      agentUserId: AGENT,
    });

    expect(result).toMatchObject({
      status: "proposed",
      runId: null,
      proposalId: "proposal-1",
    });
  });

  it("an operator call (no agentUserId) forwards agentUserId as undefined", async () => {
    await caller().triggerAutomation({
      userId: "user-1",
      id: AUTOMATION_ID,
    });

    expect(h.triggerCalls).toHaveLength(1);
    expect(h.triggerCalls[0]?.agentUserId).toBeUndefined();
  });
});

describe("hub automations — the identity comes from the authenticated key", () => {
  it("an agent key omitting agentUserId still triggers AS that agent", async () => {
    await caller(AGENT).triggerAutomation({
      userId: "user-1",
      id: AUTOMATION_ID,
    });

    expect(h.triggerCalls[0]?.agentUserId).toBe(AGENT);
    expect(h.ctxAgents).toEqual([AGENT]);
  });

  it("an agent key naming another agent is still governed as itself", async () => {
    await caller(AGENT).triggerAutomation({
      userId: "user-1",
      id: AUTOMATION_ID,
      agentUserId: OTHER_AGENT,
    });

    expect(h.triggerCalls[0]?.agentUserId).toBe(AGENT);
  });

  it("an agent key omitting agentUserId creates AS that agent (status cannot skip the gate)", async () => {
    await caller(AGENT).createAutomation({
      userId: "user-1",
      name: "Planted",
      triggerType: "event",
      flowDefinition: { nodes: [], edges: [] },
      status: "active",
    });

    expect(h.createCalls[0]).toMatchObject({
      agentUserId: AGENT,
      source: "agent",
    });
    expect(h.ctxAgents).toEqual([AGENT]);
  });
});
