import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/**
 * TRIPWIRE — the pod's own consumers of a proposal decision read the
 * proposal's TRANSITION (`proposal.transition.completed`), never the review
 * door's `proposal.approved` / `.rejected` events, so each runs once per
 * move.
 *
 * WHY: the proposal door owes one transition per move, pod-wide proposals
 * included and re-stamps excluded (`transitionProposal`). The review door
 * (`emitProposalReviewed`) still sends `proposal.approved` / `.rejected` for
 * rules and webhooks (an external contract), but only for a proposal with a
 * workspace and on every call, re-stamps included. A built-in consumer on
 * both would run twice; one on the old event alone misses pod-wide
 * proposals, expiries and withdrawals. The consumers:
 *   - process-sync: a rejected stage gate's `onFail`, and the worker backlog
 *     release on any move out of `pending`;
 *   - the `connection-sync-approval` reactor: a move into `approved`;
 *   - hold-resume's wait check on `proposal:<id>`: its reactor sends it on
 *     the transition, so the review door sends none.
 *
 * WHAT IS PROVEN ELSEWHERE (runtime): exactly once per move, in
 *   - jobs `process-sync.test.ts` (onFail and the backlog release);
 *   - events `side-effects.sync-origin.test.ts` (connection sync, pod-wide);
 *   - jobs `hold-resume.pglite.test.ts` (the wait check).
 *
 * WHY SOURCE-LEVEL: the review door and the composite approval need
 * Postgres and the whole approval tail; this gate is DB-less.
 *
 * WHAT IT CANNOT SEE: an approval door that writes `approved` without the
 * proposal door (the `proposal-status-one-door` tripwire covers that).
 */

const packages = join(__dirname, "..", "..", "..");
const read = (rel: string) => readFileSync(join(packages, rel), "utf8");

const approval = read("api/src/routers/proposals/apply-approval.ts");
const sideEffects = read("events/src/side-effects.ts");
const processSync = read("jobs/src/utils/process-sync.ts");

/** The body of `emitProposalReviewed`, up to the next top-level function. */
function reviewDoor(): string {
  const at = approval.indexOf("export function emitProposalReviewed(");
  expect(at).toBeGreaterThan(0);
  const end = approval.indexOf("\nfunction ", at);
  return approval.slice(at, end > at ? end : undefined);
}

describe("built-in consumers of a proposal decision read its transition", () => {
  it("process-sync matches no review-door event (`proposal.<status>.completed`)", () => {
    const literals = processSync.match(/"proposal\.[a-z_]+\.completed"/g) ?? [];
    expect(literals).toEqual([]);
    expect(processSync).toMatch(/TRANSITION_EVENT_TYPES\.proposal/);
  });

  it("the connection-sync reactor matches the transition into approved, not the review door's event", () => {
    const at = sideEffects.indexOf('id: "connection-sync-approval"');
    expect(at).toBeGreaterThan(0);
    const reactor = sideEffects.slice(at, sideEffects.indexOf("};", at));
    expect(reactor).toMatch(/payload\.action === "transition"/);
    expect(reactor).toMatch(/payload\.data\?\.to === "approved"/);
    expect(reactor).not.toMatch(/payload\.action === "approved"/);
  });

  it("the approval path enqueues no connection-sync job itself (a pod-wide one is the transition's too)", () => {
    expect(approval).not.toMatch(/connection-?sync-?approval/i);
  });

  it("the composite branch's approval goes through the proposal door, which owes the transition", () => {
    const stampAt = approval.indexOf("await stampMaterialized({");
    expect(stampAt).toBeGreaterThan(0);
    const stamp = approval.slice(stampAt, approval.indexOf("});", stampAt));
    expect(stamp).toMatch(/transition:\s*\{\s*to:\s*ProposalStatus\.APPROVED/);
  });

  it("the review door sends no wait-hold check: hold-resume's reactor sends it on the transition", () => {
    expect(reviewDoor()).not.toMatch(/sendWaitHoldCheck|HOLD_RESUME_QUEUE/);
    const holdResume = read("jobs/src/workers/hold-resume.ts");
    expect(holdResume).toMatch(
      /payload\.subjectType === "proposal"[\s\S]{0,400}waits:\s*\{\s*proposalId:\s*payload\.subjectId\s*\}/
    );
  });
});
