import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/**
 * TRIPWIRE — a POD-WIDE (workspace-less) connection-sync `import.graph` approval
 * still enqueues the connection-sync-approval job, so the connection earns its
 * `auto` governance rule.
 *
 * WHY: `emitProposalReviewed` fans out side effects only when the proposal has a
 * workspace; the `connection-sync-approval` reactor never sees a pod-wide
 * approval. Without the approval path's own enqueue, a pod-wide first sync would
 * be approved and every later sync would propose forever, with no error.
 *
 * WHAT IS PROVEN ELSEWHERE (runtime):
 *   - which proposals qualify, and that a WORKSPACE approval does NOT (so the
 *     reactor stays the only door there): database `connection-governance.test.ts`
 *     `isPodWideConnectionSyncApproval`;
 *   - the helper's job shape == the reactor's (same singletonKey → one job):
 *     events `side-effects.sync-origin.test.ts`;
 *   - exactly one rule however often the job runs: `ensureConnectionAutoRule`
 *     idempotency tests.
 *
 * WHY SOURCE-LEVEL: `applyProposalApproval`'s composite branch needs Postgres
 * (membership, materialize, stamp) — it cannot run in this DB-less gate.
 *
 * WHAT IT CANNOT SEE: it pins that the composite branch calls the predicate-gated
 * enqueue AFTER the status stamp; it does not see the other approval branches
 * (only the composite branch can carry an `import.graph`), nor a future approval
 * door that materializes an import.graph without going through this function.
 */

const src = readFileSync(
  join(__dirname, "..", "routers/proposals/apply-approval.ts"),
  "utf8"
);

describe("pod-wide connection-sync approval enqueues the rule job", () => {
  it("the composite branch gates the shared enqueue on isPodWideConnectionSyncApproval", () => {
    expect(src).toMatch(
      /if\s*\(\s*isPodWideConnectionSyncApproval\(\s*proposal\s*\)\s*\)\s*\{\s*await\s+enqueueConnectionSyncApproval\(\{\s*proposalId:\s*input\.proposalId,\s*userId,?\s*\}\)/
    );
  });

  it("it runs AFTER the approved status is stamped (the worker only mints for approved rows)", () => {
    const stampAt = src.indexOf("await stampMaterialized({");
    const enqueueAt = src.indexOf("await enqueueConnectionSyncApproval(");
    expect(stampAt).toBeGreaterThan(0);
    expect(enqueueAt).toBeGreaterThan(stampAt);
    // …and it is the composite branch's stamp, not a later unrelated one.
    expect(src.lastIndexOf("await stampMaterialized({", enqueueAt)).toBe(
      stampAt
    );
  });

  it("the emit gate it compensates for is still workspace-only (if that changes, revisit this hunk)", () => {
    const emit = src.slice(
      src.indexOf("export function emitProposalReviewed(")
    );
    expect(emit).toMatch(/if\s*\(\s*workspaceId\s*\)\s*\{\s*emitSideEffects\(/);
  });
});
