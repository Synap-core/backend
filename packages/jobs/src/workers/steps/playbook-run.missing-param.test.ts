/**
 * The scheduled `playbook_run` step is an AUTOMATION launching a run: a
 * required param nobody supplied goes back to the automation as a refusal
 * (founder decision E3, 2026-10-27), never as a slot in a person's Needs you.
 * Before, the step asked the spine to `"owe"` it, which filed "Answer: <param>"
 * for the founder on a run nobody was watching.
 *
 * Asserted on the input the step hands the registered runner, and on what a
 * spine refusal does to the step: it rejects, so the executor records the step
 * `failed` with the refusal's sentence.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  calls: [] as Array<Record<string, unknown>>,
  refuse: null as null | Error,
}));

vi.mock("../capability-dispatch.js", () => ({
  getPlaybookRunner: () => async (input: Record<string, unknown>) => {
    h.calls.push(input);
    if (h.refuse) throw h.refuse;
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

const step = () =>
  executePlaybookRun(
    { playbookId: "pb-1" },
    { trigger: { payload: {}, subject: null }, steps: {} } as never,
    "ws-1",
    "owner-1"
  );

beforeEach(() => {
  h.calls.length = 0;
  h.refuse = null;
});

describe("executePlaybookRun — a missing required param refuses the automation", () => {
  it("asks the spine to REFUSE a missing required param, never to owe it", async () => {
    await step();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.onMissingRequired).toBe("refuse");
  });

  it("the spine's refusal fails the step with its sentence", async () => {
    h.refuse = new Error(
      'This playbook requires "UI design". Nothing was started — supply it and run again.'
    );
    await expect(step()).rejects.toThrow(/requires "UI design"/);
  });
});
