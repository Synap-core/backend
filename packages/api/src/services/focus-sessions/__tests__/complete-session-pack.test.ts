/**
 * Gate 2 — complete returns proposal pack shape (unit-level pure helpers).
 * Service integration needs DB; this pins packItem-adjacent contracts via types.
 */
import { describe, it, expect } from "vitest";
import type {
  CompleteFocusSessionResult,
  ProposalPackItem,
} from "../complete-session.js";

describe("completeFocusSession pack types", () => {
  it("pack item shape is listable", () => {
    const item: ProposalPackItem = {
      id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      status: "pending",
      proposalType: "create",
      summary: "Create entity X",
      workspaceId: null,
      createdAt: new Date(),
    };
    expect(item.id).toBeTruthy();
  });

  it("result includes counts and warnings", () => {
    const result: CompleteFocusSessionResult = {
      session: { id: "s1" } as CompleteFocusSessionResult["session"],
      pendingProposals: [],
      counts: { pending: 0, unfinishedOutputs: 2, expiredEphemerals: 0 },
      warnings: [
        "2 expected output(s) still not marked done — session closed anyway (warn-only).",
      ],
    };
    expect(result.counts.unfinishedOutputs).toBe(2);
    // Closing a session retires its unanswered EPHEMERAL proposals (a
    // capability run is bound to the session and stops being answerable when it
    // ends). Reported here so the retirement is never silent — a silent drop is
    // the lying-count defect the old default TTL was removed for.
    expect(result.counts.expiredEphemerals).toBe(0);
    expect(result.warnings[0]).toMatch(/warn-only/);
  });
});
