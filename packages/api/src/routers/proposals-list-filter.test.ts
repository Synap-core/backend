/**
 * Contract guard for notification-driven proposal resolution.
 *
 * `proposals.list` is intentionally DB-backed, so this verifies the safety
 * wiring at its one query door: an ID batch stays conjunctive with the existing
 * user/workspace floor, and the empty-batch fast path runs only after the
 * concrete-workspace authorization gate.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const routerSource = readFileSync(
  join(process.cwd(), "src/routers/proposals.ts"),
  "utf8"
);
const listStart = routerSource.indexOf("list: protectedProcedure");
const listEnd = routerSource.indexOf("groups: protectedProcedure", listStart);
const listBlock = routerSource.slice(listStart, listEnd);

describe("proposals.list proposalIds filter", () => {
  it("accepts a bounded, de-duplicated UUID batch", () => {
    expect(listBlock).toContain("proposalIds: z");
    expect(listBlock).toContain(".array(z.string().uuid())");
    expect(listBlock).toContain(".max(100)");
    expect(listBlock).toContain("transform((ids) => [...new Set(ids)])");
  });

  it("conjoins IDs with the existing user-visible floor", () => {
    const visibilityFloor = listBlock.indexOf("userVisibleWhere(");
    const idFilter = listBlock.indexOf(
      "inArray(proposals.id, input.proposalIds)"
    );

    expect(visibilityFloor).toBeGreaterThan(-1);
    expect(idFilter).toBeGreaterThan(-1);
    expect(listBlock).toContain(
      "conditions.push(inArray(proposals.id, input.proposalIds))"
    );
  });

  it("does not let an empty batch skip concrete-workspace authorization", () => {
    const authorizationGate = listBlock.indexOf(
      "Editor or higher role required to view proposals"
    );
    const emptyBatch = listBlock.indexOf(
      "if (input.proposalIds?.length === 0)"
    );

    expect(authorizationGate).toBeGreaterThan(-1);
    expect(emptyBatch).toBeGreaterThan(authorizationGate);
  });

  it("preserves approval failures in the pending queue", () => {
    expect(listBlock).toContain("ProposalStatus.APPROVAL_FAILED");
  });
});
