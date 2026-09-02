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

  it("a session-lookup failure cannot lose the proposal", () => {
    const start = src.indexOf("let projectId");
    // Bound on the INSERT, not on the next `try {` — the derivation's own
    // guard IS a try/catch, so searching for `try {` lands inside the block
    // being measured and slices the catch away.
    const block = src.slice(start, src.indexOf(".insert(proposals)", start));
    expect(
      /catch\s*\{/.test(block),
      "the lookup must be best-effort — a lens is worth less than the write it " +
        "annotates, and an unguarded select turns a DB blip into a lost proposal"
    ).toBe(true);
  });
});
