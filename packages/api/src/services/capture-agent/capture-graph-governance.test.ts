/**
 * A capture graph is scored with the signals each member's OWN door gates on —
 * including the born-status lifecycle floor `entities.create` applies.
 *
 * MEASURED DEFECT (live, 2026-10-18): five agent captures of one decision born
 * `accepted` (a done-category option) auto-applied: this pre-check asked the
 * resolver without the floor and got "execute", while each inner
 * `entities.create` asked WITH it (LIFECYCLE_TERMINAL) and filed a pending
 * proposal. The materializer then failed on the missing id ("No values to
 * set"): five failed receipts AND five pending duplicates (6253b035→a45e9a3a,
 * bf5c7e94→ee5fd394, 5dc1d238→63d6e707, 59a4d97e→fe1a3ebd, 7ad8bdde→c5dede63).
 *
 * Seam: the REAL floor derivation (`initialCreateStatusFloorOfSlug` →
 * `initialStatusFloor` → `classifyStatusMove`, over a stubbed kind lookup)
 * feeding the resolver call. The resolver stand-in answers like the policy's
 * lifecycle rung: propose iff it is handed a closing/person-only move — so a
 * pre-check that drops the floor is GREEN-on-"execute" and fails these rows.
 *
 * Rows that rule out a wrong rule:
 *  - born `accepted` (done) ⇒ proposes (the defect: executed);
 *  - born `proposed` (open) ⇒ executes (rules out "any decision proposes");
 *  - status left to the kind's default `accepted` ⇒ proposes (the default is
 *    the born status too, as at the create door);
 *  - kind lookup fails ⇒ proposes, resolver never asked (unmeasured is not
 *    "no floor").
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  resolve: vi.fn(),
  resolveProfile: vi.fn(),
}));

const LIFECYCLE = {
  propertySlug: "decisionStatus",
  propertyDefId: "def-1",
  declaredOnProfileId: "p-decision",
  unclassified: [],
  options: [
    { key: "proposed", category: "open" },
    { key: "accepted", category: "done" },
  ],
};

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    ProfileResolutionService: class {
      resolveProfile = h.resolveProfile;
      async getEffectiveLifecycle() {
        return LIFECYCLE;
      }
    },
  };
});

vi.mock("@synap/database/agent-governance", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@synap/database/agent-governance")
  >()),
  resolveAgentGovernanceDecision: h.resolve,
}));

import { captureGraphMemberProposes } from "./capture-graph-governance.js";

const decision = (properties: Record<string, unknown>) =>
  ({
    op: "create_entity",
    ref: "e0",
    profileSlug: "decision",
    title: "Synap messaging",
    properties,
  }) as never;

const ask = (operations: never[]) =>
  captureGraphMemberProposes({
    agentUserId: "agent-1",
    userId: "user-1",
    workspaceId: "ws-1",
    operations,
  });

describe("capture graph member governance carries the born-status floor", () => {
  beforeEach(() => {
    h.resolveProfile
      .mockReset()
      .mockResolvedValue({ id: "p-decision", defaultValues: {} });
    h.resolve
      .mockReset()
      .mockImplementation(
        async (args: {
          lifecycleMove?: { intoTerminal: boolean; humanOnly: boolean };
        }) => ({
          decision:
            args.lifecycleMove?.intoTerminal || args.lifecycleMove?.humanOnly
              ? "propose"
              : "execute",
        })
      );
  });

  it("a decision born `accepted` proposes, and the resolver was told why", async () => {
    expect(await ask([decision({ decisionStatus: "accepted" })])).toBe(true);
    expect(h.resolve).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectType: "entity",
        action: "create",
        subjectProfileSlug: "decision",
        lifecycleMove: { intoTerminal: true, humanOnly: false },
      })
    );
  });

  it("a decision born `proposed` executes", async () => {
    expect(await ask([decision({ decisionStatus: "proposed" })])).toBe(false);
    expect(h.resolve.mock.calls[0]![0]).not.toHaveProperty("lifecycleMove");
  });

  it("the kind's default status is the born status", async () => {
    h.resolveProfile.mockResolvedValue({
      id: "p-decision",
      defaultValues: { decisionStatus: "accepted" },
    });
    expect(await ask([decision({})])).toBe(true);
  });

  it("an unreadable kind proposes without asking the resolver", async () => {
    h.resolveProfile.mockRejectedValue(new Error("db down"));
    expect(await ask([decision({ decisionStatus: "proposed" })])).toBe(true);
    expect(h.resolve).not.toHaveBeenCalled();
  });
});
