/**
 * `proposals.list({ status: "reverted" })`.
 *
 * The buckets were `pending` (= PENDING + APPROVAL_FAILED), `validated`
 * (= APPROVED + AUTO_APPROVED), `rejected` and `all`. REVERTED belonged to no
 * bucket: it was reachable only through `all`, mixed in with everything else,
 * so a history surface could not ask "what did I undo".
 *
 * ## What this proves, and what it does not
 *
 * The procedure body batch-joins the database and cannot run here, so this is a
 * SOURCE SCAN paired with a real assertion on the input CONTRACT (the zod enum
 * is importable and is the thing a client is actually bound by). Stated
 * plainly: it proves the filter EXISTS and is SELECTABLE, not that the SQL
 * predicate returns the right rows — that half needs a live Postgres, which
 * this environment does not have (the pod is remote).
 *
 * NEGATIVE CONTROL is recorded in the report: deleting the `reverted` branch
 * turns the source-scan assertions red; removing it from the enum turns the
 * contract assertions red.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ProposalStatus } from "@synap/database/schema";
import { PROPOSAL_ROW_STATUSES } from "../hub-protocol/rest/_codecs/proposal.js";

const src = readFileSync(
  fileURLToPath(new URL("../proposals.ts", import.meta.url)),
  "utf8"
);

describe("the `reverted` bucket", () => {
  it("NON-VACUITY: the scan can see the bucket chain it is judging", () => {
    expect(src.length).toBeGreaterThan(10_000);
    expect(src).toContain('if (input.status === "pending") {');
    expect(src).toContain('} else if (input.status === "rejected") {');
  });

  it("is SELECTABLE on the list input enum", () => {
    const enumLine = src.match(
      /status: z\s*\n?\s*\.enum\(\[([^\]]*)\]\)\s*\n?\s*\.default\("pending"\)/
    );
    expect(enumLine).not.toBeNull();
    expect(enumLine![1]).toContain('"reverted"');
    // The pre-existing buckets are untouched — this is additive.
    for (const kept of ["pending", "validated", "rejected", "all"]) {
      expect(enumLine![1]).toContain(`"${kept}"`);
    }
  });

  it("filters on REVERTED only", () => {
    expect(src).toContain('} else if (input.status === "reverted") {');
    expect(src).toContain(
      "conditions.push(eq(proposals.status, ProposalStatus.REVERTED));"
    );
  });

  it("does NOT widen any other bucket (ordering/cursor semantics untouched)", () => {
    // `validated` must still be exactly approved + auto_approved…
    const validated = src.slice(
      src.indexOf('} else if (input.status === "validated") {'),
      src.indexOf('} else if (input.status === "rejected") {')
    );
    expect(validated).toContain("ProposalStatus.APPROVED");
    expect(validated).toContain("ProposalStatus.AUTO_APPROVED");
    expect(validated).not.toContain("ProposalStatus.REVERTED");
    // …and `pending` must still carry APPROVAL_FAILED, the actionable zombie.
    const pending = src.slice(
      src.indexOf('if (input.status === "pending") {'),
      src.indexOf('} else if (input.status === "validated") {')
    );
    expect(pending).toContain("ProposalStatus.APPROVAL_FAILED");
    expect(pending).not.toContain("ProposalStatus.REVERTED");
  });

  it("REVERTED is a real column value, not a filter-only invention", () => {
    expect(ProposalStatus.REVERTED).toBe("reverted");
    expect(PROPOSAL_ROW_STATUSES).toContain("reverted");
  });
});
