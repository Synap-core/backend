import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/**
 * TRIPWIRE — a graph-materialized entity names the proposal that authorized it.
 *
 * MEASURED DEFECT (live dogfood): an entity created through `synap_create_entity`
 * shows a `governed` proposal neighbour in the object graph; the SAME entity
 * created through the CAPTURE door showed none.
 *
 * The cause was NOT a missing events row — the capture auto-apply path
 * materializes through `entitiesRouter.createCaller`, so `entities.create` did
 * write its `entity.create.completed` event, session-stamped and all. What it
 * could not write was `events.proposal_id`: the door stamps the receipt it gets
 * back from its OWN `checkPermissionOrPropose`, and a composite caller reaches it
 * as an already-authorized first-party write with no receipt of its own. The
 * capture receipt (`capture.graph`, auto_approved) was then minted AFTERWARDS
 * with a fresh id and a `randomUUID()` targetId, so nothing on the spine ever
 * named it. `getTemporalNeighbors` reads `events.proposal_id` — a NULL there is
 * exactly "no authorizer", and that is what the graph honestly reported.
 *
 * The fix threads the already-decided receipt id into the door:
 *   - capture auto-apply PRE-ALLOCATES the id, puts it on the composite ctx, and
 *     inserts the auto_approved row afterwards WITH that same id;
 *   - proposal approval passes the proposal's own id;
 *   - `entities.create` prefers its own auto-approve receipt and falls back to
 *     the ctx one.
 *
 * These are source-level assertions on purpose: the severance being guarded is a
 * MISSING wire between three files, which no single unit under test can observe.
 *
 * REACTOR STAYS OFF. The fix touches only the FACT spine (`events` via
 * `recordDomainMutation`'s log half, which the create door already called). It
 * adds no `emitSideEffects` call anywhere on the capture path — activating the
 * automation trigger matcher on captures is a founder decision, not a side
 * effect of this fix. The last case asserts that.
 */

const API_SRC = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(API_SRC, rel), "utf8");

describe("capture/approval graph writes carry their governance receipt", () => {
  it("entities.create stamps the composite caller's governanceProposalId onto the event", () => {
    const src = read("routers/entities/create.ts");
    // The `.completed` append is the row `getTemporalNeighbors` scans.
    const call = src.slice(
      src.indexOf("await recordDomainMutation({"),
      src.indexOf("await recordDomainMutation({") + 2600
    );
    expect(call).toContain("recordDomainMutation");
    expect(call).toContain("autoApprovedProposalId");
    // The fallback is what a composite caller supplies.
    expect(call).toMatch(/governanceProposalId/);
    // …and it must be a FALLBACK, never a replacement: the door's own receipt
    // still wins for a direct agent write.
    expect(call).toMatch(/autoApprovedProposalId[\s\S]{0,120}\?\?/);
  });

  it("capture auto-apply pre-allocates the receipt id and reuses it for the recorded proposal", () => {
    const src = read("services/capture-agent/submit-capture-graph.ts");
    expect(src).toContain("const captureProposalId = randomUUID();");
    // On the ctx the create door reads…
    expect(src).toMatch(/governanceProposalId:\s*captureProposalId/);
    // …and on the auto_approved row that is minted after materialization, so the
    // events and the proposal row can never name different ids.
    expect(src).toMatch(
      /createAutoApprovedProposal\(\{[\s\S]{0,200}id:\s*captureProposalId/
    );
    // Pre-allocation must PRECEDE materialization, otherwise the entity events
    // are written before the id exists and the linkage is lost again.
    expect(src.indexOf("const captureProposalId = randomUUID();")).toBeLessThan(
      src.indexOf("await materializeCompositeGraph(")
    );
  });

  it("proposal approval passes the proposal's own id on BOTH composite ctx branches", () => {
    const src = read("routers/proposals/apply-approval.ts");
    const occurrences =
      src.match(/governanceProposalId:\s*proposal\.id/g) ?? [];
    // Workspace-pinned branch AND pod-wide branch. A fix applied to only one of
    // them leaves pod-wide graph approvals unlinked — the exact half-wiring this
    // guards.
    expect(occurrences.length).toBe(2);
  });

  it("the receipt writer honours a pre-allocated id", () => {
    const src = read("utils/event-backed-proposal.ts");
    expect(src).toMatch(/\.\.\.\(input\.id \? \{ id: input\.id \} : \{\}\)/);
  });

  it("does NOT wire the automation reactor into the capture path", () => {
    // emitSideEffects is the REACTOR (automation trigger matcher). The capture
    // graph path must not call it directly; whatever fan-out happens is the one
    // the canonical create door already performs, unchanged by this fix.
    expect(
      read("services/capture-agent/submit-capture-graph.ts")
    ).not.toContain("emitSideEffects");
    expect(read("utils/event-backed-proposal.ts")).not.toContain(
      "emitSideEffects"
    );
  });
});
