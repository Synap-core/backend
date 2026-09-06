import { describe, expect, it } from "vitest";
import {
  computeReviewQueueApproval,
  reviewQueueVerdict,
  MIN_CONFIDENT_REVIEW_SAMPLE,
  type ReviewQueueDecisionRow,
} from "./review-queue.js";

/**
 * Locks the PURE heart of the review-queue approval rate. The DB tier only
 * feeds rows into this; if the denominator is right here, the number is right.
 */

const NONE = { autoApprovedNeverReviewed: 0, truncated: false };

function decided(status: string, data: unknown = {}): ReviewQueueDecisionRow {
  return { status, data };
}

/** A row the reviewer approved after DENYING one of its items. */
const gutted = decided("approved", {
  dispositions: { a: { status: "approve" }, b: { status: "reject" } },
});

describe("computeReviewQueueApproval", () => {
  it("counts a PARTIAL approval as not-approved, but keeps it in the denominator", () => {
    const a = computeReviewQueueApproval(
      [decided("approved"), decided("approved"), gutted, decided("rejected")],
      NONE
    );
    expect(a.approvedInFull).toBe(2);
    expect(a.approvedWithItemsDenied).toBe(1);
    expect(a.rejected).toBe(1);
    // Denominator = every human decision, INCLUDING the gutted one.
    expect(a.reviewed).toBe(4);
    expect(a.approveRateOfReviewed).toBe(0.5);
    // Dropping the partial instead would have read 2/3 = 0.6667 — strictly
    // higher. Keeping it in can only ever LOWER the rate, never raise it.
    expect(a.approveRateOfReviewed).toBeLessThan(2 / 3);
  });

  it("reports a STATED zero-sample rather than a fake 0% or 100%", () => {
    const empty = computeReviewQueueApproval([], NONE);
    expect(empty.reviewed).toBe(0);
    expect(empty.approveRateOfReviewed).toBeNull();
    expect(empty.lowSample).toBe(true);
    expect(reviewQueueVerdict(empty)).toBe("unknown");

    // A pod with only PENDING rows has decided nothing — same answer.
    const pendingOnly = computeReviewQueueApproval(
      [decided("pending"), decided("pending")],
      NONE
    );
    expect(pendingOnly.reviewed).toBe(0);
    expect(pendingOnly.approveRateOfReviewed).toBeNull();
  });

  it("EXCLUDES auto-approved from both sides — it never reached the human", () => {
    // 3 human decisions (2 yes, 1 no) alongside 50 auto-approved writes.
    const a = computeReviewQueueApproval(
      [
        decided("approved"),
        decided("approved"),
        decided("rejected"),
        // Defensive: even if an auto_approved row leaks into the scan, the
        // denominator is defined here, not upstream.
        decided("auto_approved"),
        decided("withdrawn"),
        decided("expired"),
      ],
      { autoApprovedNeverReviewed: 50, truncated: false }
    );
    expect(a.reviewed).toBe(3);
    expect(a.approveRateOfReviewed).toBe(0.6667);
    // Reported, so the exclusion is auditable rather than silent.
    expect(a.autoApprovedNeverReviewed).toBe(50);
  });

  it("the denominator matches its name: reviewed === full + partial + rejected", () => {
    const rows: ReviewQueueDecisionRow[] = [
      ...Array.from({ length: 7 }, () => decided("approved")),
      gutted,
      gutted,
      decided("rejected"),
      decided("pending"),
      decided("auto_approved"),
    ];
    const a = computeReviewQueueApproval(rows, NONE);
    expect(a.reviewed).toBe(
      a.approvedInFull + a.approvedWithItemsDenied + a.rejected
    );
    expect(a.reviewed).toBe(10);
  });

  it("refuses a confident verdict on a small sample", () => {
    // 4 decisions, all yes — a naive read says "100%, the queue is theatre".
    const tiny = computeReviewQueueApproval(
      Array.from({ length: 4 }, () => decided("approved")),
      NONE
    );
    expect(tiny.approveRateOfReviewed).toBe(1);
    expect(tiny.lowSample).toBe(true);
    expect(reviewQueueVerdict(tiny)).toBe("unknown");

    // The same rate over a credible sample IS the finding.
    const big = computeReviewQueueApproval(
      Array.from({ length: MIN_CONFIDENT_REVIEW_SAMPLE }, () =>
        decided("approved")
      ),
      NONE
    );
    expect(big.lowSample).toBe(false);
    expect(reviewQueueVerdict(big)).toBe("approval_fatigue");
  });

  it("a queue that says no is `discriminating`, not a fault", () => {
    const a = computeReviewQueueApproval(
      [
        ...Array.from({ length: 15 }, () => decided("approved")),
        ...Array.from({ length: 10 }, () => decided("rejected")),
      ],
      NONE
    );
    expect(a.approveRateOfReviewed).toBe(0.6);
    expect(reviewQueueVerdict(a)).toBe("discriminating");
  });
});
