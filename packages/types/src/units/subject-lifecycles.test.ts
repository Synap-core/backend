/**
 * The three subjects that joined the transition door in reactions W1 — a
 * playbook run, a proposal and an owed slot — each read ONE declaration of
 * their categories (founder decision D9, 17 Nov 2026).
 */
import { describe, it, expect } from "vitest";
import {
  PLAYBOOK_RUN_STATUSES,
  RUN_STATUS_DECLARATION,
  runStatusCategory,
} from "./run-status.js";
import {
  PROPOSAL_STATUS_DECLARATION,
  proposalStatusCategory,
} from "./proposal-status.js";
import { PROPOSAL_STATUSES } from "../proposals/attention.js";
import {
  SLOT_STATUSES,
  SLOT_STATUS_DECLARATION,
  slotStatusOf,
  slotSubjectId,
} from "./deliverable.js";

describe("run lifecycle (D9)", () => {
  it("classifies every stored status, proposed as paused", () => {
    expect(Object.keys(RUN_STATUS_DECLARATION).sort()).toEqual(
      [...PLAYBOOK_RUN_STATUSES].sort()
    );
    expect(runStatusCategory("proposed")).toBe("paused");
    expect(runStatusCategory("waiting_on_you")).toBe("paused");
    expect(runStatusCategory("stale")).toBe("paused");
    expect(runStatusCategory("running")).toBe("active");
    expect(runStatusCategory("completed")).toBe("done");
    expect(runStatusCategory("failed")).toBe("lost");
    expect(runStatusCategory("cancelled")).toBe("lost");
    expect(runStatusCategory("nope")).toBeNull();
    expect(runStatusCategory(null)).toBeNull();
  });
});

describe("proposal lifecycle (D9)", () => {
  it("classifies every stored status, approval_failed as open", () => {
    expect(Object.keys(PROPOSAL_STATUS_DECLARATION).sort()).toEqual(
      [...PROPOSAL_STATUSES].sort()
    );
    expect(proposalStatusCategory("pending")).toBe("open");
    expect(proposalStatusCategory("approval_failed")).toBe("open");
    expect(proposalStatusCategory("approved")).toBe("done");
    expect(proposalStatusCategory("auto_approved")).toBe("done");
    for (const lost of ["rejected", "expired", "withdrawn", "reverted"]) {
      expect(proposalStatusCategory(lost)).toBe("lost");
    }
  });
});

describe("slot lifecycle (D9): derived, never stored", () => {
  it("declares every derived status: owed open, answered and done done, retired lost", () => {
    expect(Object.keys(SLOT_STATUS_DECLARATION).sort()).toEqual(
      [...SLOT_STATUSES].sort()
    );
    expect(SLOT_STATUS_DECLARATION.owed.category).toBe("open");
    expect(SLOT_STATUS_DECLARATION.answered.category).toBe("done");
    expect(SLOT_STATUS_DECLARATION.done.category).toBe("done");
    expect(SLOT_STATUS_DECLARATION.retired.category).toBe("lost");
  });

  it("reads the owed rule: the person's ask is owed, the session's pending", () => {
    expect(slotStatusOf({ owner: "human" })).toBe("owed");
    expect(slotStatusOf({ owner: "agent" })).toBe("pending");
    // The pre-`owner` corpus is the session's, never dropped.
    expect(slotStatusOf({})).toBe("pending");
    expect(slotStatusOf({ optional: true })).toBe("pending");
  });

  it("an answer handed back is answered; a decided answer is done", () => {
    expect(
      slotStatusOf({ answer: { value: "yes", answeredAt: "2026-11-17" } })
    ).toBe("answered");
    expect(slotStatusOf({ answer: {} })).toBe("pending");
    expect(
      slotStatusOf({
        decisionId: "d-1",
        answer: { value: "yes", askSnapshot: { mode: "confirm" } },
      })
    ).toBe("done");
  });

  it("delivered wins over retired; retired wins over the owner", () => {
    expect(slotStatusOf({ status: "done", retiredAt: "2026-11-17" })).toBe(
      "done"
    );
    expect(slotStatusOf({ owner: "human", retiredAt: "2026-11-17" })).toBe(
      "retired"
    );
  });

  it("names a slot `<session>/<key>`, the label when there is no key", () => {
    expect(slotSubjectId("s-1", { key: "brief", label: "Brief" })).toBe(
      "s-1/brief"
    );
    expect(slotSubjectId("s-1", { label: "Brief" })).toBe("s-1/Brief");
    expect(slotSubjectId("s-1", {})).toBeNull();
  });
});
