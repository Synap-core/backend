/**
 * THE needs-you priority reaches the read: a STORED slot (its `ask` as the
 * session row holds it) → `projectOwedSlots` (the owed read's projection, with
 * the rule's session facts) → `signalFromOwedSlot` → `signal.priority`.
 * Nothing hand-built between the stored row and the signal, so a dropped
 * `ask` field or a dropped `priority` projection fails here.
 */
import { describe, expect, it } from "vitest";
import type { ExpectedOutput } from "@synap/playbooks";
import { projectOwedSlots } from "../../focus-sessions/owed-outputs.js";
import { signalFromCluster, signalFromOwedSlot } from "../needs-you-union.js";
import type { ProposalCluster } from "../../proposals/fingerprint.js";

const NOW = new Date("2026-11-04T12:00:00.000Z");
const AGENT = "agent-user-1";
const inMinutes = (m: number) =>
  new Date(NOW.getTime() + m * 60_000).toISOString();

const ask = (extra: Record<string, unknown> = {}) =>
  ({
    kind: "ask",
    label: "Publish the post?",
    owner: "human",
    blockedReason: "decision",
    owedSince: "2026-11-04T11:00:00.000Z",
    askedBy: AGENT,
    ask: { mode: "confirm", ...extra },
  }) as ExpectedOutput;

/** A live session the agent stopped on 10 minutes ago: the headline. */
function signalOf(
  slot: ExpectedOutput,
  facts: { lastAgentActivityAt: string | null; turnInFlight?: boolean } = {
    lastAgentActivityAt: "2026-11-04T11:50:00.000Z",
  }
) {
  const [owed] = projectOwedSlots(
    {
      id: "11111111-1111-4111-8111-111111111111",
      goal: "Launch week",
      status: "active",
      workspaceId: null,
      projectId: null,
      expectedOutputs: [slot],
      lastAgentActivityAt: facts.lastAgentActivityAt,
      lastAgentWorkAt: facts.lastAgentActivityAt,
      turnInFlight: facts.turnInFlight ?? false,
      startedAt: "2026-11-04T09:00:00.000Z",
    } as never,
    NOW
  );
  expect(owed, "the slot is owed").toBeDefined();
  return signalFromOwedSlot(owed!, NOW);
}

describe("signal.priority on the needs-you read", () => {
  it("a headline ask is P1", () => {
    const s = signalOf(ask());
    expect(s.needsYouClass).toBe("needs_you");
    expect(s.priority).toBe("P1");
  });

  it("a headline ask due within the hour is P0 (the stored answerBy reaches the rule)", () => {
    expect(signalOf(ask({ answerBy: inMinutes(30) })).priority).toBe("P0");
  });

  it("urgency 'whenever' holds a headline ask at P2, even due now", () => {
    expect(
      signalOf(ask({ urgency: "whenever", answerBy: inMinutes(5) })).priority
    ).toBe("P2");
  });

  it("an ask while the agent is still working is P2, whatever its deadline", () => {
    const s = signalOf(ask({ answerBy: inMinutes(5), urgency: "now" }), {
      lastAgentActivityAt: "2026-11-04T11:50:00.000Z",
      turnInFlight: true,
    });
    expect(s.needsYouClass).toBe("working");
    expect(s.priority).toBe("P2");
  });

  it("a classified proposal cluster carries its class's level", () => {
    const cluster = {
      fingerprint: "fp",
      count: 1,
      latestAt: NOW,
      sampleProposalIds: ["p1"],
      class: "data",
      lifetimeHours: null,
      needsYouClass: "changes_to_review",
    } as unknown as ProposalCluster;
    expect(signalFromCluster(cluster, NOW).priority).toBe("P2");
    expect(
      signalFromCluster({ ...cluster, needsYouClass: "needs_you" }, NOW)
        .priority
    ).toBe("P1");
  });
});
