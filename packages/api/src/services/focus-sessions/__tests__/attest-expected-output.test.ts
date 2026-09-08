/**
 * ATTESTATION — "I did this", the discharge verb for a human-owned slot.
 *
 * Two things are being guarded. The FLOORS (`selectSlotToAttest`): an
 * attestation may only close a slot the human actually owns, or the verb becomes
 * a way to close an agent's work with a receipt claiming a person did it. And
 * the STAMP (`stampAttested`): it must be distinguishable from an approval, and
 * must not erase the record of who owed the slot and since when.
 */
import { describe, it, expect } from "vitest";
import type { ExpectedOutput } from "@synap/playbooks";
import {
  selectSlotToAttest,
  stampAttested,
  stampSatisfied,
} from "../satisfy-expected-output.js";
import { isOwedSlot } from "../owed-outputs.js";

const USER = "33333333-3333-3333-3333-333333333333";

const OWED: ExpectedOutput = {
  kind: "credential",
  label: "Stripe live key",
  owner: "human",
  blockedReason: "credential",
  why: "The restricted key for the live account",
  owedSince: "2026-09-01T09:00:00.000Z",
};

describe("selectSlotToAttest — the three floors", () => {
  it("picks the slot the human owns, matching the label trimmed + casefolded", () => {
    expect(selectSlotToAttest([OWED], "  stripe LIVE key ")).toEqual({
      index: 0,
    });
  });

  it("refuses a slot an AGENT still owes — the floor that matters", () => {
    const { owner: _o, ...agentOwned } = OWED;
    expect(
      selectSlotToAttest([agentOwned as ExpectedOutput], OWED.label)
    ).toEqual({ refused: "not_owed_by_you" });
    expect(
      selectSlotToAttest([{ ...OWED, owner: "agent" }], OWED.label)
    ).toEqual({ refused: "not_owed_by_you" });
  });

  it("refuses an already-delivered slot rather than overwriting its lineage", () => {
    expect(
      selectSlotToAttest([{ ...OWED, status: "done" }], OWED.label)
    ).toEqual({ refused: "already_done" });
  });

  it("refuses a label this session does not declare, and an empty one", () => {
    expect(selectSlotToAttest([OWED], "Something else")).toEqual({
      refused: "unknown_label",
    });
    expect(selectSlotToAttest([OWED], "   ")).toEqual({
      refused: "unknown_label",
    });
  });

  it("attests a slot on a session that closed LONG ago", () => {
    // There is no age term in the selector at all, and that is the point: the
    // proposal path's 24h window is about an approval being evidence for a
    // session's work. A human saying "I minted the key" is evidence about that
    // slot whenever it lands — and owed slots by nature pile up on old sessions.
    expect(selectSlotToAttest([OWED], OWED.label)).toEqual({ index: 0 });
  });
});

describe("stampAttested — the receipt", () => {
  it("stamps done + WHO and WHEN, and never a fake proposal id", () => {
    const [slot] = stampAttested(
      [OWED],
      0,
      USER,
      new Date("2026-09-08T12:00:00Z")
    );
    expect(slot).toMatchObject({
      status: "done",
      attestedBy: USER,
      attestedAt: "2026-09-08T12:00:00.000Z",
    });
    // Dressing an attestation as approval lineage would make it unfalsifiable.
    expect(slot!.satisfiedByProposalId).toBeUndefined();
  });

  it("is tellable apart from an approval stamp", () => {
    const [attested] = stampAttested([OWED], 0, USER);
    const [approved] = stampSatisfied([OWED], 0, "p-1");
    expect(attested!.status).toBe("done");
    expect(approved!.status).toBe("done");
    expect(attested!.attestedBy).toBeDefined();
    expect(approved!.attestedBy).toBeUndefined();
    expect(approved!.satisfiedByProposalId).toBe("p-1");
  });

  it("KEEPS `owner` and `owedSince` — the receipt is who owed it and since when", () => {
    const [slot] = stampAttested([OWED], 0, USER);
    expect(slot!.owner).toBe("human");
    expect(slot!.owedSince).toBe("2026-09-01T09:00:00.000Z");
    expect(slot!.blockedReason).toBe("credential");
  });

  it("takes the slot off the owed board — via `status`, not via erasure", () => {
    const [slot] = stampAttested([OWED], 0, USER);
    expect(isOwedSlot(slot!)).toBe(false);
  });

  it("leaves every other slot untouched", () => {
    const others: ExpectedOutput[] = [
      OWED,
      { kind: "doc", label: "Runbook" },
      { ...OWED, label: "Signed DPA" },
    ];
    const next = stampAttested(others, 0, USER);
    expect(next[1]).toEqual(others[1]);
    expect(next[2]).toEqual(others[2]);
  });
});
