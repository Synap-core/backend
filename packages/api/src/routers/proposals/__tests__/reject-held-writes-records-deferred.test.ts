import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * TRIPWIRE — rejecting a held-writes pack records its kept writes as
 * `rejected`, on BOTH reject doors (`reject` and `batchReject`).
 *
 * A held-writes pack keeps an agent's blocked writes (`data.deferredWrites`).
 * Approval replays them; a rejection must say each one will never run
 * (`recordRejectedDeferredWrites`), or the agent reading the pack sees writes
 * stuck "kept" forever. The helper itself is pinned on PGlite
 * (`services/governance/deferred-writes.pglite.test.ts`).
 *
 * Source-level, like `batch-reject-reports-outcome.test.ts`: invoking the
 * procedures needs a live Postgres, and the call has no return value anything
 * downstream asserts. WHAT IT CANNOT SEE: that the call runs after the
 * REJECTED flip at runtime — it pins the order in source only.
 */

const ROUTER = join(process.cwd(), "src/routers/proposals.ts");

describe("rejecting a held-writes pack records its kept writes", () => {
  it("can see the router it pins", () => {
    expect(existsSync(ROUTER), `${ROUTER} moved — fix this path`).toBe(true);
  });

  const src = existsSync(ROUTER) ? readFileSync(ROUTER, "utf8") : "";

  function body(name: string): string {
    const start = src.indexOf(`${name}: protectedProcedure`);
    expect(start, `\`${name}: protectedProcedure\` not found`).toBeGreaterThan(
      -1
    );
    const next = src.indexOf(": protectedProcedure", start + 30);
    return next === -1 ? src.slice(start) : src.slice(start, next);
  }

  for (const door of ["reject", "batchReject"]) {
    it(`${door}: calls recordRejectedDeferredWrites on a held-writes pack, after the REJECTED flip`, () => {
      const b = body(door);
      // The flip goes through the status door (`transitionProposal`).
      const flip = b.indexOf("to: ProposalStatus.REJECTED");
      const call = b.indexOf("recordRejectedDeferredWrites(");
      expect(flip, "REJECTED flip not found").toBeGreaterThan(-1);
      expect(
        call,
        `${door} no longer records a rejected pack's kept writes`
      ).toBeGreaterThan(flip);
      expect(b).toMatch(/proposalType === "held_writes"/);
    });
  }
});
