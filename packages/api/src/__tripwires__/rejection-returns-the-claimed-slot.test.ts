import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/**
 * TRIPWIRE — every REJECT door hands the claimed slot back.
 *
 * The mirror of `expected-output-satisfied-on-both-approval-paths.test.ts`. That
 * one pins that every path which APPROVES a session-scoped write walks through
 * `satisfyExpectedOutputs`; this pins that every path which REJECTS one walks
 * through `returnDelegatedSlot`.
 *
 * There are exactly TWO reject doors, and they are the SAME two that have
 * already drifted from each other once: `reasonCode` reached the durable column
 * on the single door and not on the batch, so a reviewer who refused twelve
 * proposals in one sweep produced correct telemetry and twelve NULL columns —
 * invisibly, because the event path looked right. A slot that comes back on a
 * single reject and stays stuck "in progress" on a batch reject is that defect
 * wearing a new hat, and it is the shape a reader would never think to check.
 *
 * Both doors call ONE shared helper (`returnRejectedSlot`), which is also what
 * this asserts — a second inline copy is how the two drifted last time.
 *
 * SOURCE-SCAN, not behavioural: a severance is an ABSENT call, and only a scan
 * of the source can see an absence. What it proves is one-directional and worth
 * stating: it proves the call is WRITTEN on both doors, never that it runs on
 * the right branch. The behaviour itself is pinned by
 * `services/focus-sessions/__tests__/return-delegated-slot.test.ts`.
 */

const API_SRC = join(process.cwd(), "src");
const source = readFileSync(join(API_SRC, "routers", "proposals.ts"), "utf8");

/** Strip line + block comments so a mention in prose is never a match. */
const code = source
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^[ \t]*\/\/.*$/gm, "");

describe("tripwire: a rejection returns the deliverable it refused", () => {
  it("proposals.ts imports the return door and the ONE claim reader", () => {
    expect(code).toMatch(
      /import\s*\{[^}]*returnDelegatedSlot[^}]*\}\s*from\s*"[^"]*return-delegated-slot\.js"/
    );
    // The claim lives at the top level of `proposals.data`, and exactly one
    // reader knows that. A second inline `data.expectedLabel` read here is how
    // the approve and reject halves start disagreeing about where it lives.
    expect(code).toMatch(
      /import\s*\{[^}]*readProposalExpectedLabel[^}]*\}\s*from\s*"[^"]*satisfy-expected-output\.js"/
    );
  });

  it("BOTH reject doors call the shared helper — by count, not by presence", () => {
    // Counted, not merely present: `reject` calling it twice while `batchReject`
    // calls it zero times satisfies a presence check and is exactly the bug.
    const calls = code.match(/await returnRejectedSlot\(/g) ?? [];
    expect(calls).toHaveLength(2);
  });

  it("the helper reads the claim through the ONE reader, and requires a session", () => {
    const helper = code.slice(
      code.indexOf("async function returnRejectedSlot("),
      code.indexOf("export const proposalsRouter")
    );
    expect(helper).toMatch(/readProposalExpectedLabel\(proposal\.data\)/);
    // No session ⇒ no board to hand anything back to; no claim ⇒ nothing was
    // claimed. Both are silent no-ops, never a guess at which slot it was.
    expect(helper).toMatch(
      /if\s*\(!proposal\.sessionId\s*\|\|\s*!expectedLabel\)\s*return;/
    );
  });

  it("both reject doors SELECT the session id they need", () => {
    // A helper that can never fire is worse than one that is absent: it reads as
    // wired. `sessionId` is not selected by default anywhere in this file.
    const selects = code.match(/sessionId:\s*true/g) ?? [];
    expect(selects.length).toBeGreaterThanOrEqual(2);
  });
});
