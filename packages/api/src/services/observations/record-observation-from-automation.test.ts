/**
 * An automation's `record_observation` step → `recordObservationFromAutomation`
 * → the ONE writer. Driven through the REAL `recordObservation` (only the
 * event store, the boss and the PR→session resolver are stubbed), so what is
 * asserted is what the pod actually appends and enqueues:
 *   - the observation door's refusals hold here too (namespace, reserved phase,
 *     reserved subject type, the dev-loop contract) and nothing is recorded;
 *   - a fact is recorded for the OWNER in the automation's workspace;
 *   - the trigger hop carries the run's chain (the cycle guard sees it) and
 *     names the owner as producer, as `emitSideEffects` names its actor.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const WS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const appended: any[] = [];
const sends: Array<[string, any]> = [];

vi.mock("@synap/events", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getBoss: () => ({
      send: async (queue: string, payload: any) => {
        sends.push([queue, payload]);
        return null;
      },
    }),
  };
});

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getEventRepository: () => ({
      append: async (e: any) => {
        appended.push(e);
        return { id: `row-${appended.length}` };
      },
    }),
  };
});

vi.mock("../dev-loop/pr-session-resolver.js", async () => ({
  sessionForDevLoopFact: async () => null,
}));

vi.mock("../api-keys.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, any>>();
  return {
    ...actual,
    apiKeyService: new Proxy(actual.apiKeyService, {
      get: (target, prop) =>
        prop === "checkRateLimit" ? () => true : Reflect.get(target, prop),
    }),
  };
});

const { recordObservationFromAutomation } =
  await import("./record-observation-from-automation.js");

const chain = {
  automationRunId: "run-1",
  automationId: "auto-1",
  chainDepth: 1,
  rootRunId: "run-0",
  chainAutomationIds: ["auto-0", "auto-1"],
};

const record = (over: Record<string, unknown> = {}) =>
  recordObservationFromAutomation({
    type: "dev.pr_merged",
    subjectId: "Synap-core/backend#12",
    data: {
      repo: "Synap-core/backend",
      number: 12,
      url: "https://github.com/Synap-core/backend/pull/12",
      intoDefault: true,
    },
    ownerId: "owner-1",
    workspaceId: WS,
    automationContext: chain,
    ...over,
  } as never);

beforeEach(() => {
  appended.length = 0;
  sends.length = 0;
});

describe("record_observation — the observation door's refusals", () => {
  it.each([
    ["an unregistered namespace", { type: "entity.create" }, /namespace/],
    ["a reserved phase", { type: "dev.commit.completed" }, /lifecycle phase/],
    [
      "a reserved subject type",
      { type: "dev.commit", subjectType: "focus_session" },
      /reserved/,
    ],
    [
      "a dev-loop fact off its contract",
      { data: { repo: "Synap-core/backend", number: "12" } },
      /refused: dev\.pr_merged: number/,
    ],
  ])("refuses %s and records nothing", async (_label, over, reason) => {
    await expect(record(over)).rejects.toThrow(reason);
    expect(appended).toHaveLength(0);
    expect(sends).toHaveLength(0);
  });
});

describe("record_observation — recorded through the one writer", () => {
  it("records the fact for the owner in the automation's workspace", async () => {
    const { id } = await record();
    expect(id).toBe("row-1");
    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({
      type: "dev.pr_merged",
      userId: "owner-1",
      workspaceId: WS,
      data: { subjectRef: "Synap-core/backend#12", number: 12 },
    });
    expect(appended[0].agentUserId).toBeUndefined();
  });

  it("the trigger hop carries the run's chain and names the owner", async () => {
    await record();
    const hop = sends.find(([q]) => q === "automation-trigger-match");
    expect(hop, "no trigger hop enqueued").toBeDefined();
    expect(hop![1]).toMatchObject({
      eventType: "dev.pr_merged",
      workspaceId: WS,
      eventId: "row-1",
      producerAgentUserId: "owner-1",
      automationContext: chain,
    });
  });
});
