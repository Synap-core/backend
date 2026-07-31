/**
 * Slice 5 — approval bound to the reviewed version (PlanetScale deploy-request
 * pattern).
 *
 * THE PROBLEM: a reviewer can approve a proposal whose `data` was REVISED after
 * they looked at it (AI self-revise, or a concurrent human "Save & Approve") —
 * approving something they never saw. `mergeProposalRevision` appends a
 * `revisionHistory` entry on EVERY revise, so its LENGTH is a monotonic version
 * signal. `proposals.approve` now takes an optional `expectedRevision` (the
 * length the reviewer's client last saw); when it no longer matches the stored
 * proposal, approve throws CONFLICT BEFORE any mutation.
 *
 * Same no-DB style as batch-approve-registry.test.ts (the api suite needs live
 * Postgres for anything touching the db): the guard is proven EXECUTABLY against
 * the real `assertReviewedRevision`, and its placement in the approve handler —
 * before the ownership check and before `applyProposalApproval` (so a stale
 * approve never materializes) — is proven structurally against the source.
 */

import { describe, it, expect } from "vitest";
import { TRPCError } from "@trpc/server";
import { readFileSync } from "fs";
import { join } from "path";
import type { ProposalRevision } from "@synap/database";
import { assertReviewedRevision } from "../../../utils/reviewed-revision.js";

const API_SRC = join(process.cwd(), "src");
const ROUTER = readFileSync(join(API_SRC, "routers/proposals.ts"), "utf8");

/** A revisionHistory of `n` entries (only length matters to the guard). */
function history(n: number): ProposalRevision[] {
  return Array.from({ length: n }, (_, i) => ({
    at: new Date().toISOString(),
    by: `actor-${i}`,
    before: {},
    patch: {},
  }));
}

// ───────────────────────────────────────────────────────────────────────────
// (a) OMITTED expectedRevision → no-op, approve proceeds exactly as before.
// ───────────────────────────────────────────────────────────────────────────
describe("(a) omitted expectedRevision is fully backward-compatible", () => {
  it("does NOT throw for any revisionHistory when expectedRevision is undefined", () => {
    expect(() => assertReviewedRevision(undefined, history(0))).not.toThrow();
    expect(() => assertReviewedRevision(undefined, history(3))).not.toThrow();
    expect(() => assertReviewedRevision(undefined, null)).not.toThrow();
    expect(() => assertReviewedRevision(undefined, undefined)).not.toThrow();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// (b) MATCHING expectedRevision → passes, approve proceeds.
// ───────────────────────────────────────────────────────────────────────────
describe("(b) matching expectedRevision passes the guard", () => {
  it("0 seen == 0 stored (never revised) does not throw", () => {
    expect(() => assertReviewedRevision(0, history(0))).not.toThrow();
    expect(() => assertReviewedRevision(0, null)).not.toThrow();
    expect(() => assertReviewedRevision(0, undefined)).not.toThrow();
  });

  it("2 seen == 2 stored (reviewer saw the current revision) does not throw", () => {
    expect(() => assertReviewedRevision(2, history(2))).not.toThrow();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// (c) STALE expectedRevision → CONFLICT, and (structurally) no materialization.
// ───────────────────────────────────────────────────────────────────────────
describe("(c) stale expectedRevision throws CONFLICT before any mutation", () => {
  it("a revise landed after the reviewer looked (1 seen, 2 stored) → CONFLICT", () => {
    let thrown: unknown;
    try {
      assertReviewedRevision(1, history(2));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(TRPCError);
    expect((thrown as TRPCError).code).toBe("CONFLICT");
    expect((thrown as TRPCError).message).toMatch(/reload to see the current/i);
  });

  it("reviewer saw a stale 0 while a revision already exists (0 seen, 1 stored) → CONFLICT", () => {
    expect(() => assertReviewedRevision(0, history(1))).toThrow(TRPCError);
  });

  it("guard runs BEFORE applyProposalApproval in the approve handler (stale ⇒ no materialize)", () => {
    // Isolate the single `approve:` procedure body (up to the next procedure).
    const start = ROUTER.indexOf("approve: protectedProcedure");
    const end = ROUTER.indexOf("revise: protectedProcedure", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const approveBlock = ROUTER.slice(start, end);

    const guardIdx = approveBlock.indexOf("assertReviewedRevision(");
    const applyIdx = approveBlock.indexOf("applyProposalApproval(");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(applyIdx).toBeGreaterThan(-1);
    // The CONFLICT throw precedes the sole materialization call, so a stale
    // approve can never reach the executor.
    expect(guardIdx).toBeLessThan(applyIdx);
    // It reads the stored proposal's revisionHistory against the client input.
    expect(approveBlock).toContain(
      "assertReviewedRevision(input.expectedRevision, proposal.revisionHistory)"
    );
  });

  it("the approve input declares the optional expectedRevision", () => {
    expect(ROUTER).toContain(
      "expectedRevision: z.number().int().nonnegative().optional()"
    );
  });
});
