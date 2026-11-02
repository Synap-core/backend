/**
 * Seam test: a run refused by a person's "Never" (`DENIED_BY_RULE`, 0381)
 * answers the AGENT with the agent's sentence, and records the refusal for the
 * PERSON (the runs ledger's `data.reason`) in the person's words, from the
 * vocabulary door. Drives the real `executeCapability` deny branch with the
 * skill read, the gate and the event emitter stubbed.
 */

import { describe, it, expect, vi } from "vitest";
import {
  DENIED_BY_RULE,
  DENIED_BY_RULE_REASON,
} from "@synap/governance-policy";
import { resolveGovernanceRungLabel } from "@synap-core/types/vocabulary";

const WS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SKILL = {
  id: "skill-a",
  name: "gmail_send",
  approved: true,
  userId: "owner-1",
  kind: "instruction",
  providerSpec: null,
};

const emitted: Array<Record<string, unknown>> = [];

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    db: {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({ limit: async () => [SKILL] }),
          }),
        }),
      }),
    },
  };
});

vi.mock("./gate-capability-execution.js", () => ({
  gateCapabilityExecution: async () => ({
    decision: "deny",
    reason: DENIED_BY_RULE_REASON,
    reasonCode: DENIED_BY_RULE,
  }),
}));

vi.mock("../../utils/ai-feedback-events.js", () => ({
  emitAiDecision: async (event: Record<string, unknown>) => {
    emitted.push(event);
  },
}));

const { executeCapability } = await import("./execute-capability.js");

describe("executeCapability — a run refused by a person's Never", () => {
  it("tells the agent its sentence and records the person's words", async () => {
    const out = await executeCapability({
      verbId: "gmail_send",
      parameters: {},
      workspaceId: WS,
      userId: "user-1",
      agentUserId: "agent-1",
    });

    expect(out).toEqual({
      kind: "deny",
      reason: DENIED_BY_RULE_REASON,
      reasonCode: DENIED_BY_RULE,
    });

    expect(emitted).toHaveLength(1);
    const data = emitted[0]!.data as Record<string, unknown>;
    expect(data).toMatchObject({
      outcome: "refused",
      refusalReason: "denied_by_rule",
      reason: resolveGovernanceRungLabel("denied-by-rule"),
    });
    // The person never reads the agent's instruction or its machine code.
    expect(data.reason).not.toMatch(/DENIED_BY_RULE|retry/);
  });
});
