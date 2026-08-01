/**
 * Guard for the proposal-status filter SSOT.
 *
 * Every auto-approved agent write files a proposal row purely as an audit
 * receipt ("executed immediately, audited here for traceability" —
 * `database/schema/proposals.ts`). Those receipts were unlistable: the tRPC
 * enum, the REST query codec and the MCP tool schema each hardcoded
 * `pending | approved | rejected`.
 *
 * These tests pin the two properties that keep that from regressing:
 *   1. EVERY value the `proposals.status` column can hold is selectable.
 *   2. The four surfaces agree, because they share ONE list.
 *
 * Pure (no DB) — local Postgres is not required to run this.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ProposalStatus } from "@synap/database";
import {
  PROPOSAL_STATUS_FILTERS,
  ProposalStatusSchema,
} from "./rest/_codecs/proposal.js";
import { PROPOSAL_STATUS_BY_FILTER } from "./proposals.js";

describe("proposal status filters — coverage of the stored column", () => {
  it("makes every ProposalStatus the column can hold selectable", () => {
    for (const stored of Object.values(ProposalStatus)) {
      expect(PROPOSAL_STATUS_FILTERS).toContain(stored);
    }
  });

  it("exposes auto_approved — the audit receipt of an executed agent write", () => {
    expect(PROPOSAL_STATUS_FILTERS).toContain("auto_approved");
    expect(PROPOSAL_STATUS_BY_FILTER.auto_approved).toBe(
      ProposalStatus.AUTO_APPROVED
    );
  });

  it("maps every non-'all' filter to its stored column value verbatim", () => {
    for (const filter of PROPOSAL_STATUS_FILTERS) {
      if (filter === "all") continue;
      // A filter that silently mapped to something else (the old behaviour:
      // unknown → PENDING) would return a confidently WRONG list.
      expect(PROPOSAL_STATUS_BY_FILTER[filter]).toBe(filter);
    }
  });

  it("keeps 'all' as a filter-skipping sentinel, never a stored status", () => {
    expect(PROPOSAL_STATUS_FILTERS).toContain("all");
    expect(Object.values(ProposalStatus)).not.toContain("all");
    expect(PROPOSAL_STATUS_BY_FILTER).not.toHaveProperty("all");
  });
});

describe("proposal status filters — the four surfaces share one list", () => {
  it("the OpenAPI query schema accepts exactly the SSOT values", () => {
    for (const filter of PROPOSAL_STATUS_FILTERS) {
      expect(ProposalStatusSchema.safeParse(filter).success).toBe(true);
    }
    expect(ProposalStatusSchema.safeParse("not-a-status").success).toBe(false);
  });

  it("the tRPC router and REST handler derive from the shared list, not literals", () => {
    const trpcSource = readFileSync(
      join(process.cwd(), "src/routers/hub-protocol/proposals.ts"),
      "utf8"
    );
    const restSource = readFileSync(
      join(process.cwd(), "src/routers/hub-protocol/rest/proposals.ts"),
      "utf8"
    );
    expect(trpcSource).toContain("z.enum(PROPOSAL_STATUS_FILTERS)");
    expect(restSource).toContain("PROPOSAL_STATUS_FILTERS");
    // The literal triple is what drifted before — it must not reappear.
    expect(trpcSource).not.toContain('"pending", "approved", "rejected"]');
  });

  it("the MCP tool schema offers auto_approved too", () => {
    const toolsSource = readFileSync(
      join(process.cwd(), "src/routers/mcp/tools/index.ts"),
      "utf8"
    );
    const start = toolsSource.indexOf("synap_list_proposals");
    expect(start).toBeGreaterThan(-1);
    const block = toolsSource.slice(start, start + 4000);
    expect(block).toContain('"auto_approved"');
  });

  it("the underlying MCP service resolves the widened statuses", () => {
    const serviceSource = readFileSync(
      join(process.cwd(), "src/services/proposals/proposals-service.ts"),
      "utf8"
    );
    // Widening a facade past what the service supports is the exact bug this
    // guards: the service silently mapped unknown → PENDING.
    expect(serviceSource).toContain(
      "auto_approved: ProposalStatus.AUTO_APPROVED"
    );
    expect(serviceSource).toContain("reverted: ProposalStatus.REVERTED");
    expect(serviceSource).toContain(
      "approval_failed: ProposalStatus.APPROVAL_FAILED"
    );
  });
});
