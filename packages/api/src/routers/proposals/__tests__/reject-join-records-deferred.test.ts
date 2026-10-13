import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * TRIPWIRE — rejecting a workspace JOIN records its kept writes as `rejected`,
 * on BOTH reject doors (`reject` and `batchReject`).
 *
 * A join keeps the agent's blocked writes (`data.deferredWrites`, #6). Approval
 * replays them; a rejection must say each one will never run
 * (`recordRejectedDeferredWrites`), or the agent reading the join sees writes
 * stuck "kept" forever. The helper itself is pinned on PGlite
 * (`services/governance/deferred-writes.pglite.test.ts`, "a rejected join").
 *
 * Source-level, like `batch-reject-reports-outcome.test.ts`: invoking the
 * procedures needs a live Postgres, and the call has no return value anything
 * downstream asserts. WHAT IT CANNOT SEE: that the call runs after the
 * REJECTED flip at runtime — it pins the order in source only.
 */

const ROUTER = join(process.cwd(), "src/routers/proposals.ts");

describe("rejecting a join records its kept writes", () => {
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
    it(`${door}: calls recordRejectedDeferredWrites on a join, after the REJECTED flip`, () => {
      const b = body(door);
      const flip = b.indexOf("status: ProposalStatus.REJECTED");
      const call = b.indexOf("recordRejectedDeferredWrites(");
      expect(flip, "REJECTED flip not found").toBeGreaterThan(-1);
      expect(
        call,
        `${door} no longer records a rejected join's kept writes`
      ).toBeGreaterThan(flip);
      expect(b).toMatch(/proposalType === "join"/);
    });
  }
});
