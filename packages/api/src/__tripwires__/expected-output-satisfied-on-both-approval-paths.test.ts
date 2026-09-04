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
    expect(applier).toMatch(/import\s*\{\s*satisfyExpectedOutputs\s*\}\s*from/);
    expect(applier).toMatch(/await satisfyExpectedOutputs\(\{/);
  });

  it("the AUTO-APPROVE path (permission-check) calls the door", () => {
    const check = read("utils", "permission-check.ts");
    expect(check).toMatch(/import\s*\{\s*satisfyExpectedOutputs\s*\}\s*from/);
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
