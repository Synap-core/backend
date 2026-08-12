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
  // DATA-SHAPE NOTE: the propose gate (routers/projects.ts + hub-protocol/rest/
  // projects.ts) stores only { name } in the proposal `data`, so only the name is
  // reconstructed today — description/status/settings/metadata are NOT carried
  // through the proposal and fall to create-time defaults (create-then-configure:
  // a name is the minimum for the project to exist). The other fields are read
  // defensively so a future gate-`data` widening flows through with no change here.
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
