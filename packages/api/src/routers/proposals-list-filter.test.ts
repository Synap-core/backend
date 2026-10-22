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
import {
  PROPOSAL_IDS_FILTER_MAX,
  proposalIdsFilterSchema,
} from "./proposals/scope-conditions.js";

const routerSource = readFileSync(
  join(process.cwd(), "src/routers/proposals.ts"),
  "utf8"
);
const listStart = routerSource.indexOf("list: protectedProcedure");
const listEnd = routerSource.indexOf("groups: protectedProcedure", listStart);
const listBlock = routerSource.slice(listStart, listEnd);

describe("proposals.list proposalIds filter", () => {
  it("accepts a bounded, de-duplicated UUID batch", () => {
    // The schema is shared with the Hub door (scope-conditions.ts), so `list`
    // must take THAT schema, and the schema itself is checked by parsing.
    expect(listBlock).toContain("proposalIds: proposalIdsFilterSchema");
    const id = "7d4f6c0e-6a1b-4a8e-9a53-3f2b1c0d9e11";
    expect(proposalIdsFilterSchema.parse([id, id])).toEqual([id]);
    expect(proposalIdsFilterSchema.safeParse(["not-a-uuid"]).success).toBe(
      false
    );
    expect(PROPOSAL_IDS_FILTER_MAX).toBe(100);
    expect(
      proposalIdsFilterSchema.safeParse(
        Array.from({ length: PROPOSAL_IDS_FILTER_MAX + 1 }, () => id)
      ).success
    ).toBe(false);
  });

  it("conjoins IDs with the existing user-visible floor", () => {
    // The workspace/user-visible floor now comes from the shared
    // `buildProposalScopeConditions` (see scope-conditions.ts, reused by
    // `groups`) rather than an inline `userVisibleWhere(` call in `list`
    // itself — same floor, one fewer place it can drift.
    const visibilityFloor = listBlock.indexOf("buildProposalScopeConditions(");
    // The id predicate is the shared `proposalIdsWhere` (scope-conditions.ts),
    // pushed onto the same `conditions` as the floor: ANDed, never instead.
    const idFilter = listBlock.indexOf(
      "conditions.push(proposalIdsWhere(input.proposalIds))"
    );

    expect(visibilityFloor).toBeGreaterThan(-1);
    expect(idFilter).toBeGreaterThan(-1);
  });

  it("does not let an empty batch skip concrete-workspace authorization", () => {
    // The editor+ gate is now the shared `assertProposalWorkspaceRead(` helper
    // (`list` and `groups` carried byte-identical copies), so this looks for
    // the CALL rather than the message string the helper now owns. What is
    // asserted is unchanged: the gate must run BEFORE the empty-batch
    // short-circuit, or an empty `proposalIds` returns early past it.
    const authorizationGate = listBlock.indexOf("assertProposalWorkspaceRead(");
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
