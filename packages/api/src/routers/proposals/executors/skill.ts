import { TRPCError } from "@trpc/server";
import {
  db,
  proposals,
  eq,
  skills,
  tools,
  getActingAgentUserId,
} from "@synap/database";
import { ProposalStatus } from "@synap/database/schema";
import { createLogger } from "@synap-core/core";
// Type-only (erased at compile) so it can't trip the skills.ts circular-import
// the value paths below avoid via dynamic `import("../../skills.js")`.
import type { InsertSkillGovernedInput } from "../../skills.js";
import { registerProposalExecutor } from "../execution-registry.js";
import { assertApplied, reportApproved } from "./shared.js";
import { isAgentPrincipal } from "../review-authority.js";
import { skillBornApproved } from "../../../services/capabilities/skill-born-approved.js";
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
    async execute({ proposal, userId, input, ctx, deps }) {
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

      const {
        insertSkillGoverned,
        replaceSkillRequiredTools,
        visibleRequiredTools,
      } = await import("../../skills.js");
      // Not a `skills` column: the declared `requires` edges, replayed below
      // once the row exists (ticket c5058d24).
      const { requiredToolIds, requiredToolNames, ...skillValues } = innerData;
      const result = await insertSkillGoverned({
        ...(skillValues as Record<string, unknown>),
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

      const refusals: string[] = [];

      // The tools the author declared, which the reviewer approved with the
      // skill — RE-RESOLVED under the approver's visibility (a stored id is
      // data, and these edges are the scope the skill's own provider calls
      // skip a second review under), then written through the same body as
      // `skills.setRequiredTools`. An id that no longer resolves is REFUSED
      // and reported, never written. A FAILED read or write is reported too:
      // the approver learns the approved scope did not land, never a quiet
      // success. Non-fatal for the skill: a missing edge only means its own
      // calls are gated again (the safe direction). Refusals name the tool
      // (`requiredToolNames`, same order as the ids), never an id.
      const declaredToolIds = Array.isArray(requiredToolIds)
        ? requiredToolIds.filter((id): id is string => typeof id === "string")
        : [];
      const declaredNames = Array.isArray(requiredToolNames)
        ? requiredToolNames
        : [];
      const toolLabel = (id: string) => {
        const name = declaredNames[declaredToolIds.indexOf(id)];
        return typeof name === "string" && name.trim() !== ""
          ? `\`${name}\``
          : "(unnamed)";
      };
      if (declaredToolIds.length > 0) {
        try {
          const visible = new Set(
            (await visibleRequiredTools(userId, declaredToolIds)).map(
              (t) => t.id
            )
          );
          for (const id of declaredToolIds) {
            if (!visible.has(id)) {
              refusals.push(
                `Required tool ${toolLabel(id)} was not linked: it is not an installed tool the approver can see.`
              );
            }
          }
          await replaceSkillRequiredTools({
            userId,
            skill: materializedSkill,
            toolIds: declaredToolIds.filter((id) => visible.has(id)),
          });
        } catch (err) {
          logger.error(
            { skillId: materializedSkill.id, err },
            "skill/create approval: requires edges not written (non-fatal — approval proceeds)"
          );
          refusals.push(
            `Required tools ${declaredToolIds.map(toolLabel).join(", ")} may not be linked: the approval could not check or write them, so the skill's own calls to them may still ask for review.`
          );
        }
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

      // THE APPROVAL VERDICT (`skillBornApproved`, one rule with the create
      // doors). insertSkillGoverned re-ran its gate as the APPROVER
      // (agentUserId: undefined above), or the agent branch of
      // checkPermissionOrPropose would fire again and the approval dead-end in
      // "unexpectedly re-proposed". That operator identity is not the author,
      // so the row it wrote is corrected here from the proposal's real author
      // and from who approved:
      //   - a PERSON approved: the review showed the whole code or body, so the
      //     click IS the owner's OK. The skill lands approved and runs, with no
      //     second enable step (founder decision 2). Turned on through
      //     `setSkillApproved`, the one enable door (its owner gate, audit and
      //     pack re-sync).
      //   - anything else (an agent travelling behind a human, an agent key, an
      //     agent principal) on an AGENT's proposal: approved:false. Otherwise
      //     an agent-authored instruction skill would land in the agent's
      //     system prompt with no owner approval (the prompt-injection vector).
      // A governance rule never reaches this executor: auto-approval runs the
      // door with the agent id, born approved:false. Decided AFTER the requires
      // edges and the verb wiring above, so turning it on re-syncs the packs
      // the verb was just attached to.
      const approvedByPerson =
        !ctx?.agentUserId &&
        !getActingAgentUserId() &&
        !(await isAgentPrincipal(userId));
      const approved = skillBornApproved({
        kind: materializedSkill.kind,
        agentUserId: proposal.agentUserId,
        personApprovedProposal: approvedByPerson,
      });
      if (!approved && materializedSkill.approved) {
        await db
          .update(skills)
          .set({ approved: false, updatedAt: new Date() })
          .where(eq(skills.id, materializedSkill.id));
        materializedSkill.approved = false;
      } else if (approved && !materializedSkill.approved) {
        // Dynamic, like the skills.js imports above: the enable door's module
        // graph (pack sync) stays out of the executor registry's load.
        const { setSkillApproved } =
          await import("../../../services/capabilities/set-skill-approved.js");
        try {
          await setSkillApproved({
            userId,
            skillId: materializedSkill.id,
            approved: true,
            agentUserId: ctx?.agentUserId ?? null,
          });
          materializedSkill.approved = true;
        } catch (err) {
          // A reviewer the workspace lets approve proposals (an admin, the
          // agent's owner) may still not be the one who turns a verb on (the
          // workspace owner; pod admin for a pod-wide skill). The skill is
          // created, left off, and the approval SAYS so — never a silent off.
          if (!(err instanceof TRPCError) || err.code !== "FORBIDDEN") {
            throw err;
          }
          refusals.push(
            `The skill was created but not turned on: ${err.message}`
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
      return { success: true, ...(refusals.length > 0 ? { refusals } : {}) };
    },
  });
  // ── skill / delete ───────────────────────────────────────────────────────
  // `skills.delete` (routers/skills.ts:809) sits on the rung-2.5 DESTRUCTIVE
  // floor, which no rung can widen, so an agent deleting a skill ALWAYS
  // proposes. With no `skill/delete` executor, approval fell to the `*/*`
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

  /**
   * `skill/update` — REPLAY, never reconstruct.
   *
   * The gate stores the raw procedure patch (`{ id, ...updateData, metadata }`,
   * `routers/skills.ts:846`) rather than a resolved write, and that is
   * deliberate: the procedure derives `execChanged` from the patch AFTER the
   * gate and, when execution-relevant fields moved, resets `approved: false`
   * (`skills.ts:870` and `:914`). Reimplementing the write here would apply the
   * fields and silently skip that re-approval reset — an agent could edit a
   * skill's code and keep its approved flag, which is the whole point of the
   * reset. So the executor replays the procedure and lets it re-derive.
   */
  registerProposalExecutor({
    key: "skill/update",
    async execute({ proposal, userId, input, deps }) {
      const raw = (proposal.data ?? {}) as Record<string, unknown>;
      const inner = (raw.data ?? raw ?? {}) as Record<string, unknown>;

      const id = inner.id as string | undefined;
      if (!id || typeof id !== "string") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Skill update proposal is missing the skill id",
        });
      }

      // Re-approve guard: `approve` is not status-guarded before dispatch, and
      // a replayed update would re-run the exec-change reset a second time.
      const [alreadyDone] = await db
        .select({ status: proposals.status })
        .from(proposals)
        .where(eq(proposals.id, input.proposalId));
      if (alreadyDone?.status === ProposalStatus.APPROVED) {
        return { success: true, alreadyApproved: true };
      }

      // Workspace lens from the STORED payload, never a request-supplied field.
      const wsLens =
        (inner.workspaceId as string | null | undefined) ??
        proposal.workspaceId ??
        undefined;

      const { skillsRouter } = await import("../../skills.js");
      const caller = skillsRouter.createCaller({
        db,
        authenticated: true as const,
        userId,
        workspaceId: wsLens ?? undefined,
      } as unknown as Context);

      // The stored payload IS the procedure's input shape — pass it through
      // rather than picking fields, so a field added to the procedure later is
      // carried automatically instead of being silently dropped here.
      assertApplied(
        (await caller.update(
          inner as unknown as Parameters<typeof caller.update>[0]
        )) as { status?: string }
      );

      reportApproved(deps, proposal, input.proposalId);
      return { success: true };
    },
  });
}
