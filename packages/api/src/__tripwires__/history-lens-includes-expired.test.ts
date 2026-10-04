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

  // Since the lens grammar (2026-10-04) the history lens (Happened) reads the
  // `activity.list` LEDGER instead of a decided-proposals query of its own.
  // The ledger's proposal source admits EVERY status — expired included — at
  // its filing time, and narrows statuses only under an explicit outcome
  // filter, which the lens never passes. These pin that chain.
  it("the history lens reads the activity ledger, with no outcome filter", () => {
    const src = read("../routers/signals.ts");
    const fn = src.slice(src.indexOf("async function readHappened"));
    const body = fn.slice(0, fn.indexOf("\n}\n") + 2);
    expect(body.length, "readHappened must exist").toBeGreaterThan(100);
    expect(body).toMatch(/listActivity\(\{/);
    expect(body, "an outcome filter would narrow the statuses").not.toMatch(
      /outcome:/
    );
    // No second, hand-rolled decided-proposal query may come back beside it.
    expect(src).not.toMatch(/reviewedAt/);
  });

  it("the ledger's proposal source admits every status (expired included) when no outcome is asked", () => {
    const src = read("../services/activity/list-activity.ts");
    const fn = src.slice(src.indexOf("async function readProposalActs"));
    const body = fn.slice(0, fn.indexOf("\n}\n") + 2);
    expect(body).toMatch(/statusesFor\(\s*proposals\.status\.enumValues/);
    expect(body).toMatch(/statuses \? inArray\(proposals\.status/);
    expect(
      body,
      "excluding rows with a NULL reviewedAt drops every EXPIRED row — the bug"
    ).not.toMatch(/isNotNull\(\s*proposals\.reviewedAt\s*\)/);
    const statusesFor = src.slice(src.indexOf("function statusesFor"));
    expect(statusesFor.slice(0, 300)).toMatch(/if \(!outcome\) return null;/);
  });
});
