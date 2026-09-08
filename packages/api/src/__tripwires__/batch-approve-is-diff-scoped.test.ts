import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/**
 * TRIPWIRE — `proposals.batchApprove` must be diff-scoped, like single approve.
 *
 * THE DEFECT (found 2026-09-07 by dogfooding relay, the PRIMARY approval
 * surface): single `approve` has carried `expectedRevision` since Slice 5 and
 * calls `assertReviewedRevision` before acting. `batchApprove` never got the
 * field — its input was `{proposalIds, comment?}`. So the BULK control, where a
 * human commits many decisions at once and is LEAST likely to have re-read each
 * row, was the only approve path with no consent binding at all: a proposal
 * revised after the queue rendered would be approved against content nobody saw.
 *
 * Relay's grouped-approve screen could therefore not be guarded no matter what
 * the client sent — the field did not exist on the door.
 *
 * WHY A SOURCE SCAN: this is a DB-backed tRPC procedure and there is no migrated
 * local Postgres, so the behavioural assertion cannot RUN on the gate — and a
 * guard that does not run is not a guard. Scanned in the same spirit as
 * `approve-path-carries-actor.test.ts`.
 */
const ROUTER = readFileSync(
  join(__dirname, "..", "routers", "proposals.ts"),
  "utf8"
);

/** The batchApprove procedure body, bounded by the next top-level procedure. */
function batchApproveBlock(): string {
  const start = ROUTER.indexOf("batchApprove: protectedProcedure");
  expect(start, "batchApprove not found in proposals.ts").toBeGreaterThan(-1);
  const next = ROUTER.indexOf("protectedProcedure", start + 40);
  return ROUTER.slice(start, next === -1 ? start + 8000 : next);
}

describe("tripwire: batchApprove is diff-scoped", () => {
  it("accepts a PER-PROPOSAL expected-revision map", () => {
    // A map, not an array: positional pairing with `proposalIds` would silently
    // mis-bind if a caller filtered one list and not the other — the very class
    // of defect this guard exists to catch.
    expect(
      batchApproveBlock(),
      "batchApprove must accept `expectedRevisions` keyed by proposalId"
    ).toMatch(/expectedRevisions:\s*z\s*\.?\s*record\(/);
  });

  it("ASSERTS the revision before acting on each item", () => {
    const block = batchApproveBlock();
    expect(
      block,
      "batchApprove must call assertReviewedRevision — accepting the field " +
        "without asserting it is worse than not accepting it, because the " +
        "caller then believes it is protected"
    ).toMatch(/assertReviewedRevision\(/);

    // ORDER is the real guarantee: an assertion after the state transition
    // would refuse a write that already happened.
    const assertAt = block.indexOf("assertReviewedRevision(");
    const statusGuard = block.indexOf("ProposalStatus.PENDING");
    expect(assertAt, "assertReviewedRevision not found").toBeGreaterThan(-1);
    expect(statusGuard, "status guard not found").toBeGreaterThan(-1);
    expect(
      assertAt,
      "the revision assert must precede the status transition"
    ).toBeLessThan(statusGuard);
  });

  it("does NOT fabricate a revision for an omitted id", () => {
    // `?? 0` would satisfy a naive "mentions expectedRevisions" check while
    // positively claiming the human read revision zero — which PASSES the guard
    // for every never-revised proposal. Omission must stay a no-op.
    expect(
      batchApproveBlock(),
      "an omitted id must not default to 0 — that claims a review that never happened"
    ).not.toMatch(/expectedRevisions[^\n]*\?\?\s*0/);
  });

  it("NON-VACUITY: single approve still has its own guard", () => {
    // If this scan ever finds nothing, the assertions above are trivially true.
    // Pin the sibling so a rename or refactor fails loudly rather than green.
    expect(
      ROUTER.match(/assertReviewedRevision\(/g)?.length ?? 0,
      "expected assertReviewedRevision on BOTH approve doors"
    ).toBeGreaterThanOrEqual(2);
  });
});

/**
 * TRIPWIRE — every `batchApprove` failure must carry a per-item `errorCode`.
 *
 * THE DEFECT (2026-09-08): the per-item results carried only `{proposalId,
 * success, error?}` — a bare STRING. Single `approve` refuses a stale revision
 * with a real tRPC `CONFLICT` code; batch flattened every failure into prose, so
 * a client could not tell "this changed since you reviewed it" (⇒ reload and
 * re-decide) from "the pod refused for another reason" (⇒ a different action)
 * except by matching message text. Relay had to regex the sentence, and
 * rewording the guard would have silently disabled that branch — the exact
 * failure mode `browser/`'s message-alone test exists to prevent, which batch
 * had no equivalent of because it had no code.
 *
 * WHY A SOURCE SCAN: same reason as the block above — DB-backed tRPC procedure,
 * no migrated local Postgres, so the behavioural assertion cannot run on the
 * gate.
 */
describe("tripwire: batchApprove reports a per-item errorCode", () => {
  /** Every `results.push({...})` literal inside the batchApprove body. */
  function resultPushes(): string[] {
    const block = batchApproveBlock();
    const found: string[] = [];
    const NEEDLE = "results.push({";
    let at = block.indexOf(NEEDLE);
    while (at !== -1) {
      // Brace-match from the object literal's `{` so a nested object (none
      // today, but a `data: {…}` tomorrow) cannot truncate the capture — the
      // `[^}]*` shortcut is how a sibling tripwire went blind once.
      let depth = 0;
      let end = at + NEEDLE.length - 1;
      for (let i = end; i < block.length; i++) {
        if (block[i] === "{") depth++;
        else if (block[i] === "}") {
          depth--;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
      found.push(block.slice(at, end + 1));
      at = block.indexOf(NEEDLE, end);
    }
    return found;
  }

  it("NON-VACUITY: the scan finds the door's result pushes", () => {
    expect(
      resultPushes().length,
      "expected batchApprove to push per-item results"
    ).toBeGreaterThanOrEqual(3);
  });

  it("declares errorCode on the per-item result type", () => {
    expect(
      batchApproveBlock(),
      "the results array must declare `errorCode` — a conditional spread would " +
        "compile with a misspelled field, a declared property will not"
    ).toMatch(/errorCode\?:\s*TRPCError\["code"\]/);
  });

  it("EVERY failure push carries a code — no branch may set error alone", () => {
    for (const push of resultPushes()) {
      if (!/success:\s*false/.test(push)) continue;
      expect(
        push,
        "a `success: false` push without `errorCode` re-creates the gap for " +
          `that case:\n${push}`
      ).toMatch(/errorCode/);
    }
  });

  it("DERIVES the code from the thrown TRPCError, not a per-branch table", () => {
    const block = batchApproveBlock();
    // The single derivation site. A hand-assigned string per branch would be a
    // second table that drifts from the messages — the documented failure mode
    // in this codebase.
    expect(
      block,
      "the loop's catch must read `.code` off the thrown TRPCError"
    ).toMatch(/error instanceof TRPCError\s*\?\s*error\.code/);

    // And the refusals must actually THROW, so there IS a code to read.
    expect(
      block.match(/throw new TRPCError\(/g)?.length ?? 0,
      "not-found, terminal-status and not-authorized must each throw a TRPCError"
    ).toBeGreaterThanOrEqual(3);
  });

  it("keeps CONFLICT meaning the REVISION guard and nothing else", () => {
    // A terminal-status row is a settled fact (`PRECONDITION_FAILED`), not a
    // diff-scoped review conflict. Collapsing the two would make "already
    // approved" demand a reload it does not need and would blunt the one signal
    // the revision binding exists to send.
    const block = batchApproveBlock();
    expect(block).toMatch(/code:\s*"PRECONDITION_FAILED"/);
    expect(
      block,
      "batchApprove must not mint its own CONFLICT — the revision guard owns it"
    ).not.toMatch(/code:\s*"CONFLICT"/);
  });
});
