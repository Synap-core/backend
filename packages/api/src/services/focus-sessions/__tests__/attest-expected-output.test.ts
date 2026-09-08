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

describe("selectSlotToAttest — a RETIRED slot is not dischargeable", () => {
  /**
   * A cancelled session STAMPS its owed slots (`retiredAt` + `retiredReason`)
   * rather than deleting them — deliberately, so the record stays readable. That
   * keeps them reachable BY LABEL, which is how the attest door addresses a
   * slot, and nothing here refused them: attesting one minted an
   * `attestedBy`/`attestedAt` receipt asserting a person delivered work that had
   * been called off. Afterwards both stamps stand and neither falsifies the
   * other.
   *
   * The owed READ (`isOwedSlot`) already drops retired slots, so this never
   * showed on a "needs you" surface — which is exactly why it needed a floor at
   * the door rather than a filter upstream.
   */
  const RETIRED: ExpectedOutput = {
    ...OWED,
    retiredAt: "2026-09-05T10:00:00.000Z",
    retiredReason: "session_cancelled",
  };

  it("refuses a retired slot", () => {
    expect(selectSlotToAttest([RETIRED], OWED.label)).toEqual({
      refused: "retired",
    });
  });

  it("is not reachable through the owed read either — belt and braces", () => {
    expect(isOwedSlot(RETIRED)).toBe(false);
  });

  it("still accepts the SAME slot before it was retired", () => {
    // The discriminating pair: identical but for the stamp. Without it, a test
    // asserting only the refusal would pass on a door that refused everything.
    expect(selectSlotToAttest([OWED], OWED.label)).toEqual({ index: 0 });
  });

  it("refuses on `retiredAt` alone, not on the reason", () => {
    const { retiredReason: _drop, ...noReason } = RETIRED;
    expect(
      selectSlotToAttest([noReason as ExpectedOutput], OWED.label)
    ).toEqual({ refused: "retired" });
  });
});

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
