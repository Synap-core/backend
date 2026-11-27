/**
 * A Cal.com booking LANDS DIRECTLY under the default policy, and is proposed
 * in a space (or for an agent) tightened to propose — through the governance
 * primitive, never around it (founder, 26 Nov 2026: storing data from a
 * connected tool is a data-only create).
 *
 * Seam: the REAL booking mapper (with its attribution-event) → the REAL op
 * builder the submit door files (`buildCaptureGraphOperations`) → the REAL
 * all-or-nothing member scoring (`captureGraphMemberVerdict`, which
 * `submitCaptureGraph` uses to choose between auto-apply and a pending
 * proposal) → the REAL pure policy engine (`decideAgentPolicy`).
 *
 * Stubbed, and why: `resolveAgentGovernanceDecision`'s I/O half (reading the
 * agent row, the workspace and the `governance_rules` store) is replaced by a
 * stand-in that hands the engine what that read would find for the space
 * under test — the Capture agent's dial (`writesRequireProposal: false`,
 * `CAPTURE_AGENT_DEF`) and the rule verdict a space's rule would resolve to at
 * rung 2.8. The rule store's own matching has its own suites. Kind lookups
 * return no kind (no lifecycle floor), as for kinds without a lifecycle.
 *
 * Rows that rule out a wrong rule:
 *  - default space ⇒ applies (rules out "a booking is always a proposal", the
 *    behaviour this decision retires);
 *  - a space whose rule makes entity creates propose ⇒ proposes (rules out a
 *    hard bypass of governance);
 *  - a rule on the attribution-event KIND alone ⇒ the WHOLE booking proposes
 *    (rules out scoring the booking without its attribution member, and
 *    landing half a graph);
 *  - an agent dialled to propose its writes ⇒ proposes.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { decideAgentPolicy } from "@synap/governance-policy";

const h = vi.hoisted(() => ({
  space: {
    writesRequireProposal: false,
    rule: (_k: { action: string; subjectProfileSlug?: string | null }) =>
      undefined as "auto" | "propose" | undefined,
  },
  asked: [] as Array<{
    subjectType: string;
    action: string;
    subjectProfileSlug?: string | null;
  }>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    ProfileResolutionService: class {
      async resolveProfile() {
        return null;
      }
      async getEntityScope() {
        return "pod";
      }
    },
  };
});

vi.mock("@synap/database/agent-governance", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@synap/database/agent-governance")
  >()),
  resolveAgentGovernanceDecision: async (input: {
    subjectType: string;
    action: string;
    subjectProfileSlug?: string | null;
    forcePropose?: boolean;
    lifecycleMove?: { intoTerminal: boolean; humanOnly: boolean };
  }) => {
    h.asked.push({
      subjectType: input.subjectType,
      action: input.action,
      subjectProfileSlug: input.subjectProfileSlug,
    });
    const verdict = decideAgentPolicy({
      subjectType: input.subjectType,
      action: input.action,
      subjectProfileSlug: input.subjectProfileSlug,
      writesRequireProposal: h.space.writesRequireProposal,
      governanceRuleVerdict: h.space.rule(input),
      // Whatever floor the scoring door raises reaches the engine as is.
      forcePropose: input.forcePropose,
      lifecycleMove: input.lifecycleMove,
    });
    return verdict.verdict === "execute"
      ? { decision: "execute" }
      : verdict.verdict === "propose"
        ? {
            decision: "propose",
            reason: verdict.reason,
            reasonCode: verdict.reasonCode,
          }
        : { decision: "deny", reason: verdict.reason };
  },
}));

import { mapBookingToGraph } from "./map-booking-to-graph.js";
import { buildCaptureGraphOperations } from "../capture-agent/submit-capture-graph.js";
import { captureGraphMemberVerdict } from "../capture-agent/capture-graph-governance.js";

/** A BOOKING_CREATED `payload` as Cal.com sends it (corporate attendee). */
const BOOKING = {
  uid: "bk_launch_1",
  title: "Diagnosis call",
  startTime: "2026-12-01T09:00:00Z",
  endTime: "2026-12-01T09:30:00Z",
  attendees: [{ name: "Ada Lovelace", email: "ada@analytical.io" }],
  responses: {
    utm_source: { label: "utm_source", value: "linkedin", isHidden: true },
  },
};

async function bookingVerdict() {
  const graph = mapBookingToGraph(BOOKING, {
    attribution: { receivedAt: "2026-11-26T10:00:00Z" },
  });
  const operations = await buildCaptureGraphOperations({} as never, {
    entities: graph.entities,
    relations: graph.relations,
    projectId: null,
    workspaceId: "ws-1",
  });
  return captureGraphMemberVerdict({
    agentUserId: "capture-agent",
    userId: "owner-1",
    workspaceId: "ws-1",
    operations,
  });
}

describe("a Cal.com booking is governed, and lands directly by default", () => {
  beforeEach(() => {
    h.asked.length = 0;
    h.space.writesRequireProposal = false;
    h.space.rule = () => undefined;
  });

  it("default space: every member executes, so the booking is applied, not proposed", async () => {
    const verdict = await bookingVerdict();
    expect(verdict.proposes).toBe(false);
    // Non-vacuous: the attribution-event and its link were scored too.
    expect(h.asked).toContainEqual({
      subjectType: "entity",
      action: "create",
      subjectProfileSlug: "attribution-event",
    });
    expect(h.asked).toContainEqual(
      expect.objectContaining({ subjectType: "relation", action: "create" })
    );
    expect(h.asked).toContainEqual(
      expect.objectContaining({ subjectType: "facet", action: "attach" })
    );
  });

  it("a space whose rule makes creates propose: the booking is filed as a proposal", async () => {
    h.space.rule = (k) => (k.action === "create" ? "propose" : undefined);
    const verdict = await bookingVerdict();
    expect(verdict.proposes).toBe(true);
    expect(verdict.reasonCode).toBe("GOVERNANCE_RULE");
  });

  it("a rule on the attribution-event kind alone proposes the WHOLE booking (atomic)", async () => {
    h.space.rule = (k) =>
      k.subjectProfileSlug === "attribution-event" ? "propose" : undefined;
    expect((await bookingVerdict()).proposes).toBe(true);
  });

  it("an agent dialled to propose its writes: the booking is proposed", async () => {
    h.space.writesRequireProposal = true;
    expect((await bookingVerdict()).proposes).toBe(true);
  });
});
