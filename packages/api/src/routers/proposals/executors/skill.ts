import { TRPCError } from "@trpc/server";
import { db, proposals, eq, skills, tools } from "@synap/database";
import { ProposalStatus } from "@synap/database/schema";
import { createLogger } from "@synap-core/core";
// Type-only (erased at compile) so it can't trip the skills.ts circular-import
// the value paths below avoid via dynamic `import("../../skills.js")`.
import type { InsertSkillGovernedInput } from "../../skills.js";
import { registerProposalExecutor } from "../execution-registry.js";
import { assertApplied, reportApproved } from "./shared.js";
import { assertWorkspaceWrite } from "../../../utils/workspace-write-access.js";
import type { Context } from "../../../context.js";

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
  // ── skill / delete ───────────────────────────────────────────────────────
  // `skills.delete` (routers/skills.ts:809) sits on the rung-2.5 DESTRUCTIVE
  // floor, which no rung can widen, so an agent deleting a skill ALWAYS
  // proposes. With no `skill/delete` executor, approval fell to the `*​/*`
  // catch-all — which for a gate-made proposal does not throw: it emits
  // `.validated`, flips the row APPROVED and returns success. The skill was
  // never deleted and the reviewer was told it was.
  //
  // PAYLOAD: the gate stores FLAT `data: { id }` (nested as `data.data.id`);
  // `proposal.targetId` holds the same id. All three shapes are read.
  //
  // SECOND EFFECT: the direct path is THREE writes — `db.delete(skills)`,
  // `auditLog`, and `emitSideEffects` (the automation-reactor bus, which is a
  // DIFFERENT bus from the event spine). Deleting the row alone would have left
  // the delete invisible to every reactor. Replayed through `skillsRouter.delete`
  // so all three fire exactly as on the direct path.
  //
  // IDENTITY: acts as the skill's OWNER. `skills.delete` loads the row under
  // `or(eq(skills.scope, "pod"), eq(skills.userId, userId))` — a VISIBILITY
  // predicate, so a user-scoped skill approved by anyone else would 404 before
  // the status update and strand the proposal PENDING. The APPROVER's own floor
  // is asserted first against the LOADED row, so no authority is widened.
  registerProposalExecutor({
    key: "skill/delete",
    async execute({ proposal, userId, input, deps }) {
      const raw = (proposal.data ?? {}) as Record<string, unknown>;
      const inner = (raw.data ?? {}) as Record<string, unknown>;
      const skillId =
        (inner.id as string | undefined) ??
        (raw.id as string | undefined) ??
        proposal.targetId;
      if (!skillId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Skill delete proposal is missing the skill id",
        });
      }

      // Idempotency: approve is not status-guarded before dispatch.
      const [alreadyDone] = await db
        .select({ status: proposals.status })
        .from(proposals)
        .where(eq(proposals.id, input.proposalId));
      if (alreadyDone?.status === ProposalStatus.APPROVED) {
        return { success: true, alreadyApproved: true };
      }

      const skill = await db.query.skills.findFirst({
        where: eq(skills.id, skillId),
        columns: { id: true, userId: true, workspaceId: true },
      });
      if (!skill) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Skill to delete no longer exists",
        });
      }

      await assertWorkspaceWrite(db, userId, {
        workspaceId: skill.workspaceId,
        ownerId: skill.userId,
      });

      const { skillsRouter } = await import("../../skills.js");
      const skillCaller = skillsRouter.createCaller({
        db,
        authenticated: true as const,
        userId: skill.userId,
        workspaceId: skill.workspaceId ?? undefined,
      } as unknown as Context);

      // The replay must APPLY, never re-propose — see `assertApplied`.
      assertApplied(await skillCaller.delete({ id: skillId }));

      await db
        .update(proposals)
        .set({
          status: ProposalStatus.APPROVED,
          reviewedBy: userId,
          reviewedAt: new Date(),
          updatedAt: new Date(),
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
