/**
 * The scheduled `playbook_run` step is the UNATTENDED door, so it must ask the
 * spine for the not-enabled-skill preflight (`unenabledSkillPreflight: true`).
 * Without it a scheduled run starts a session the agent cannot finish.
 * Asserted on the input the step hands the registered runner.
 */

import { describe, it, expect, vi } from "vitest";

const runnerCalls: Array<Record<string, unknown>> = [];

vi.mock("../capability-dispatch.js", () => ({
  getPlaybookRunner: () => async (input: Record<string, unknown>) => {
    runnerCalls.push(input);
    return {
      run: { id: "r-1", status: "running" },
      session: { id: "s-1", channelId: null },
    };
  },
  getSessionScheduler: () => null,
}));
vi.mock("../../utils/automation-governance.js", () => ({
  guardProducerEffect: async () => ({ allow: true }),
  PolicyBlockedError: class extends Error {},
}));

const { executePlaybookRun } = await import("./playbook-run.js");

describe("executePlaybookRun — unattended preflight flag", () => {
  it("asks the runner for the not-enabled-skill preflight", async () => {
    await executePlaybookRun(
      { playbookId: "pb-1" },
      { trigger: { payload: {}, subject: null }, steps: {} } as never,
      "ws-1",
      "owner-1"
    );
    expect(runnerCalls).toHaveLength(1);
    expect(runnerCalls[0].unenabledSkillPreflight).toBe(true);
  });
});
