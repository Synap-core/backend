/**
 * TRIPWIRE — the AGENT ACTOR survives approval into the applied record.
 *
 * THE DEFECT THIS EXISTS TO PREVENT (measured 2026-09-07, fixed in the same
 * pass): approving an agent's proposal recorded the resulting rows as the
 * HUMAN's work.
 *
 *   · `applyProposalApproval` builds an internal composite caller whose
 *     `userId` is the APPROVER, and handed it to `entities.create` /
 *     `relations.create` with NO `agentUserId` — although `proposal.agentUserId`
 *     was in scope and `Context.agentUserId` already existed.
 *   · `stampProvenance` (packages/database/src/utils/stamp-provenance.ts)
 *     therefore derived `createdByKind: "human"` and wrote `agent_user_id NULL`.
 *   · The ASYNC materializer path (jobs/workers/materializer.ts) stamped
 *     `ai_agent` from the SAME proposal envelope. Provenance forked on
 *     governance state — the one thing a governance system must never do.
 *
 * The founder's constraint, verbatim: "an agent never does something under my
 * identity — it should be an agent, possibly linked to me." That is RFC 8693
 * DELEGATION: the actor keeps its own identity and acts FOR a human. The three
 * roles and where each lives once a proposal is applied:
 *
 *   actor        → `<row>.agent_user_id`         (the agent)
 *   authorizer   → `<row>.created_by_user_id`    (the approving human)
 *   approver-join→ `<row>.source_proposal_id` ⋈ `proposals.reviewed_by`
 *
 * WHY A SOURCE SCAN AND NOT A BEHAVIOURAL TEST: both doors are DB-backed tRPC
 * procedures and this repo has no migrated local Postgres, so the behavioural
 * assertion cannot RUN on the gate — and a guard that does not run is not a
 * guard. This scans the two producers instead, in the same spirit as
 * `capability-drift.projection-parity.tripwire.test.ts` (which parses the
 * applier's own `.set({...})` out of source).
 *
 * WHAT THIS PROVES / DOES NOT: it proves the actor is FORWARDED at each of the
 * three seams that dropped it. It does not prove the column write — that needs
 * a live database.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const SRC = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

describe("TRIPWIRE: the approve path carries the agent actor", () => {
  it("applyProposalApproval seeds BOTH composite-caller branches with proposal.agentUserId", () => {
    const src = read("routers/proposals/apply-approval.ts");

    // Two branches build `compositeCtx` — workspace-scoped and pod-wide. Both
    // must carry the actor; seeding only one re-opens the fork for exactly half
    // the proposals (measured live: ~70% carry a NULL workspace, so the pod-wide
    // branch is the COMMON one).
    const seeded =
      src.match(/agentUserId:\s*proposal\.agentUserId\s*\?\?\s*null/g) ?? [];
    expect(
      seeded.length,
      "both compositeCtx branches (workspace-scoped and pod-wide) must set `agentUserId: proposal.agentUserId ?? null` — the approver is NOT the actor"
    ).toBe(2);
  });

  it("entities.create stamps the actor from ctx, not only from its own input", () => {
    const src = read("routers/entities/create.ts");

    // The delegated door cannot use `input.agentUserId`: `materializeCompositeGraph`
    // builds the create input from the proposal's ops, never from the caller. The
    // actor arrives on the CONTEXT, so the resolution must read both.
    expect(
      src,
      "entities.create must resolve the actor as `input.agentUserId ?? ctx.agentUserId` — reading input alone drops every proposal-approved write"
    ).toMatch(
      /const\s+actingAgentUserId\s*=\s*input\.agentUserId\s*\?\?\s*ctx\.agentUserId/
    );

    // …and that resolution must reach the provenance stamp. Pin the ARGUMENT
    // crossing the door (the same thing materialize-entity-provenance.test.ts
    // pins), not the whole call shape.
    const stamp = src.match(/stampProvenance\(\{[\s\S]*?\}\)/)?.[0] ?? "";
    expect(
      stamp,
      "no stampProvenance(...) call found in entities/create.ts"
    ).not.toBe("");
    expect(
      stamp,
      "the provenance stamp must receive `actingAgentUserId`; passing `input.agentUserId` here is the original defect"
    ).toContain("agentUserId: actingAgentUserId");
    expect(
      stamp,
      "the provenance stamp must carry sourceProposalId — it is the JOIN that recovers the APPROVER (proposals.reviewedBy) from the applied row"
    ).toContain("sourceProposalId:");
  });

  it("relations.create forwards the actor into the repository AND the event spine", () => {
    const src = read("routers/relations.ts");

    // RelationRepository.create has stamped all five provenance columns since
    // Wave B3; this router held `ctx.agentUserId` (it passes it to the governance
    // gate) but never forwarded it — so EVERY agent-authored edge was written
    // `created_by_kind = 'human'`, on the inline path as well as the approve path.
    //
    // Scoped to the individual CALL BLOCKS rather than counted file-wide: a bare
    // file-wide count is absorbed by the pre-existing `ctx.agentUserId` forward
    // into `checkPermissionOrPropose`, so deleting a forward this guard exists
    // for would still have passed. Measured while writing it — the count form
    // read 2 after a deletion and stayed green.
    const block = (call: string, from = 0) => {
      const at = src.indexOf(call, from);
      expect(
        at,
        `call site not found in relations.ts: ${call}`
      ).toBeGreaterThan(-1);
      return { at, text: src.slice(at, at + 2500) };
    };

    // EVERY `relationRepo.create(` site, not just the first. Writing this guard
    // against one site is how the original fix missed two of the three (the
    // `visible_to` anchor door and the bulk `createMany` loop) — the guard found
    // them, which is the whole point of scanning rather than trusting a reading.
    let cursor = 0;
    let sites = 0;
    while (src.indexOf("relationRepo.create(", cursor) !== -1) {
      const { at, text } = block("relationRepo.create(", cursor);
      sites++;
      expect(
        text,
        `relationRepo.create( at index ${at} must receive \`agentUserId: ctx.agentUserId\` — the ROW's actor. Every relation-write door carries it or none is trustworthy.`
      ).toMatch(/agentUserId:\s*ctx\.agentUserId/);
      cursor = at + 1;
    }
    // Two doors remain here. The third — the `visible_to` anchor door
    // (`exposeToAnchor`) — MOVED to the share core in Sites W2 S3; it is
    // pinned right below instead of being dropped from the count.
    expect(
      sites,
      "expected at least the two known relationRepo.create( doors in relations.ts"
    ).toBeGreaterThanOrEqual(2);

    // The moved `visible_to` writer: the share core forwards the actor too.
    const share = read("services/sharing/share-service.ts");
    const shareAt = share.indexOf("new RelationRepository(");
    expect(
      shareAt,
      "the share core's visible_to writer was not found"
    ).toBeGreaterThan(-1);
    expect(
      share.slice(shareAt, shareAt + 900),
      "the share core's RelationRepository.create must receive the acting agent"
    ).toMatch(/agentUserId:\s*opts\.agentUserId/);

    // EVENT SPINE — loop `recordDomainMutation(` by NAME, exactly like the
    // `relationRepo.create(` loop above.
    //
    // ⚠️ This assertion was VACUOUS as first written. It anchored on
    // `subjectType: "relation",\n action: "create",` inside a 2500-char window.
    // That anchor's FIRST occurrence in relations.ts is the
    // `checkPermissionOrPropose` gate (~line 702), so the window covered
    // ~702-766 and was satisfied by the `relationRepo.create` forward at ~740 —
    // a site the loop above ALREADY checks — while the `recordDomainMutation`
    // it claims to pin sits ~330 lines later. Deleting the event-spine
    // `agentUserId` left it green. A guard whose removal no test notices is not
    // a guard, and a shared anchor means one door's compliance vouches for
    // another's.
    let evCursor = 0;
    let evSites = 0;
    for (;;) {
      const at = src.indexOf("recordDomainMutation(", evCursor);
      if (at === -1) break;
      evSites += 1;
      // Bound the window to the call itself, not a fixed character budget.
      const end = src.indexOf("});", at);
      const callText = src.slice(at, end === -1 ? at + 1200 : end);
      expect(
        callText,
        `recordDomainMutation( at index ${at} must receive \`agentUserId: ctx.agentUserId\` — the EVENT SPINE's actor. Omitting it makes the row and its own event disagree about who acted.`
      ).toMatch(/agentUserId:\s*ctx\.agentUserId/);
      evCursor = at + 1;
    }
    // NON-VACUITY: a renamed helper or a mis-resolved source would find zero
    // call sites and make the loop above trivially true.
    expect(
      evSites,
      "expected at least one recordDomainMutation( call in relations.ts — finding none means this guard is not running, not that it passed"
    ).toBeGreaterThanOrEqual(1);
  });
});
