import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * TRIPWIRE — the history lens must show EXPIRED proposals.
 *
 * THE BUG (review 2026-09-04): `signals.list({ lens: "history" })` listed
 * `EXPIRED` in its status filter and then immediately excluded every such row
 * with `isNotNull(proposals.reviewedAt)`, ordering and paging on the same
 * column. Expiry is the one decision no human makes — `expireLapsedProposals`
 * writes `status` + `updatedAt` and deliberately leaves `reviewedAt` NULL,
 * because stamping a reviewer on a lapse would claim a review that never
 * happened. Net effect: the sweeper's entire output was invisible in the only
 * surface that claimed to show it, and the status filter LOOKED correct.
 *
 * Two halves, so the pair can never drift apart again:
 *   1. expiry must NOT stamp `reviewedAt` (that would be the wrong "fix");
 *   2. the history lens must key on `coalesce(reviewedAt, updatedAt)`, in the
 *      filter, the cursor, the projection AND the ORDER BY.
 *
 * A source scan, not a behavioural test: the defect is a WHERE clause that
 * typechecks perfectly and whose unit under test is a live SQL query.
 */
const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("history lens includes expired proposals", () => {
  it("expiry writes status + updatedAt and never stamps reviewedAt", () => {
    const src = read("../services/proposals/expire-lapsed-proposals.ts");
    const sets = [...src.matchAll(/\.set\(\{([^}]*)\}\)/g)].map((m) => m[1]);
    expect(sets.length, "expiry must have at least one update").toBeGreaterThan(
      0
    );
    for (const body of sets) {
      expect(body).toMatch(/status:/);
      expect(body).toMatch(/updatedAt:/);
      expect(
        body,
        "an expiry must not claim a reviewer — nobody reviewed it. Make the " +
          "READ side coalesce instead."
      ).not.toMatch(/reviewedAt/);
    }
  });

  it("the history lens keys on coalesce(reviewedAt, updatedAt), not reviewedAt", () => {
    const src = read("../routers/signals.ts");
    const fn = src.slice(src.indexOf("async function listDecidedProposals"));
    const body = fn.slice(0, fn.indexOf("\n}\n") + 2);

    expect(body, "the decided-at expression must coalesce").toMatch(
      /coalesce\(\$\{proposals\.reviewedAt\},\s*\$\{proposals\.updatedAt\}\)/
    );
    expect(
      body,
      "excluding rows with a NULL reviewedAt drops every EXPIRED row — the bug"
    ).not.toMatch(/isNotNull\(\s*proposals\.reviewedAt\s*\)/);
    expect(
      body,
      "the cursor must page on the same expression it orders by"
    ).not.toMatch(/lt\(\s*proposals\.reviewedAt/);
    expect(
      body,
      "ORDER BY must use the coalesced expression, not the raw column"
    ).not.toMatch(/desc\(\s*proposals\.reviewedAt\s*\)/);
    // And EXPIRED must still be one of the statuses the lens asks for.
    expect(body).toMatch(/ProposalStatus\.EXPIRED/);
  });
});
