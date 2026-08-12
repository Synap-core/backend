import { TRPCError } from "@trpc/server";
import { db, proposals, eq, skills, tools } from "@synap/database";
import { ProposalStatus } from "@synap/database/schema";
import { createLogger } from "@synap-core/core";
// Type-only (erased at compile) so it can't trip the skills.ts circular-import
// the value paths below avoid via dynamic `import("../../skills.js")`.
import type { InsertSkillGovernedInput } from "../../skills.js";
import { registerProposalExecutor } from "../execution-registry.js";
import { reportApproved } from "./shared.js";

const logger = createLogger({ module: "proposal-approve-executors-skill" });

/** Register the skill/* approve executors. */
export function registerSkillExecutors(): void {
  // ── skill / create ───────────────────────────────────────────────────────────
  // (object-proposal manifest W1) A gated skill create (agent-authored, or a
  // member whose role lacks `create`) lands here on approval. Materializes via
  // the SAME insertSkillGoverned door the direct paths use — re-run as the
  // APPROVER (no agentUserId ⇒ the re-entrant gate auto-grants for the operator
  // authority), so audit / side-effects / born-approved rules match the direct
  // create exactly. The propose gate widened `data` to the full insert shape, so
  // kind/code/body/scope/providerSpec/… all flow through here.
  //
  // targetId NOTE (decision B): insertSkillGoverned mints its own skillId and
  // ignores a caller-supplied id, so the materialized skill's id is NOT yet the
  // proposal's pre-minted targetId — adoption is a follow-up (see wave report).
  registerProposalExecutor({
    key: "skill/create",
    async execute({ proposal, userId, input, deps }) {
      const innerData = ((proposal.data as Record<string, unknown>)?.data ??
        {}) as Record<string, unknown>;
      const name = innerData.name as string | undefined;
      if (!name) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Skill proposal is missing name",
        });
      }

      // Idempotency: insertSkillGoverned mints a fresh id each run, so a
      // re-approve without this guard would double-create.
      const [alreadyDone] = await db
        .select({ status: proposals.status })
        .from(proposals)
        .where(eq(proposals.id, input.proposalId));
      if (alreadyDone?.status === ProposalStatus.APPROVED) {
        return { success: true, alreadyApproved: true };
      }

      const { insertSkillGoverned } = await import("../../skills.js");
      const result = await insertSkillGoverned({
        ...(innerData as Record<string, unknown>),
        // Own the skill as the APPROVER (mirrors project/view) — no agentUserId
        // so the re-entrant gate auto-grants for the operator authority. `id` in
        // innerData is stripped by insertSkillGoverned (it mints its own).
        userId,
        agentUserId: undefined,
        auditSource: "proposal_approval",
      } as unknown as InsertSkillGovernedInput);
      if (result.status === "denied") {
        throw new TRPCError({ code: "FORBIDDEN", message: result.reason });
      }
      if (result.status === "proposed") {
        // The approver IS the authority — the re-entrant gate should auto-grant.
        // A nested proposal means the approver lacks create rights; surface it
        // rather than silently flipping the proposal APPROVED with nothing built.
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Skill approval unexpectedly re-proposed",
        });
      }

      // Declarative-verb WIRING on the AGENT (proposal) path. The create doors
      // (`capabilities.createVerb` / MCP `synap_create_verb`) call `wireCreatedVerb`
      // ONLY on their synchronous `created` branch; a GOVERNED create returns
      // `proposed`, so the verb was materialized HERE by insertSkillGoverned with
      // NO requires-edge / container-attach / catalogue entry — born ORPHANED (the
      // T4 bug, re-opened on the approval path). Re-run the SAME shared wiring now
      // that the skill row exists.
      //
      // Signal (identical to the create doors): a `declarative` skill whose
      // `providerSpec` names a parent tool. Resolve that tool by name under the
      // APPROVER's visibility + the skill's own workspace lens via `parentToolWhere`
      // (the one shared predicate). Non-fatal throughout — if the tool can't be
      // resolved or wiring fails, log-and-continue (wireCreatedVerb's own posture);
      // never break the approval, whose skill row is already committed.
      const materializedSkill = result.skill;

      // BORN-APPROVED DOWNGRADE (security). insertSkillGoverned's rule is
      // `approved = kind === "instruction" && !agentUserId` — "an instruction
      // skill is auto-approved only when a trusted HUMAN installs it". We must
      // re-run its permission gate as the APPROVER (agentUserId: undefined
      // above), otherwise the agent branch of checkPermissionOrPropose fires
      // again and the approval dead-ends in "unexpectedly re-proposed". That
      // operator identity also makes the born-approved rule read `true` — so an
      // AGENT-authored instruction skill would materialize `approved: true` and
      // land in the agent's system prompt with NO owner approval (the
      // prompt-injection vector the rule exists to close). The proposal row
      // still carries the real author, so restore the intended verdict here.
      if (proposal.agentUserId && materializedSkill.approved) {
        await db
          .update(skills)
          .set({ approved: false, updatedAt: new Date() })
          .where(eq(skills.id, materializedSkill.id));
        materializedSkill.approved = false;
      }

      const providerSpec = materializedSkill.providerSpec;
      if (
        materializedSkill.kind === "declarative" &&
        providerSpec &&
        typeof providerSpec.tool === "string" &&
        providerSpec.tool.trim() !== ""
      ) {
        try {
          const { wireCreatedVerb, parentToolWhere } =
            await import("../../../services/capabilities/create-declarative-verb.js");
          const wsLens = materializedSkill.workspaceId ?? null;
          const [parentTool] = await db
            .select({ id: tools.id })
            .from(tools)
            .where(
              parentToolWhere({
                userId,
                toolName: providerSpec.tool,
                workspaceId: wsLens,
              })
            )
            .limit(1);
          if (parentTool) {
            await wireCreatedVerb(
              {
                db,
                authenticated: true as const,
                userId,
                ...(wsLens ? { workspaceId: wsLens } : {}),
              } as unknown as Parameters<typeof wireCreatedVerb>[0],
              {
                skillId: materializedSkill.id,
                parentToolId: parentTool.id,
                verbName: materializedSkill.name,
                ...(materializedSkill.description
                  ? { description: materializedSkill.description }
                  : {}),
                parameters: materializedSkill.parameters ?? undefined,
              }
            );
          } else {
            logger.warn(
              {
                skillId: materializedSkill.id,
                toolName: providerSpec.tool,
                workspaceId: wsLens,
              },
              "skill/create approval: parent tool for declarative verb not resolvable — verb left unwired"
            );
          }
        } catch (err) {
          logger.error(
            { skillId: materializedSkill.id, err },
            "skill/create approval: wireCreatedVerb failed (non-fatal — approval proceeds)"
          );
        }
      }

      await db
        .update(proposals)
        .set({
          status: ProposalStatus.APPROVED,
          reviewedBy: userId,
          reviewedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(proposals.id, input.proposalId));

      // Report to IS telemetry (fire-and-forget — never blocks)
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
