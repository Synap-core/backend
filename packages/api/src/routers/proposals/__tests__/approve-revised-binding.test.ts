/**
 * Audit F1 (2026-10-28) — a proposal someone else REVISED is approved only
 * against the revision the approver saw.
 *
 * `expectedRevision` is optional, and most inline Approve buttons send none,
 * so a revise landing between render and tap (an agent amending its request)
 * was approved unseen. `assertRevisedProposalBound` refuses that call while the
 * proposal is pending, unless the latest revision is the approver's own edit
 * (the page's "Save & Approve" revises, then approves without a revision).
 *
 * Proven executably against the real helper, and structurally for its
 * placement: both approve doors call it when no revision was named, before
 * `applyProposalApproval`.
 */

import { describe, it, expect } from "vitest";
import { TRPCError } from "@trpc/server";
import { readFileSync } from "fs";
import { join } from "path";
import type { ProposalRevision } from "@synap/database";
import { assertRevisedProposalBound } from "../../../utils/reviewed-revision.js";

const ROUTER = readFileSync(
  join(process.cwd(), "src/routers/proposals.ts"),
  "utf8"
);

const PERSON = "person-1";
const rev = (
  by: string | null,
  actingAgentUserId?: string
): ProposalRevision & { actingAgentUserId?: string } => ({
  at: new Date().toISOString(),
  by,
  ...(actingAgentUserId ? { actingAgentUserId } : {}),
  before: {},
  patch: {},
});

function refusal(fn: () => void): TRPCError | undefined {
  try {
    fn();
  } catch (err) {
    return err as TRPCError;
  }
  return undefined;
}

describe("assertRevisedProposalBound", () => {
  it("an agent's revision (recorded under its human) refuses an unbound approve", () => {
    const err = refusal(() =>
      assertRevisedProposalBound({
        status: "pending",
        revisionHistory: [rev(PERSON, "agent-1")],
        approverUserId: PERSON,
      })
    );
    expect(err).toBeInstanceOf(TRPCError);
    expect(err!.code).toBe("CONFLICT");
    // The code clients already route to the proposal's page.
    expect((err!.cause as { reasonCode?: string }).reasonCode).toBe(
      "REVIEWED_REVISION_REQUIRED"
    );
  });

  it("another person's revision refuses an unbound approve", () => {
    expect(() =>
      assertRevisedProposalBound({
        status: "pending",
        revisionHistory: [rev("person-2")],
        approverUserId: PERSON,
      })
    ).toThrow(TRPCError);
  });

  it("only the LATEST revision decides: an agent revising after the person's edit refuses", () => {
    expect(() =>
      assertRevisedProposalBound({
        status: "pending",
        revisionHistory: [rev(PERSON), rev(PERSON, "agent-1")],
        approverUserId: PERSON,
      })
    ).toThrow(TRPCError);
  });

  it("the approver's own edit (Save & Approve) passes", () => {
    expect(() =>
      assertRevisedProposalBound({
        status: "pending",
        revisionHistory: [rev(PERSON, "agent-1"), rev(PERSON)],
        approverUserId: PERSON,
      })
    ).not.toThrow();
  });

  it("a never-revised proposal passes, and so does a retry past pending", () => {
    for (const history of [[], null, undefined]) {
      expect(() =>
        assertRevisedProposalBound({
          status: "pending",
          revisionHistory: history,
          approverUserId: PERSON,
        })
      ).not.toThrow();
    }
    expect(() =>
      assertRevisedProposalBound({
        status: "approval_failed",
        revisionHistory: [rev(PERSON, "agent-1")],
        approverUserId: PERSON,
      })
    ).not.toThrow();
  });
});

describe("both approve doors bind a revised proposal before applying it", () => {
  const block = (from: string, to: string) => {
    const start = ROUTER.indexOf(from);
    const end = ROUTER.indexOf(to, start + from.length);
    expect(start, `${from} vanished — scan is blind`).toBeGreaterThan(-1);
    return ROUTER.slice(start, end > start ? end : undefined);
  };

  it("proposals.approve", () => {
    const body = block(
      "approve: protectedProcedure",
      "revise: protectedProcedure"
    );
    const at = body.indexOf("assertRevisedProposalBound(");
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(body.indexOf("applyProposalApproval("));
    expect(body).toMatch(
      /if \(input\.expectedRevision === undefined\) \{\s*assertRevisedProposalBound\(/
    );
  });

  it("proposals.batchApprove", () => {
    const body = block("batchApprove:", "applyProposalApproval(");
    expect(body).toMatch(
      /else \{[\s\S]{0,200}?assertRevisedProposalBound\(\{[\s\S]{0,200}?approverUserId: userId/
    );
  });
});
