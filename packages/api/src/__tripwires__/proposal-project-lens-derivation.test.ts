import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * TRIPWIRE — the project-lens derivation at the pending-proposal one door.
 *
 * Lives in `@synap/api` rather than beside the code it pins because
 * `@synap/database`'s vitest config sets a package-global `setupFiles` that
 * opens Postgres, so EVERY test in that package is unrunnable while the local
 * DB is down — a pin there would be permanently skipped, which is worse than
 * no pin at all (it looks like coverage).
 *
 * Scope, honestly: this asserts the derivation is WIRED, not that it returns
 * the right row. That is the half that breaks silently, for two reasons that
 * already produced this exact defect:
 *   - `projectId` is OPTIONAL on the input, so deleting the derivation is
 *     invisible to `tsc` — verified on the sibling field `governanceReason`,
 *     where removing its threading produced ZERO typecheck errors; and
 *   - nothing downstream reads it, so no other test goes red.
 *
 * What it protects: measured live 2026-09-01, `projectId` was set on **0 of
 * 670** pending proposals while `sessionId` was set on 361. The column, the
 * forwarding through `createPendingProposal`, and the REST field all existed —
 * only the derivation was missing, so the product's cross-cutting lens could
 * surface entities, sessions and runs but never a decision.
 */

const DOOR = join(
  process.cwd(),
  "../database/src/utils/insert-pending-proposal.ts"
);

describe("proposals carry the project lens", () => {
  it("can see the one door it pins", () => {
    expect(
      existsSync(DOOR),
      `${DOOR} moved — fix this path rather than deleting the pin`
    ).toBe(true);
  });

  const src = existsSync(DOOR) ? readFileSync(DOOR, "utf8") : "";

  it("derives projectId from the proposal's session", () => {
    expect(
      /focusSessions\.projectId/.test(src) &&
        /eq\(focusSessions\.id,\s*input\.sessionId\)/.test(src),
      "the session→project lookup is gone; every producer goes back to writing " +
        "project-blind proposals and the lens returns to 0/670"
    ).toBe(true);
  });

  it("an explicit projectId still wins — the derivation only fills a gap", () => {
    expect(
      /let projectId = input\.projectId \?\? null/.test(src),
      "a caller that already knows its project must never be overridden by a " +
        "session lookup"
    ).toBe(true);
  });

  it("the DERIVED value is what reaches the insert", () => {
    // The bug shape this exists for: deriving correctly into a local, then
    // still spreading `input.projectId` into `.values()` — work done and
    // discarded. tsc cannot see that either.
    expect(
      /\.\.\.\(projectId \? \{ projectId \} : \{\}\)/.test(src),
      "the insert is not using the derived value"
    ).toBe(true);
  });

  it("runs the lookup on the caller's executor, so a same-transaction session is visible", () => {
    // Review finding: a try/catch here was pinned as "a lookup failure cannot
    // lose the proposal". It could not deliver that — inside a transaction a
    // failed statement aborts the tx, so the swallowed error only resurfaced
    // at the insert with a worse message. The real invariant is visibility:
    // `resolveOrCreateAgentProposalSession` can mint the session in the SAME
    // tx, and a read on a different connection would miss it and derive null.
    const start = src.indexOf("let projectId");
    // Bound at the if-block's close (two-space `}` on its own line), NOT at
    // the insert: the insert sits inside the outer `try {`, and slicing that
    // far would make the no-try/catch check below trip on the wrong `try`.
    const block = src.slice(start, src.indexOf("\n  }\n", start));
    // Two containment checks rather than one layout-sensitive regex, so a
    // prettier reflow cannot turn this pin red for a harmless reason.
    expect(
      /await executor[\s\S]{0,40}\.select\(/.test(block),
      "lookup must run on `executor`"
    ).toBe(true);
    expect(block).toMatch(/focusSessions\.projectId/);
    expect(
      /try\s*\{/.test(block),
      "a guard that cannot deliver its promise is worse than none — do not re-add it"
    ).toBe(false);
    // Review finding: without a catch, a malformed body-supplied sessionId
    // (22P02 on a healthy connection) would LOSE the proposal. The guard is
    // shape-checking before the query, not catching after it.
    expect(
      /UUID_SHAPE\.test\(input\.sessionId\)/.test(block),
      "a non-uuid sessionId must be excluded before the query — otherwise a bad id costs the proposal, not just the lens"
    ).toBe(true);
  });
});
