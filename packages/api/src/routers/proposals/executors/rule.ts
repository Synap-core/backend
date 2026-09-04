import { TRPCError } from "@trpc/server";
import { db, proposals, eq } from "@synap/database";
import { ProposalStatus } from "@synap/database/schema";
import { registerProposalExecutor } from "../execution-registry.js";
import { assertApplied, reportApproved } from "./shared.js";

/**
 * Register the rule/* approve executors (NS1 Rule Loop).
 *
 * A rule filed by an agent (or by a member whose role lacks `create`) lands
 * here on approval. Without this half, approval would fall to the `*​/*`
 * catch-all — which for a gate-made proposal does NOT throw: it emits
 * `.validated`, flips the row APPROVED and returns success while NOTHING is
 * written. That silent-success defect has shipped three times in this repo.
 *
 * Materializes through the SAME `createRuleGoverned` door the direct path
 * uses, re-run as the APPROVER (no `agentUserId` ⇒ the operator is the
 * authority ⇒ the re-entrant gate auto-grants), so the rule row, its
 * divergence snapshot and its lineage edges are byte-identical to a direct
 * create.
 *
 * REPLAY SUFFICIENCY: the propose gate stores the FULL payload — intent,
 * scope (kind + workspaceId + projectId), expiresAt, factSkillId,
 * automationIds, routing — not just `{ id }`. Everything the replay needs is in
 * `data.data`.
 *
 * OLD PAYLOADS: a proposal filed before `trust` was dropped still carries
 * `data.data.trust`. It is not read — an unknown key in the stored blob is
 * inert, so an in-flight proposal replays fine and the removed field grants
 * nothing. Same for a payload with no `expiresAt`: absent = no expiry.
 *
 * ROUTING is deliberately NOT read back off the payload. `createRuleGoverned`
 * classifies from `intent` with an EMPTY context, so the classifier is a pure
 * function of a field this executor already replays byte-for-byte — re-running
 * it reproduces `data.routing` exactly. Reading the stored blob instead would
 * make the payload a second source for a value the door already owns, and this
 * repo's dominant defect is exactly that kind of fork. The payload copy exists
 * so a REVIEWER can see the shape before approving, not so the replay can
 * trust it.
 */
export function registerRuleExecutors(): void {
  registerProposalExecutor({
    key: "rule/create",
    async execute({ proposal, userId, input, deps }) {
      const innerData = ((proposal.data as Record<string, unknown>)?.data ??
        {}) as Record<string, unknown>;
      const intent = innerData.intent as string | undefined;
      if (!intent || !intent.trim()) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Rule proposal is missing intent",
        });
      }

      // Idempotency: approve is not status-guarded before dispatch, and
      // createRuleGoverned mints a fresh id, so a re-approve without this guard
      // would double-create.
      const [alreadyDone] = await db
        .select({ status: proposals.status })
        .from(proposals)
        .where(eq(proposals.id, input.proposalId));
      if (alreadyDone?.status === ProposalStatus.APPROVED) {
        return { success: true, alreadyApproved: true };
      }

      const { readRuleScope } =
        await import("../../../services/rules/index.js");
      const { readExpiresAt } =
        await import("../../../services/rules/expiry.js");
      const scope = readRuleScope(innerData.scope);
      const expiresAt = readExpiresAt(innerData.expiresAt);

      const { createRuleGoverned } =
        await import("../../../services/rules/create.js");
      const result = await createRuleGoverned({
        userId,
        // Own the rule as the APPROVER (mirrors project/skill/view) — no
        // agentUserId so the re-entrant gate auto-grants for the operator.
        agentUserId: undefined,
        // …but the compiled automation's DRAFT FLOOR keys on who AUTHORED the
        // behaviour, not on who approved it. Without this, approving an
        // agent-authored rule materialized an ACTIVE automation (and a live
        // `nextRunAt` for a cron trigger), making `rule/create` a wider path to
        // a firing trigger than `automation/create` — whose executor has always
        // threaded the author through (`executors/automation.ts`). Only
        // `proposal.agentUserId` is read, NOT `createdBy`: a rule a HUMAN wrote
        // and could not create for lack of permission is not a prompt-injection
        // surface, and forcing it to draft would make approval a half-action.
        ...(proposal.agentUserId
          ? { behaviourAuthorAgentUserId: proposal.agentUserId }
          : {}),
        workspaceId: proposal.workspaceId ?? null,
        intent,
        scope,
        ...(expiresAt ? { expiresAt } : {}),
        ...(typeof innerData.factSkillId === "string"
          ? { factSkillId: innerData.factSkillId }
          : {}),
        // The BEHAVIOUR half of the replay. The payload stores the structured
        // sentence, so the approved rule compiles the same automation the
        // reviewer saw described — and `createRuleGoverned` REFUSES here if it
        // no longer compiles (a command deleted since the proposal was filed),
        // which surfaces as a FORBIDDEN below instead of a rule with no
        // behaviour. Absent for a prose-only `fact` rule and for every proposal
        // filed before rules compiled at all; absence is inert.
        ...(innerData.sentence !== undefined
          ? { sentence: innerData.sentence }
          : {}),
        automationIds: Array.isArray(innerData.automationIds)
          ? (innerData.automationIds as string[]).filter(
              (id): id is string => typeof id === "string"
            )
          : [],
        auditSource: "proposal_approval",
      });

      if (result.status === "denied") {
        throw new TRPCError({ code: "FORBIDDEN", message: result.reason });
      }
      // The approver IS the authority — a nested proposal means the replay
      // filed a SECOND proposal instead of applying the first.
      assertApplied(result);

      await db
        .update(proposals)
        .set({
          status: ProposalStatus.APPROVED,
          reviewedBy: userId,
          reviewedAt: new Date(),
          updatedAt: new Date(),
          // Store what the replay produced so revert/audit can read it.
          data: {
            ...((proposal.data as Record<string, unknown>) ?? {}),
            materialized: {
              ruleId: result.status === "created" ? result.ruleId : undefined,
              factSkillId: innerData.factSkillId,
              // From the RESULT, not the request payload. The payload holds only
              // the ids that already existed when the proposal was filed; the
              // automation compiled from the sentence is created BY this
              // approval, so reading the payload left the one thing the approval
              // actually made unreachable to revert and audit.
              automationIds:
                result.status === "created"
                  ? result.automationIds
                  : (innerData.automationIds ?? []),
            },
          },
        })
        .where(eq(proposals.id, input.proposalId));

      reportApproved(deps, proposal, input.proposalId);
      deps.emitProposalReviewed(
        input.proposalId,
        proposal.workspaceId,
        "approved",
        userId
      );
      return { success: true };
    },
  });
}
