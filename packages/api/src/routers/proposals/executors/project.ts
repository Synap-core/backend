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
import { assertWorkspaceWrite } from "../../../utils/workspace-write-access.js";
import { projectsRouter } from "../../projects.js";
import type { Context } from "../../../context.js";
import { registerProposalExecutor } from "../execution-registry.js";
import { assertApplied, reportApproved } from "./shared.js";

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
      // A NULL workspace is legitimate now that `projects.create` is a
      // podProcedure: an agent creating with no active workspace proposes a
      // POD-PERSONAL project. Rejecting that here would file a proposal that
      // could never be approved — the reviewer would see it forever.
      const workspaceId = proposal.workspaceId ?? null;

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

      // Membership is verified only when the proposal HAS a workspace. A
      // pod-personal project has none to be a member of; its floor is ownership,
      // which the create itself applies (`userId: ctx.userId`).
      const membership = workspaceId
        ? await getWorkspaceMembership(db, workspaceId, userId)
        : null;
      if (workspaceId && !membership) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "No workspace access",
        });
      }
      const projectCaller = projectsRouter.createCaller({
        db,
        authenticated: true as const,
        userId,
        workspaceId: workspaceId ?? undefined,
        workspaceRole: membership?.role,
      } as unknown as Context);
      // The replay must APPLY, never re-propose — see `assertApplied`.
      assertApplied(
        await projectCaller.create({
          name,
          description: innerData.description as string | undefined,
          status: innerData.status as
            "active" | "archived" | "completed" | undefined,
          phase: innerData.phase as string | undefined,
          subjectEntityId: innerData.subjectEntityId as string | undefined,
          settings: innerData.settings as Record<string, unknown> | undefined,
          metadata: innerData.metadata as Record<string, unknown> | undefined,
        })
      );

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
        columns: { id: true, workspaceId: true, userId: true },
      });
      if (!project) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Project to update no longer exists",
        });
      }
      // Pod-personal project (`projects.workspaceId` NULL): there is no
      // membership row to check — `eq(workspace_members.workspace_id, NULL)`
      // matches nothing — so run at pod scope, exactly as `project/create` and
      // `project/archive` in this same file already do.
      //
      // The BAD_REQUEST this replaces said "workspaceProcedure requires a
      // workspace". That premise is STALE: `projectsRouter.update` and
      // `setAutomationMembership` are both `podProcedure` now, and `update`'s
      // own doc comment records fixing precisely this ("it 400'd pod-wide, so a
      // pod-personal project could never be edited"). The executor kept the
      // 400, so an approver saw the Approve button (review-authority is
      // pod-wide-aware) and got a hard error with no path forward.
      //
      // No authority is widened: `computeCanReviewApproval` already gated this
      // call upstream (pod-wide ⇒ owner / agent-owner / pod-admin ONLY), and
      // the write below still executes as `project.userId`, so
      // `ProjectRepository.update`'s `eq(projects.userId, …)` ownership
      // predicate — plus `loadVisibleProject` inside the podProcedure — remain
      // the floor exactly as on the workspace path.
      const membership = project.workspaceId
        ? await getWorkspaceMembership(db, project.workspaceId, userId)
        : null;
      if (project.workspaceId && !membership) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "No workspace access",
        });
      }

      // Act as the project's OWNER, not the approver — the same choice
      // `project/archive` below makes, and for the same reason:
      // `ProjectRepository.update` gates `.where(eq(projects.userId, userId))`,
      // an OWNERSHIP predicate. Replaying as the approver meant a workspace
      // ADMIN approving a teammate's project matched no row and threw a raw
      // `Error("Project not found")` → 500. Because that throw precedes the
      // status update below, the proposal then stayed PENDING forever,
      // approvable only by whoever happened to create the project.
      //
      // The APPROVER's authority was already established above (membership +
      // the review-authority gate upstream); this only decides which identity
      // the write executes as. `reviewedBy` on the proposal still records who
      // actually approved, so attribution is not lost.
      const projectCaller = projectsRouter.createCaller({
        db,
        authenticated: true as const,
        userId: project.userId,
        workspaceId: project.workspaceId ?? undefined,
        workspaceRole: membership?.role,
      } as unknown as Context);

      // TWO doors share the `project/update` key: the field patch, and the
      // automation-membership change (both are governed as a project update,
      // because the project is the thing whose composition changes). They carry
      // different payloads, so replaying a membership proposal through `update`
      // would call it with only an id — a silent no-op wearing an approval.
      // Discriminate on the payload the membership door stamps.
      if ("automationId" in innerData && "member" in innerData) {
        assertApplied(
          await projectCaller.setAutomationMembership({
            projectId,
            automationId: innerData.automationId as string,
            member: innerData.member === true,
          })
        );
      } else {
        // Only fields the proposal actually carries are replayed — an absent key
        // must stay absent, because `null` MEANS "clear it" for phase/subject.
        assertApplied(
          await projectCaller.update({
            id: projectId,
            ...("name" in innerData ? { name: innerData.name as string } : {}),
            ...("description" in innerData
              ? { description: innerData.description as string }
              : {}),
            ...("status" in innerData
              ? {
                  status: innerData.status as
                    "active" | "archived" | "completed",
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
          })
        );
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

  // ── project / instantiate_from_playbook ──────────────────────────────────────
  // An agent binding a project to a project-scoped playbook files a proposal.
  // Registering the executor is NOT optional: without it the `*​/*` catch-all
  // throws NOT_IMPLEMENTED, the reviewer approves, and nothing happens — the
  // exact defect this file's `project/update` comment records having shipped
  // more than once. The tripwire in `__tripwires__/governed-writes-have-approval-
  // half.test.ts` now names this key too.
  //
  // The gate stores `{ id, playbookId }` — both ids the replay needs. Nothing
  // DERIVED from them (the copied stages, the seeded phase) is stored: the
  // replay re-reads the playbook, so an approval materializes the template as it
  // stands at approval time, and the scope check + visibility floors run again.
  registerProposalExecutor({
    key: "project/instantiate_from_playbook",
    async execute({ proposal, userId, input, deps }) {
      const innerData = ((proposal.data as Record<string, unknown>)?.data ??
        {}) as Record<string, unknown>;
      const projectId =
        (innerData.id as string | undefined) ?? proposal.targetId;
      const playbookId = innerData.playbookId as string | undefined;
      if (!projectId || !playbookId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Project playbook-binding proposal is missing the project or playbook id",
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

      // Workspace from the PROJECT ROW, never from the proposal.
      const project = await db.query.projects.findFirst({
        where: eq(projects.id, projectId),
        columns: { id: true, workspaceId: true, userId: true },
      });
      if (!project) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Project to bind no longer exists",
        });
      }
      const membership = project.workspaceId
        ? await getWorkspaceMembership(db, project.workspaceId, userId)
        : null;
      if (project.workspaceId && !membership) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "No workspace access",
        });
      }

      // Act as the project's OWNER, not the approver — the same choice
      // `project/update` and `project/archive` make, and for the same reason:
      // the write goes through `ProjectRepository.update`, whose
      // `.where(eq(projects.userId, userId))` is an OWNERSHIP predicate. Running
      // as the approver would match no row and throw a raw
      // `Error("Project not found")` → 500, BEFORE the status update below, so
      // the proposal would stay PENDING forever. The approver's authority was
      // already established by `computeCanReviewApproval` upstream plus the
      // membership check above; `reviewedBy` still records who approved.
      const projectCaller = projectsRouter.createCaller({
        db,
        authenticated: true as const,
        userId: project.userId,
        workspaceId: project.workspaceId ?? undefined,
        workspaceRole: membership?.role,
      } as unknown as Context);

      // The replay must APPLY, never re-propose — see `assertApplied`.
      assertApplied(
        await projectCaller.instantiateFromPlaybook({ projectId, playbookId })
      );

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
  // ── project / delete ─────────────────────────────────────────────────────
  // `projects.delete` (routers/projects.ts:1040) sits on the rung-2.5
  // DESTRUCTIVE floor, which NO governance rung can widen — so an agent
  // deleting a project ALWAYS proposes. There was no `project/delete`
  // executor, so approval fell to the `*​/*` catch-all, which for a gate-made
  // proposal does NOT throw: it emits `.validated`, flips the row APPROVED and
  // returns success. The reviewer saw green on a destructive action that never
  // happened. Same defect class as `project/update` and `playbook/archive`
  // above; this is the third time it has shipped in this file's domain.
  //
  // PAYLOAD: the gate stores FLAT `data: { id }`, which the request-shaped
  // envelope nests as `data.data.id`; `proposal.targetId` carries the same id.
  // All three shapes are read so a proposal filed by either convention applies.
  //
  // SECOND EFFECT: the direct path is THREE writes, not one —
  // `ProjectRepository.delete` (row + `project.delete.completed` spine event +
  // `triggerCpProjectSync`, which is what lets the CP tombstone the directory
  // row), then `auditLog`, then `emitSideEffects` (the automation reactor bus).
  // Deleting the row here would have left the CP directory and every reactor
  // blind. So this replays through `projectsRouter.delete` — ONE door, all
  // three effects, and it cannot drift from the direct path.
  //
  // IDENTITY: acts as the project's OWNER, exactly as `project/update` above
  // and for the same reason — `loadVisibleProject` is a VISIBILITY predicate,
  // and a pod-personal project (`workspaceId` NULL) is visible only to its
  // owner, so replaying as a workspace admin would throw NOT_FOUND *before*
  // the status update and strand the proposal PENDING forever. No authority is
  // widened: the APPROVER's own floor is asserted first against the LOADED row
  // (`assertWorkspaceWrite`), which is the same-or-stricter check the direct
  // path applies, and `reviewedBy` still records who actually approved.
  registerProposalExecutor({
    key: "project/delete",
    async execute({ proposal, userId, input, deps }) {
      const raw = (proposal.data ?? {}) as Record<string, unknown>;
      const inner = (raw.data ?? {}) as Record<string, unknown>;
      const projectId =
        (inner.id as string | undefined) ??
        (raw.id as string | undefined) ??
        proposal.targetId;
      if (!projectId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Project delete proposal is missing the project id",
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

      const project = await db.query.projects.findFirst({
        where: eq(projects.id, projectId),
        columns: { id: true, workspaceId: true, userId: true },
      });
      if (!project) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Project to delete no longer exists",
        });
      }

      // The APPROVER's floor, on the LOADED row's workspace (never the
      // request-shaped `proposal.workspaceId`).
      await assertWorkspaceWrite(db, userId, {
        workspaceId: project.workspaceId,
        ownerId: project.userId,
      });
      const membership = project.workspaceId
        ? await getWorkspaceMembership(db, project.workspaceId, userId)
        : null;

      const projectCaller = projectsRouter.createCaller({
        db,
        authenticated: true as const,
        userId: project.userId,
        workspaceId: project.workspaceId ?? undefined,
        workspaceRole: membership?.role,
      } as unknown as Context);

      // The replay must APPLY, never re-propose — see `assertApplied`.
      assertApplied(await projectCaller.delete({ id: projectId }));

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
