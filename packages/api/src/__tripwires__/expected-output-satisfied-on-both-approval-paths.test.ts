import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/**
 * TRIPWIRE — BOTH approval paths satisfy expected outputs.
 *
 * `expected-output-done-one-door.test.ts` pins that only ONE door may stamp
 * `status: "done"`. This one pins the complementary half: that every path which
 * APPROVES a session-scoped agent write actually walks through that door.
 *
 * There are exactly TWO such paths, and they are siblings — not "propose vs
 * execute" in the request sense, but two ways an approval happens:
 *
 *   1. DEFERRED approval — a pending proposal a human later approves.
 *      `routers/proposals/apply-approval.ts` (the pending door's approval half).
 *   2. AUTO approval — `utils/permission-check.ts`'s `gov.decision ===
 *      "execute"` branch, where a governance rule (or the default lane) stands
 *      in for the human click and mints the AUTO_APPROVED receipt.
 *
 * NOTE ON THE PROPOSE BRANCH: `permission-check.ts`'s `gov.decision ===
 * "propose"` branch must NOT call the door. It creates a PENDING row; nothing
 * has been approved yet, and stamping there would re-create the "agent grades
 * its own homework" defect the door exists to remove. Its satisfaction arrives
 * later, via path (1). That asymmetry is asserted below so a future reader does
 * not "fix" it.
 *
 * WHY: path (2) was severed. The P1 provenance hoist taught the auto-approve
 * branch to mint/resolve a session and write full provenance, but never to
 * stamp — so a deliverable produced by an auto-approved write stayed `pending`
 * forever. Auto-approve is the MAJORITY of agent write traffic, which made a
 * session's expected outputs effectively unsatisfiable in practice.
 *
 * SOURCE-SCAN, not behavioural: a severance is an ABSENT call, and only a scan
 * of the source can see an absence.
 */

const API_SRC = join(process.cwd(), "src");

const read = (...seg: string[]) => readFileSync(join(API_SRC, ...seg), "utf8");

describe("tripwire: every approval path satisfies expected outputs", () => {
  it("the DEFERRED approval path (apply-approval) calls the door", () => {
    const applier = read("routers", "proposals", "apply-approval.ts");
    expect(applier).toMatch(
      /import\s*\{[^}]*satisfyExpectedOutputs[^}]*\}\s*from/
    );
    expect(applier).toMatch(/await satisfyExpectedOutputs\(\{/);
  });

  it("the AUTO-APPROVE path (permission-check) calls the door", () => {
    const check = read("utils", "permission-check.ts");
    expect(check).toMatch(
      /import\s*\{[^}]*satisfyExpectedOutputs[^}]*\}\s*from/
    );
    expect(check).toMatch(/await satisfyExpectedOutputs\(\{/);
  });

  it("the auto-approve call is inside the execute branch, after the receipt", () => {
    const check = read("utils", "permission-check.ts");
    const receipt = check.indexOf("autoApprovedProposalId = receipt?.id");
    const call = check.indexOf("await satisfyExpectedOutputs({");
    const grant = check.indexOf(
      "return { granted: true, autoApprovedProposalId };"
    );
    expect(receipt).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(receipt);
    expect(grant).toBeGreaterThan(call);
  });

  it("the auto-approve stamp carries the hoisted session AND the receipt's own id", () => {
    const check = read("utils", "permission-check.ts");
    const call = check.slice(
      check.indexOf("await satisfyExpectedOutputs({"),
      check.indexOf("await satisfyExpectedOutputs({") + 400
    );
    // The session the P1 hoist resolved — the same one the receipt row carries.
    expect(call).toMatch(/sessionId: governedSessionId/);
    // The SUBJECT of the write, matching how `apply-approval` reads
    // `proposal.targetType`. Anything else would satisfy the wrong deliverable.
    expect(call).toMatch(/targetType: subjectType/);
    // Lineage points at the receipt actually inserted, so the `done` is
    // falsifiable against a real row.
    expect(call).toMatch(/proposalId: autoApprovedProposalId/);
    // Guarded on BOTH — no session ⇒ nothing to satisfy; no receipt ⇒ the
    // lineage would dangle.
    expect(check).toMatch(
      /if \(governedSessionId && autoApprovedProposalId\) \{/
    );
  });

  it("BOTH call sites forward the SLOT CLAIM — the label, not just the kind", () => {
    // WHY: `selectOutputToSatisfy` falls back to the FIRST not-done output of
    // the matching kind. A session owing two documents therefore stamps the
    // WRONG deliverable unless the approval carries the label the proposal
    // claimed. Dropping the argument at either call site restores that bug
    // silently — every existing assertion above stays green — so it is pinned
    // by source scan, the only thing that can see an absent argument.
    const applier = read("routers", "proposals", "apply-approval.ts");
    const applierCall = applier.slice(
      applier.indexOf("await satisfyExpectedOutputs({"),
      applier.indexOf("await satisfyExpectedOutputs({") + 600
    );
    // The DEFERRED path reads the claim off the proposal row it is applying,
    // through the ONE reader (never a hand-rolled `data.expectedLabel` cast).
    expect(applierCall).toMatch(
      /expectedLabel: readProposalExpectedLabel\(args\.proposal\.data\)/
    );
    expect(applier).toMatch(
      /import\s*\{[^}]*readProposalExpectedLabel[^}]*\}\s*from/
    );

    const check = read("utils", "permission-check.ts");
    const checkCall = check.slice(
      check.indexOf("await satisfyExpectedOutputs({"),
      check.indexOf("await satisfyExpectedOutputs({") + 600
    );
    // The AUTO path resolved the claim itself (governance reading the session),
    // so it forwards that local rather than re-reading the receipt.
    expect(checkCall).toMatch(/expectedLabel:\s*sessionSlotClaim\b/);

    // …and the same local must be STORED on the receipt row, so the claim
    // survives even when the stamp is re-derived later from the row.
    //
    // 2026-09-07 — this assertion USED to read
    //     expect(check).toMatch(/expectedLabel: sessionSlotClaim \} : \{\}\)/)
    // and it went RED against CORRECT, committed source. The receipt's
    // conditional spread is wrapped by prettier across three lines:
    //     ...(sessionSlotClaim
    //       ? { expectedLabel: sessionSlotClaim }
    //       : {}),
    // so the single-line form it demanded never existed — not even in the
    // commit that introduced this file. A FALSE red is the more dangerous half
    // of a broken guard: it trains readers to ignore the gate, and the next
    // reader "fixes" it by deleting it. What is load-bearing is the INTENT —
    // the receipt carries the claim's LABEL — never the syntax expressing it.
    // So: scan the receipt-INSERT REGION for the key, whitespace-tolerant and
    // indifferent to conditional-spread vs plain property. Do NOT re-tighten
    // this to a literal source form.
    const satisfyCall = check.indexOf("await satisfyExpectedOutputs({");
    const receiptStart = check.indexOf(
      "const { expectedLabel: _callerSlotClaim"
    );
    // Non-vacuity: `indexOf` returns -1 on a miss, and a -1 start would slice
    // from the END of the file — matching nothing and reading GREEN. Both
    // anchors must be real and ordered BEFORE the slice is trusted, so a
    // renamed symbol fails LOUDLY here rather than quietly matching zero.
    expect(receiptStart).toBeGreaterThan(-1);
    expect(satisfyCall).toBeGreaterThan(receiptStart);
    // Region = the caller-claim strip through the receipt insert, ending BEFORE
    // the satisfy call — so that call's own forwarding cannot stand in for the
    // stored one.
    const receiptInsert = check.slice(receiptStart, satisfyCall);
    expect(receiptInsert).toMatch(/expectedLabel:\s*sessionSlotClaim\b/);
    // The PENDING door stores it too — otherwise the deferred path above has
    // nothing to read. Asserted INSIDE the propose branch, so the satisfy call's
    // own forwarding above cannot stand in for it.
    const proposeBranch = check.indexOf(
      'if (gov.decision === "propose" && !lifecycleCloseEscape) {'
    );
    const executeBranch = check.indexOf(
      'if (gov.decision === "execute" || lifecycleCloseEscape) {'
    );
    expect(proposeBranch).toBeGreaterThan(-1);
    expect(executeBranch).toBeGreaterThan(proposeBranch);
    expect(check.slice(proposeBranch, executeBranch)).toMatch(
      /expectedLabel:\s*sessionSlotClaim\b/
    );
  });

  it("the PROPOSE branch does NOT stamp — a pending row is not an approval", () => {
    const check = read("utils", "permission-check.ts");
    const proposeBranch = check.indexOf(
      'if (gov.decision === "propose" && !lifecycleCloseEscape) {'
    );
    const executeBranch = check.indexOf(
      'if (gov.decision === "execute" || lifecycleCloseEscape) {'
    );
    expect(proposeBranch).toBeGreaterThan(-1);
    expect(executeBranch).toBeGreaterThan(proposeBranch);
    expect(check.slice(proposeBranch, executeBranch)).not.toMatch(
      /satisfyExpectedOutputs/
    );
  });
});
