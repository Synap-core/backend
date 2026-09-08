/**
 * THE OWNERSHIP PAIR — handing one declared deliverable to the human, and
 * taking it back.
 *
 * `mergeExpectedOutputs` cannot express either move. Inside
 * `SERVER_OWNED_OUTPUT_FIELDS` silence means KEEP, so nothing can ever unset
 * `owner`; outside it, every wholesale patch by a client that has not heard of
 * the field ERASES it. So the codebase's answer is a targeted stamper, the same
 * shape `stampDelegated`/`stampReturned` already are — and these pin the four
 * properties that make the pair honest:
 *
 *   1. all four ownership fields move TOGETHER, both ways;
 *   2. `owedSince` is server-observed, never caller-authored, and does not reset
 *      when the same blocker is re-declared;
 *   3. neither ever writes `status` — declaring you cannot do the work is the
 *      opposite of having done it;
 *   4. the agent may not `completeOutput` a slot it handed to the human.
 *
 * Pure functions only — the DB half is the two lines of `updateExpectedOutputsLocked`
 * its siblings already share.
 */
import { describe, it, expect } from "vitest";
import type { ExpectedOutput } from "@synap/playbooks";
import { stampBlocked, stampUnblocked } from "../block-output.js";
import { applyOutputMutations } from "../update-session.js";

const AT = new Date("2026-09-08T09:00:00.000Z");

const slots = (): ExpectedOutput[] => [
  { kind: "document", label: "Launch brief", delegatedTo: "researcher" },
  { kind: "entity", label: "Signed NDA" },
];

describe("stampBlocked — the slot becomes the human's", () => {
  it("writes owner, reason, why and owedSince together", () => {
    const [, blocked] = stampBlocked(
      slots(),
      "Signed NDA",
      "physical",
      "Someone has to sign the paper copy",
      AT
    );
    expect(blocked).toEqual({
      kind: "entity",
      label: "Signed NDA",
      owner: "human",
      blockedReason: "physical",
      why: "Someone has to sign the paper copy",
      owedSince: AT.toISOString(),
    });
  });

  it("never stamps status — a blocker is not a delivery", () => {
    const [, blocked] = stampBlocked(slots(), "Signed NDA", "decision");
    expect(blocked).not.toHaveProperty("status");
  });

  it("matches the label trimmed + case-insensitively, and only that slot", () => {
    const [untouched, blocked] = stampBlocked(
      slots(),
      "  signed nda ",
      "credential"
    );
    expect(blocked.owner).toBe("human");
    // The sibling keeps its delegation — a stamp on one slot is a stamp on one.
    expect(untouched).toEqual({
      kind: "document",
      label: "Launch brief",
      delegatedTo: "researcher",
    });
  });

  it("carries every OTHER field of the slot through — spread, never re-list", () => {
    const stored: ExpectedOutput = {
      kind: "entity",
      label: "Signed NDA",
      icon: "file",
      claimedDone: true,
      delegatedTo: "researcher",
      delegatedAt: "2026-09-07T10:00:00.000Z",
      returnedReason: "Missing the numbers",
      returnedAt: "2026-09-07T11:00:00.000Z",
    };
    const [blocked] = stampBlocked([stored], "Signed NDA", "policy", null, AT);
    expect(blocked).toMatchObject(stored);
    expect(blocked.owner).toBe("human");
  });

  it("does not reset owedSince when the same blocker is re-declared", () => {
    const once = stampBlocked(slots(), "Signed NDA", "physical", "a", AT);
    const twice = stampBlocked(
      once,
      "Signed NDA",
      "physical",
      "a",
      new Date("2026-09-09T09:00:00.000Z")
    );
    // The owed feed ages rows by this stamp; re-declaring must not make the
    // oldest owed slot look brand new.
    expect(twice[1]!.owedSince).toBe(AT.toISOString());
  });

  it("drops a blank `why` rather than storing an empty line", () => {
    const [, blocked] = stampBlocked(slots(), "Signed NDA", "decision", "   ");
    expect(blocked).not.toHaveProperty("why");
  });
});

describe("stampUnblocked — the agent takes it back", () => {
  it("clears all four ownership fields together", () => {
    const blocked = stampBlocked(
      slots(),
      "Signed NDA",
      "credential",
      "key",
      AT
    );
    const [, reclaimed] = stampUnblocked(blocked, "Signed NDA");
    expect(reclaimed).toEqual({ kind: "entity", label: "Signed NDA" });
  });

  it("DELETES owner rather than writing 'agent'", () => {
    // An absent `owner` and a stored `agent` must stay indistinguishable, or
    // "the agent never said" stops being readable.
    const blocked = stampBlocked(slots(), "Signed NDA", "credential", "k", AT);
    const [, reclaimed] = stampUnblocked(blocked, "Signed NDA");
    expect(Object.keys(reclaimed)).not.toContain("owner");
  });

  it("leaves the deliverable itself — and every other slot — alone", () => {
    const blocked = stampBlocked(slots(), "Signed NDA", "capability", "k", AT);
    const [sibling, reclaimed] = stampUnblocked(blocked, "signed nda");
    expect(sibling).toEqual(slots()[0]);
    expect(reclaimed.label).toBe("Signed NDA");
    expect(reclaimed).not.toHaveProperty("status");
  });
});

describe("completeOutput — the agent may not close the human's slot", () => {
  it("refuses to mark a human-owned slot done", () => {
    const stored = stampBlocked(slots(), "Signed NDA", "physical", "sign", AT);
    const [, after] = applyOutputMutations(stored, {
      completeOutput: "Signed NDA",
    });
    // `owner: 'human'` is the agent's own statement that it CANNOT do this. A
    // door that then lets the same caller mark it done makes the declaration a
    // way to close work nobody did.
    expect(after).not.toHaveProperty("status");
  });

  it("still completes a slot the agent owns", () => {
    const [after] = applyOutputMutations(slots(), {
      completeOutput: "Launch brief",
    });
    expect(after.status).toBe("done");
  });

  it("completes an unblocked slot once the agent has reclaimed it", () => {
    const blocked = stampBlocked(slots(), "Signed NDA", "physical", "s", AT);
    const reclaimed = stampUnblocked(blocked, "Signed NDA");
    const [, after] = applyOutputMutations(reclaimed, {
      completeOutput: "Signed NDA",
    });
    expect(after.status).toBe("done");
  });
});

describe("addOutput — declaring a blocked slot stamps its clock", () => {
  it("stamps owedSince when the new slot is declared human-owned", () => {
    const [added] = applyOutputMutations([], {
      addOutput: {
        kind: "entity",
        label: "Signed NDA",
        owner: "human",
        blockedReason: "physical",
        why: "Someone has to sign it",
      },
    });
    expect(added.owedSince).toEqual(expect.any(String));
    expect(added.status).toBe("pending");
  });

  it("leaves an ordinary new slot with no owner and no clock", () => {
    const [added] = applyOutputMutations([], {
      addOutput: { kind: "document", label: "Launch brief" },
    });
    expect(added).not.toHaveProperty("owner");
    expect(added).not.toHaveProperty("owedSince");
  });
});
