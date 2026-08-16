import { TRPCError } from "@trpc/server";
import {
  db,
  proposals,
  projects,
  ProjectRepository,
  EventRepository,
  sql,
  eq,
  and,
  drizzleSql,
  relations,
  projectMembers,
  getWorkspaceMembership,
} from "@synap/database";
import { ProposalStatus } from "@synap/database/schema";
import { emitSideEffects } from "@synap/events";
import { auditLog } from "../../../utils/audit-log.js";
import { projectsRouter } from "../../projects.js";
import type { Context } from "../../../context.js";
import { registerProposalExecutor } from "../execution-registry.js";
import { reportApproved } from "./shared.js";

/** Register the project/* approve executors. */
export function registerProjectExecutors(): void {
  // ── project / create ─────────────────────────────────────────────────────────
  // A gated createProject (a workspace member whose role lacks `create`, filed as
  // a reviewable proposal) lands here on approval. Without this executor the `*/*`
  // catch-all threw NOT_IMPLEMENTED and the proposal could never materialize.
  // Materializes via the SAME projectsRouter.create the direct path uses — re-run
  // as the APPROVER (no agentUserId ⇒ the operator is the authority ⇒ the
  // re-entrant gate auto-grants), so audit/events/placement match the direct
  // create exactly. Mirrors entity/create's membership-scoped caller +
  // focus_session/create's idempotency guard.
  //
  // DATA-SHAPE NOTE: the propose gate now carries the FULL create payload
  // (name, description, status, phase, subjectEntityId, settings, metadata), so
  // an approved project no longer loses everything but its name. Each field is
  // still read defensively — proposals filed before that widening carry only
  // `{ name }`, and those must keep approving cleanly rather than throwing.
  registerProposalExecutor({
    key: "project/create",
    async execute({ proposal, userId, input, deps }) {
      const innerData = ((proposal.data as Record<string, unknown>)?.data ??
        {}) as Record<string, unknown>;
      const name = innerData.name as string | undefined;
      if (!name) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Project proposal is missing name",
        });
      }
      const workspaceId = proposal.workspaceId ?? null;
      if (!workspaceId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Project creation proposal is missing a valid workspaceId",
        });
      }

      // Idempotency: approve is not status-guarded before dispatch, so skip if
      // this proposal was already materialized (createCaller mints a fresh id
      // each run — a re-approve without this guard would double-create).
      const [alreadyDone] = await db
        .select({ status: proposals.status })
        .from(proposals)
        .where(eq(proposals.id, input.proposalId));
      if (alreadyDone?.status === ProposalStatus.APPROVED) {
        return { success: true, alreadyApproved: true };
      }

      const membership = await getWorkspaceMembership(db, workspaceId, userId);
      if (!membership) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "No workspace access",
        });
      }
      const projectCaller = projectsRouter.createCaller({
        db,
        authenticated: true as const,
        userId,
        workspaceId,
        workspaceRole: membership.role,
      } as unknown as Context);
      await projectCaller.create({
        name,
        description: innerData.description as string | undefined,
        status: innerData.status as
          "active" | "archived" | "completed" | undefined,
        phase: innerData.phase as string | undefined,
        subjectEntityId: innerData.subjectEntityId as string | undefined,
        settings: innerData.settings as Record<string, unknown> | undefined,
        metadata: innerData.metadata as Record<string, unknown> | undefined,
      });

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

  // ── project / update ─────────────────────────────────────────────────────────
  // An agent advancing a project's phase, renaming it, or rebinding its subject
  // files a proposal. Until this executor existed, approving one hit the `*/*`
  // catch-all and threw NOT_IMPLEMENTED — the reviewer said yes and NOTHING
  // happened. That is the create-side-effect-without-an-approval-half defect
  // this codebase has now hit more than once, so the write door and its
  // approval half ship together.
  //
  // Replays through the SAME projectsRouter.update the direct path uses, as the
  // APPROVER (no agentUserId ⇒ the re-entrant gate auto-grants), so audit,
  // events and the subject-link write are identical to a direct update.
  registerProposalExecutor({
    key: "project/update",
    async execute({ proposal, userId, input, deps }) {
      const innerData = ((proposal.data as Record<string, unknown>)?.data ??
        {}) as Record<string, unknown>;
      // The gate stamps the id into `data`; `targetId` is the fallback for
      // proposals filed by paths that only set the target.
      const projectId =
        (innerData.id as string | undefined) ?? proposal.targetId;
      if (!projectId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Project update proposal is missing the project id",
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

      // The workspace comes from the PROJECT ROW, never from the proposal — a
      // proposal's workspaceId is request-shaped, and `workspaceProcedure`
      // trusts whatever workspace the caller is constructed with.
      const project = await db.query.projects.findFirst({
        where: eq(projects.id, projectId),
        columns: { id: true, workspaceId: true },
      });
      if (!project) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Project to update no longer exists",
        });
      }
      if (!project.workspaceId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Pod-wide projects cannot be updated through a proposal (workspaceProcedure requires a workspace)",
        });
      }

      const membership = await getWorkspaceMembership(
        db,
        project.workspaceId,
        userId
      );
      if (!membership) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "No workspace access",
        });
      }

      const projectCaller = projectsRouter.createCaller({
        db,
        authenticated: true as const,
        userId,
        workspaceId: project.workspaceId,
        workspaceRole: membership.role,
      } as unknown as Context);

      // TWO doors share the `project/update` key: the field patch, and the
      // automation-membership change (both are governed as a project update,
      // because the project is the thing whose composition changes). They carry
      // different payloads, so replaying a membership proposal through `update`
      // would call it with only an id — a silent no-op wearing an approval.
      // Discriminate on the payload the membership door stamps.
      if ("automationId" in innerData && "member" in innerData) {
        await projectCaller.setAutomationMembership({
          projectId,
          automationId: innerData.automationId as string,
          member: innerData.member === true,
        });
      } else {
        // Only fields the proposal actually carries are replayed — an absent key
        // must stay absent, because `null` MEANS "clear it" for phase/subject.
        await projectCaller.update({
          id: projectId,
          ...("name" in innerData ? { name: innerData.name as string } : {}),
          ...("description" in innerData
            ? { description: innerData.description as string }
            : {}),
          ...("status" in innerData
            ? {
                status: innerData.status as "active" | "archived" | "completed",
              }
            : {}),
          ...("phase" in innerData
            ? { phase: innerData.phase as string | null }
            : {}),
          ...("subjectEntityId" in innerData
            ? { subjectEntityId: innerData.subjectEntityId as string | null }
            : {}),
          ...("settings" in innerData
            ? { settings: innerData.settings as Record<string, unknown> }
            : {}),
          ...("metadata" in innerData
            ? { metadata: innerData.metadata as Record<string, unknown> }
            : {}),
        });
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

  // ── project / archive ─────────────────────────────────────────────────────────
  // The librarian archiver (packages/jobs) files these: a stale ACTIVE project
  // (>30d old, zero belongs_to_project members, zero project_members) is proposed
  // for archival. On approval the project's status flips to `archived`.
  //
  // Runs the flip via ProjectRepository.update as the project's OWNER (not the
  // approver) — mirrors entity/merge's "act as the data owner" so it works for
  // POD-WIDE (null-workspace) projects too (workspaceProcedure requires a
  // workspace, so the direct-router path can't archive a pod-wide project). The
  // proposal data is flat (insertPendingProposal), so the project id is read from
  // proposal.targetId.
  registerProposalExecutor({
    key: "project/archive",
    async execute({ proposal, userId, input, deps }) {
      const projectId = proposal.targetId;

      // Idempotency: approve is not status-guarded before dispatch.
      const [alreadyDone] = await db
        .select({ status: proposals.status })
        .from(proposals)
        .where(eq(proposals.id, input.proposalId));
      if (alreadyDone?.status === ProposalStatus.APPROVED) {
        return { success: true, alreadyApproved: true };
      }

      const project = await db.query.projects.findFirst({
        where: eq(projects.id, projectId),
        columns: { id: true, userId: true, workspaceId: true, status: true },
      });
      if (!project) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Project to archive no longer exists",
        });
      }

      // Workspace-scoped projects: verify the approver has workspace access.
      if (project.workspaceId) {
        const membership = await getWorkspaceMembership(
          db,
          project.workspaceId,
          userId
        );
        if (!membership) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "No workspace access",
          });
        }
      }

      // Re-validate zero-gravity AT APPROVAL TIME: the librarian proposed this
      // days ago possibly — if entities or members accrued since, the stale
      // "0 links for 30 days" rationale no longer holds. No-op instead of
      // archiving a now-active project (approval still closes the proposal).
      const [{ linkCount }] = await db
        .select({ linkCount: drizzleSql<number>`count(*)::int` })
        .from(relations)
        .where(
          and(
            eq(relations.targetEntityId, projectId),
            eq(relations.type, "belongs_to_project")
          )
        );
      const [{ memberCount }] = await db
        .select({ memberCount: drizzleSql<number>`count(*)::int` })
        .from(projectMembers)
        .where(eq(projectMembers.projectId, projectId));
      const gravityAppeared = Number(linkCount) > 0 || Number(memberCount) > 0;

      if (!gravityAppeared && project.status !== "archived") {
        const eventRepo = new EventRepository(sql);
        const projectRepo = new ProjectRepository(db, eventRepo);
        // Act as the OWNER — ProjectRepository.update gates on userId, and
        // pod-wide projects are owned by their creator.
        await projectRepo.update(
          projectId,
          { status: "archived" },
          project.userId
        );

        auditLog({
          subjectType: "project",
          action: "update",
          phase: "completed",
          subjectId: projectId,
          userId: project.userId,
          workspaceId: project.workspaceId ?? undefined,
        });

        emitSideEffects({
          subjectType: "project",
          action: "update",
          subjectId: projectId,
          userId: project.userId,
          workspaceId: project.workspaceId ?? undefined,
        });
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
