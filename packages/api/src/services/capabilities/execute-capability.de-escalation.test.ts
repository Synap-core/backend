/**
 * Ticket 68aeb326 — an agent PAUSING an automation applies directly (founder
 * decision 2026-10-23): it only reduces what the pod does, so it must not wait
 * for review, and the verb's text already said "does not wait for review".
 * The outer capability gate proposed it anyway (the verb's identity never
 * reaches the policy; only `readOnly` short-circuits it).
 *
 * Pins what the door hands the gate: `automation.pause` takes the auto-run
 * path; `automation.delete` and `automation.activate` (escalations) do not.
 */
import { describe, it, expect, vi } from "vitest";

const WS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

let SKILL_ROW: Record<string, unknown> = {};
const gated: Array<Record<string, unknown>> = [];

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getWorkspaceMembership: async () => ({ role: "owner" }),
    db: {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({ limit: async () => [SKILL_ROW] }),
          }),
        }),
      }),
    },
  };
});

vi.mock("./gate-capability-execution.js", () => ({
  // A dry-run verdict ends the door right after the gate: nothing executes.
  gateCapabilityExecution: async (input: Record<string, unknown>) => {
    gated.push(input);
    return { decision: "dry-run" };
  },
  CAPABILITY_RUN_PROPOSAL: {
    targetType: "capability",
    proposalType: "capability.run",
  },
}));

const { executeCapability } = await import("./execute-capability.js");

async function gateInputFor(verb: string) {
  SKILL_ROW = {
    id: "11111111-1111-4111-8111-111111111111",
    name: verb,
    approved: true,
    userId: "user-1",
    kind: "builtin",
    providerSpec: null,
  };
  gated.length = 0;
  await executeCapability({
    verbId: verb,
    parameters: { automationId: "22222222-2222-4222-8222-222222222222" },
    workspaceId: WS,
    userId: "user-1",
    agentUserId: AGENT,
  });
  expect(gated).toHaveLength(1);
  return gated[0]!;
}

describe("executeCapability — de-escalation verbs auto-run at the gate (68aeb326)", () => {
  it("an agent's automation.pause takes the auto-run path", async () => {
    expect(await gateInputFor("automation.pause")).toMatchObject({
      agentUserId: AGENT,
      readOnly: true,
    });
  });

  it.each(["automation.delete", "automation.activate", "automation.update"])(
    "%s still flows through the full ladder",
    async (verb) => {
      expect(await gateInputFor(verb)).toMatchObject({ readOnly: false });
    }
  );
});
