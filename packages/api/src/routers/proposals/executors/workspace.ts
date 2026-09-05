import { TRPCError } from "@trpc/server";
import {
  db,
  proposals,
  eq,
  getWorkspaceMembership,
  workspaces,
} from "@synap/database";
import { ProposalStatus } from "@synap/database/schema";
import { createLogger } from "@synap-core/core";
import { auditLog } from "../../../utils/audit-log.js";
import { workspaceRuntimePrimarySurfaceSchema } from "../../../schemas/workspace-primary-surface.js";
import { registerProposalExecutor } from "../execution-registry.js";
import { assertApplied, reportApproved } from "./shared.js";
import type { Context } from "../../../context.js";

const logger = createLogger({ module: "proposal-approve-executors-workspace" });

/** Register the workspace/* approve executors. */
export function registerWorkspaceExecutors(): void {
  // ── workspace / create ─────────────────────────────────────────────────────
  // A gated createWorkspace (packages.apply / MCP synap_create_workspace /
  // agent-authored freehand invent) lands here on approval. Without this
  // executor the `*/*` catch-all flips APPROVED but never materializes the
  // workspace — the definition was discarded at the gate (name-only) and
  // approve had no door to call. Materializes via the SAME
  // `materializeWorkspaceCore` the Hub packages.apply path uses on grant —
  // re-run as the APPROVER (userId) so audit/membership attribute to the
  // reviewer. The full PackageApply / WorkspaceDefinitionInput lives on
  // `proposal.data.data.definition` (RequestShaped nested bag).
  //
  // DATA-SHAPE NOTE: the propose gates (hub-protocol/rest/packages.ts +
  // mcp/adapter.ts synap_create_workspace) store the full definition +
  // workspaceName/templateId/packageSlug/workspaceType/proposalId/createdBy
  // so re-approve can reconstruct the create exactly. `proposalId` prefers
  // the gate's stable key (package slug / caller idempotency key) and falls
  // back to the proposal row id so re-approve is always stable.
  registerProposalExecutor({
    key: "workspace/create",
    async execute({ proposal, payload, userId, input, deps }) {
      const inner = ((proposal.data as Record<string, unknown>)?.data ??
        proposal.data ??
        {}) as Record<string, unknown>;
      const name =
        (inner.name as string | undefined) ??
        (inner.workspaceName as string | undefined);
      if (!name || typeof name !== "string" || name.trim() === "") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Workspace proposal is missing name",
        });
      }

      // Idempotency: approve is not status-guarded before dispatch; skip if
      // already materialized (idempotent create would still re-hit deps/reconcile).
      const [alreadyDone] = await db
        .select({ status: proposals.status })
        .from(proposals)
        .where(eq(proposals.id, input.proposalId));
      if (alreadyDone?.status === ProposalStatus.APPROVED) {
        return { success: true, alreadyApproved: true };
      }

      const {
        materializeWorkspaceCore,
        ComposeBaseUnavailableError,
        DependencyResolutionError,
        ComposeBaseNotFoundError,
        ComposeOverlayError,
      } =
        await import("../../../services/workspace-materialization-service.js");

      let core: Awaited<ReturnType<typeof materializeWorkspaceCore>>;
      try {
        core = await materializeWorkspaceCore({
          definition: (inner.definition ??
            {}) as import("@synap/database").WorkspaceDefinitionInput,
          userId,
          agentUserId: proposal.agentUserId ?? undefined,
          proposalId:
            (inner.proposalId as string | undefined) ?? input.proposalId,
          workspaceName: (inner.workspaceName as string | undefined) ?? name,
          templateId: inner.templateId as string | undefined,
          packageSlug: inner.packageSlug as string | undefined,
          workspaceType: inner.workspaceType as
            "personal" | "agent" | "project" | "operational" | undefined,
          createdBy:
            (inner.createdBy as
              "user" | "provisioning" | "plugin" | undefined) ?? "provisioning",
        });
      } catch (e) {
        if (
          e instanceof DependencyResolutionError ||
          e instanceof ComposeBaseUnavailableError ||
          e instanceof ComposeOverlayError
        ) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: (e as Error).message,
          });
        }
        if (e instanceof ComposeBaseNotFoundError) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: (e as Error).message,
          });
        }
        throw e;
      }

      // deferCreate is never set here — core is "created" | "composed" (both
      // carry workspaceId). Narrow so the "resolved"-only union arm is excluded.
      if (core.status === "resolved") {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message:
            "Workspace materialize returned resolved-without-create (unexpected on approve path)",
        });
      }
      const workspaceId = core.workspaceId;

      // Stamp the produced workspaceId onto the proposal row so clients/revert
      // can recover it (ProposalMaterializedRecord has no workspaceIds field —
      // store as a sibling lifecycle key next to materialized).
      void payload;
      const updatedData = {
        ...((proposal.data as Record<string, unknown> | null | undefined) ??
          {}),
        materializedWorkspaceId: workspaceId,
        materializeStatus: core.status,
      };

      await db
        .update(proposals)
        .set({
          status: ProposalStatus.APPROVED,
          data: updatedData,
          reviewedBy: userId,
          reviewedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(proposals.id, input.proposalId));

      // packages.apply: after workspace materialize, run the SAME post-workspace
      // layers as the grant path (enroll agent + caps/autos/playbooks/loops).
      // Without this, every agent package install silently dropped Phase 2.
      const source = inner.source as string | undefined;
      const definition = (inner.definition ?? {}) as Record<string, unknown>;
      const needsPost =
        source === "packages.apply" ||
        Boolean(
          definition.capabilities ||
          definition.automations ||
          definition.playbooks ||
          definition.loops ||
          definition.projectId
        );
      if (needsPost) {
        try {
          const { applyPackagePostWorkspace } =
            await import("../../../services/package-apply-post-workspace.js");
          await applyPackagePostWorkspace({
            workspaceId,
            body: definition as Parameters<
              typeof applyPackagePostWorkspace
            >[0]["body"],
            userId,
            // Approver is authority for creates; still enroll the proposing
            // agent so follow-on agent writes don't collapse to join proposals.
            agentUserId: proposal.agentUserId ?? undefined,
            scopes: [],
          });
        } catch (e) {
          // Workspace already exists — surface post-layer failure rather than
          // leaving APPROVED with a silent partial package. Scrub the raw cause
          // (it can carry DB/connector internals) to the operator log; the client
          // gets a fixed message, not the interpolated exception text (E1).
          logger.warn(
            { proposalId: input.proposalId, err: (e as Error).message },
            "workspace create: package layers failed post-workspace"
          );
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message:
              "Workspace created, but applying its package layers failed.",
          });
        }
      }

      // Report to IS telemetry (fire-and-forget — never blocks)
      reportApproved(deps, proposal, input.proposalId);

      deps.emitProposalReviewed(
        input.proposalId,
        proposal.workspaceId,
        "approved",
        userId
      );
      return { success: true, primaryId: workspaceId };
    },
  });

  // ── workspace / join ───────────────────────────────────────────────────────
  registerProposalExecutor({
    key: "workspace/join",
    async execute({ proposal, payload, userId, input, deps }) {
      void payload;
      const joinData = (proposal.data ?? {}) as Record<string, unknown>;

      // Pre-flight: `proposals.workspaceId` has NO foreign key to `workspaces`
      // (workspaceMembers does, ON DELETE CASCADE), so a pending join can
      // outlive the workspace it targets. Without this check, approve would
      // emit `.validated`, flip the row APPROVED, and only THEN — in the
      // materializer worker, async — hit the membership insert's FK violation.
      // The reviewer would see success while no membership was ever granted.
      // This does not replace the materializer's FK (still the backstop for
      // any other route into that insert); it only turns the failure loud and
      // synchronous on the approve path instead of silent and deferred.
      //
      // Resolve the target the SAME way `materializeWorkspace` does
      // (`data.workspaceId || workspaceId || subjectId` in materializer.ts) —
      // the audit event below stamps `data.workspaceId: proposal.workspaceId`
      // and the worker is invoked with that same `proposal.workspaceId`, so
      // both arms of that `||` collapse to `proposal.workspaceId`, falling
      // back to `proposal.targetId` (the materializer's `subjectId`).
      const targetWorkspaceId = proposal.workspaceId || proposal.targetId;
      if (targetWorkspaceId) {
        const [existing] = await db
          .select({ id: workspaces.id })
          .from(workspaces)
          .where(eq(workspaces.id, targetWorkspaceId));
        if (!existing) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              `Workspace ${targetWorkspaceId} no longer exists — this join ` +
              "proposal cannot be approved and should be rejected.",
          });
        }
      }

      const validatedEvent = await auditLog({
        subjectType: "workspace",
        action: "join",
        phase: "validated",
        throwOnError: true,
        subjectId: proposal.targetId,
        userId,
        workspaceId: proposal.workspaceId ?? undefined,
        correlationId:
          typeof joinData.correlationId === "string"
            ? joinData.correlationId
            : undefined,
        data: {
          role: typeof joinData.role === "string" ? joinData.role : "editor",
          agentUserId: proposal.agentUserId ?? joinData.agentUserId,
          workspaceId: proposal.workspaceId,
          approvedBy: userId,
          approvedAt: new Date().toISOString(),
          approvalComment: input.comment,
          sourceProposalId: input.proposalId,
        },
        source: "api",
      });

      const joinUpdatedData = {
        ...joinData,
        ...(validatedEvent ? { validatedEventId: validatedEvent.id } : {}),
      };

      await db
        .update(proposals)
        .set({
          status: ProposalStatus.APPROVED,
          data: joinUpdatedData,
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

  // ── workspace / declare_source ───────────────────────────────────────────────
  // (Enterprise-OS Wave 0, now GOVERNED) A gated `synap_declare_workspace_source`
  // / Hub `PATCH /workspaces/:id/source-edges` (agent-authored, or a member whose
  // role lacks `write`) lands here on approval. Rewiring pod-wide cross-workspace
  // read routing must go through review, not apply immediately — so this executor
  // is what makes approval actually merge the edge. Materializes via the SAME
  // `mergeWorkspaceSourceEdges` apply fn the direct/auto-approve path uses — re-run
  // as the APPROVER (userId) so the settings merge + `feeds`-link materialization
  // attribute to the reviewer. Without this executor the `*/*` catch-all would flip
  // the proposal APPROVED (emit `.validated`) but NEVER merge the edge — the
  // cross-workspace reads would silently never redirect.
  //
  // DATA-SHAPE NOTE: the propose gate stores exactly `{ sourceRoles,
  // defaultSources }` in the proposal `data.data` — the full input
  // `mergeWorkspaceSourceEdges` needs. The target workspace is `proposal.workspaceId`
  // (the consumer workspace the edge is declared ON), the SAME workspace the gate
  // RBAC-checked (mirrors project/create using proposal.workspaceId).
  registerProposalExecutor({
    key: "workspace/declare_source",
    async execute({ proposal, userId, input, deps }) {
      const innerData = ((proposal.data as Record<string, unknown>)?.data ??
        {}) as Record<string, unknown>;
      const workspaceId = proposal.workspaceId ?? null;
      if (!workspaceId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Workspace source-edge proposal is missing a valid workspaceId",
        });
      }

      // Idempotency: approve is not status-guarded before dispatch, so skip if
      // this proposal was already materialized (a re-approve would re-merge —
      // harmless (mergeSettings is idempotent) but the guard mirrors the siblings).
      const [alreadyDone] = await db
        .select({ status: proposals.status })
        .from(proposals)
        .where(eq(proposals.id, input.proposalId));
      if (alreadyDone?.status === ProposalStatus.APPROVED) {
        return { success: true, alreadyApproved: true };
      }

      const { WorkspaceSourceEdgeInputSchema, mergeWorkspaceSourceEdges } =
        await import("../../../services/workspace-edge-service.js");
      const parsed = WorkspaceSourceEdgeInputSchema.safeParse({
        sourceRoles: innerData.sourceRoles,
        defaultSources: innerData.defaultSources,
      });
      if (
        !parsed.success ||
        (!parsed.data.sourceRoles && !parsed.data.defaultSources)
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Workspace source-edge proposal is missing sourceRoles/defaultSources",
        });
      }

      // Apply as the APPROVER — the same door the granted/direct path calls.
      await mergeWorkspaceSourceEdges(workspaceId, parsed.data, userId);

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

  // ── workspace / configure_public_projection ─────────────────────────────────
  // A gated Hub `PATCH /workspaces/:id/public-projection` (agent-authored, or a
  // member whose role lacks `write`) lands here on approval. Opting a workspace
  // into an UNAUTHENTICATED public projection must go through review, not apply
  // immediately — so this executor is what makes approval actually write the
  // config. Materializes via the SAME `setWorkspacePublicProjection` apply fn the
  // direct/auto-approve path uses — re-run as the APPROVER (userId) so the
  // settings merge attributes to the reviewer. Without this executor the `*/*`
  // catch-all would flip the proposal APPROVED (emit `.validated`) but NEVER
  // write the config — the public surface would silently never open.
  //
  // DATA-SHAPE NOTE: the propose gate stores exactly `{ enabled, roles, fields }`
  // in the proposal `data.data` — the full input `setWorkspacePublicProjection`
  // needs. The target workspace is `proposal.workspaceId` (the SAME workspace the
  // gate RBAC-checked, mirrors workspace/declare_source).
  registerProposalExecutor({
    key: "workspace/configure_public_projection",
    async execute({ proposal, userId, input, deps }) {
      const innerData = ((proposal.data as Record<string, unknown>)?.data ??
        {}) as Record<string, unknown>;
      const workspaceId = proposal.workspaceId ?? null;
      if (!workspaceId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Workspace public-projection proposal is missing a valid workspaceId",
        });
      }

      // Idempotency: approve is not status-guarded before dispatch, so skip if
      // this proposal was already materialized (a re-approve would re-write —
      // harmless (mergeSettings is idempotent) but the guard mirrors the siblings).
      const [alreadyDone] = await db
        .select({ status: proposals.status })
        .from(proposals)
        .where(eq(proposals.id, input.proposalId));
      if (alreadyDone?.status === ProposalStatus.APPROVED) {
        return { success: true, alreadyApproved: true };
      }

      const { PublicProjectionInputSchema, setWorkspacePublicProjection } =
        await import("../../../services/workspace-projection-service.js");
      const parsed = PublicProjectionInputSchema.safeParse({
        enabled: innerData.enabled,
        roles: innerData.roles,
        fields: innerData.fields,
      });
      if (!parsed.success) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Workspace public-projection proposal is missing a valid { enabled, roles, fields } config",
        });
      }

      // Apply as the APPROVER — the same door the granted/direct path calls.
      await setWorkspacePublicProjection(workspaceId, parsed.data, userId);

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

  // ── workspace / update ───────────────────────────────────────────────────────
  // Hub `POST /packages/apply` with `targetWorkspaceId` set (install-onto-
  // existing) proposes via `subjectType:"workspace", action:"update"` when the
  // caller can't auto-approve (workspace.update ∈ ADMIN_ACTIONS). Without this
  // executor the generic `*/*` catch-all only flipped the row APPROVED — the
  // additive reconcile never ran. Re-runs the SAME `materializeWorkspaceCore`
  // (targetWorkspaceId forces the `composeOntoBaseWorkspace` branch) the grant
  // path drives, from the FULL package body the route already stores as
  // `data.definition` (packages.ts:246-276), then the SAME phase-2
  // `applyPackagePostWorkspace` layers — stamping the APPROVER as the acting
  // userId (mirrors workspace/create's approve-as-authority above).
  registerProposalExecutor({
    key: "workspace/update",
    async execute({ proposal, payload, userId, input, deps }) {
      void payload;
      const inner = ((proposal.data as Record<string, unknown>)?.data ??
        proposal.data ??
        {}) as Record<string, unknown>;
      const targetWorkspaceId =
        (inner.targetWorkspaceId as string | undefined) ??
        proposal.workspaceId ??
        undefined;
      if (!targetWorkspaceId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Workspace update proposal is missing targetWorkspaceId",
        });
      }

      // Idempotency: skip if already materialized.
      const [alreadyDone] = await db
        .select({ status: proposals.status })
        .from(proposals)
        .where(eq(proposals.id, input.proposalId));
      if (alreadyDone?.status === ProposalStatus.APPROVED) {
        return { success: true, alreadyApproved: true };
      }

      if (inner.operation === "set_primary_surface") {
        const parsedSurface = workspaceRuntimePrimarySurfaceSchema
          .nullable()
          .safeParse(inner.primarySurface);
        if (!parsedSurface.success) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Workspace start proposal has an invalid primary surface",
          });
        }

        const { getDb, eventRepository, WorkspaceRepository } =
          await import("@synap/database");
        const dbConn = await getDb();
        const workspaceRepo = new WorkspaceRepository(dbConn, eventRepository);
        await workspaceRepo.setPrimarySurface(
          targetWorkspaceId,
          parsedSurface.data,
          userId
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
        return { success: true, primaryId: targetWorkspaceId };
      }

      const {
        materializeWorkspaceCore,
        ComposeBaseUnavailableError,
        DependencyResolutionError,
        ComposeBaseNotFoundError,
        ComposeOverlayError,
      } =
        await import("../../../services/workspace-materialization-service.js");

      const definition = (inner.definition ?? {}) as Record<string, unknown>;

      let core: Awaited<ReturnType<typeof materializeWorkspaceCore>>;
      try {
        core = await materializeWorkspaceCore({
          definition:
            definition as unknown as import("@synap/database").WorkspaceDefinitionInput,
          userId,
          agentUserId: proposal.agentUserId ?? undefined,
          selfSlug: inner.packageSlug as string | undefined,
          targetWorkspaceId,
          proposalId:
            (inner.proposalId as string | undefined) ?? input.proposalId,
          workspaceName: inner.workspaceName as string | undefined,
          templateId: inner.templateId as string | undefined,
          packageSlug: inner.packageSlug as string | undefined,
          packageVersion: inner.packageVersion as string | undefined,
          workspaceType: inner.workspaceType as
            "personal" | "agent" | "project" | "operational" | undefined,
        });
      } catch (e) {
        if (
          e instanceof DependencyResolutionError ||
          e instanceof ComposeBaseUnavailableError ||
          e instanceof ComposeOverlayError
        ) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: (e as Error).message,
          });
        }
        if (e instanceof ComposeBaseNotFoundError) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: (e as Error).message,
          });
        }
        throw e;
      }

      // targetWorkspaceId always forces the "composed" branch inside
      // materializeWorkspaceCore (never "created"/"resolved") — narrow so the
      // rest of this executor can read workspaceId unconditionally.
      if (core.status !== "composed") {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Workspace update materialize returned unexpected status "${core.status}" for a targeted install`,
        });
      }
      const workspaceId = core.workspaceId;

      const updatedData = {
        ...((proposal.data as Record<string, unknown> | null | undefined) ??
          {}),
        materializedWorkspaceId: workspaceId,
        materializeStatus: core.status,
      };

      await db
        .update(proposals)
        .set({
          status: ProposalStatus.APPROVED,
          data: updatedData,
          reviewedBy: userId,
          reviewedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(proposals.id, input.proposalId));

      // Phase 2: same post-workspace layers the grant path always runs after a
      // "composed" outcome (packages.ts has no `unchanged` discriminator on
      // that branch — it always re-seeds, see packages.ts:450).
      try {
        const { applyPackagePostWorkspace } =
          await import("../../../services/package-apply-post-workspace.js");
        await applyPackagePostWorkspace({
          workspaceId,
          body: definition as Parameters<
            typeof applyPackagePostWorkspace
          >[0]["body"],
          userId,
          agentUserId: proposal.agentUserId ?? undefined,
          scopes: [],
        });
      } catch (e) {
        // Scrub the raw cause to the operator log; the client gets a fixed
        // message, not interpolated exception text (E1).
        logger.warn(
          { proposalId: input.proposalId, err: (e as Error).message },
          "workspace update: package layers failed post-workspace"
        );
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Workspace updated, but applying its package layers failed.",
        });
      }

      // Report to IS telemetry (fire-and-forget — never blocks)
      reportApproved(deps, proposal, input.proposalId);

      deps.emitProposalReviewed(
        input.proposalId,
        proposal.workspaceId,
        "approved",
        userId
      );
      return { success: true, primaryId: workspaceId };
    },
  });

  // ── workspace / adopt ────────────────────────────────────────────────────────
  // Hub `POST /pod/adopt` (`hub-protocol/rest/pod-adopt.ts`) proposes via
  // `subjectType:"workspace", action:"adopt"` for agent callers under the same
  // ADMIN_ACTIONS floor. Re-runs the SAME stamp-then-reconcile sequence the
  // grant path performs inline: `WorkspaceRepository.mergeSettings` (lifts
  // packageSlug/proposalId onto the workspace settings) then
  // `reconcileWorkspaceFromDefinition({ mergeCapabilities: true })` — never
  // destructive, never a second workspace. The template is re-resolved FRESH at
  // approval time via `resolveWorkspaceTemplate` (mirrors the grant path, which
  // also resolves at call time rather than trusting a stale snapshot) — only
  // `templateSlug` needs to survive from propose to approve.
  registerProposalExecutor({
    key: "workspace/adopt",
    async execute({ proposal, payload, userId, input, deps }) {
      void payload;
      const inner = ((proposal.data as Record<string, unknown>)?.data ??
        proposal.data ??
        {}) as Record<string, unknown>;
      const templateSlug = inner.templateSlug as string | undefined;
      const workspaceId =
        (inner.workspaceId as string | undefined) ??
        proposal.workspaceId ??
        undefined;
      if (!templateSlug || !workspaceId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Workspace adopt proposal is missing templateSlug or workspaceId",
        });
      }

      // Idempotency: skip if already materialized.
      const [alreadyDone] = await db
        .select({ status: proposals.status })
        .from(proposals)
        .where(eq(proposals.id, input.proposalId));
      if (alreadyDone?.status === ProposalStatus.APPROVED) {
        return { success: true, alreadyApproved: true };
      }

      const { resolveWorkspaceTemplate } =
        await import("../../../services/capabilities/resolve-workspace-template.js");
      const resolved = await resolveWorkspaceTemplate(templateSlug);
      if (!resolved) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Unknown template: ${templateSlug}`,
        });
      }

      const {
        getDb,
        eventRepository,
        WorkspaceRepository,
        reconcileWorkspaceFromDefinition,
      } = await import("@synap/database");

      const settingsPatch: Partial<
        import("@synap/database").WorkspaceSettings
      > = {
        packageSlug: templateSlug,
        proposalId: templateSlug,
        ...(resolved.version ? { packageVersion: resolved.version } : {}),
      };
      const dbConn = await getDb();
      const workspaceRepo = new WorkspaceRepository(dbConn, eventRepository);
      // Approver is the authority — same as workspace/create above.
      await workspaceRepo.mergeSettings(workspaceId, settingsPatch, userId);

      const report = await reconcileWorkspaceFromDefinition({
        workspaceId,
        userId,
        definition: resolved.workspaceDefinition as unknown as Parameters<
          typeof reconcileWorkspaceFromDefinition
        >[0]["definition"],
        mergeCapabilities: true,
      });

      const updatedData = {
        ...((proposal.data as Record<string, unknown> | null | undefined) ??
          {}),
        materializedWorkspaceId: workspaceId,
        reconcile: {
          profilesAdded: report.profiles.added.length,
          propertiesAdded: report.properties.added.length,
          viewsAdded: report.views.added.length,
          entityLinksAdded: report.entityLinks.added.length,
        },
      };

      await db
        .update(proposals)
        .set({
          status: ProposalStatus.APPROVED,
          data: updatedData,
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
      return { success: true, primaryId: workspaceId };
    },
  });
  // ── workspace / delete ───────────────────────────────────────────────────
  // ⚠️ KEY NAME: the gate at `routers/workspaces.ts:776` passes
  // `subjectType: "workspaces"` (plural), but `permission-check.ts:1893` stores
  // `targetType: singularType` after stripping a trailing "s" — so the row
  // lands as `workspace/delete` and THAT is the key approval resolves. A
  // `workspaces/delete` executor would never match. Verified against
  // `permission-check.ts` lines 1763-1766 (the strip) and 1874/1915/1967 (the
  // three places `singularType` becomes the stored `targetType`).
  //
  // `delete` sits on the rung-2.5 DESTRUCTIVE floor, which no rung can widen,
  // so an agent deleting a workspace ALWAYS proposes. With no executor the
  // `*​/*` catch-all flipped it APPROVED and deleted nothing.
  //
  // PAYLOAD: FLAT `data: { id }` (nested as `data.data.id`); `proposal.targetId`
  // holds the same id. All three shapes are read.
  //
  // SECOND EFFECT: the direct path is THREE writes — `WorkspaceRepository.delete`
  // (row + `workspaces.delete.completed`, emitted through the SHARED
  // `eventRepository` singleton, because a fresh EventRepository has no
  // registered hooks and its append would never reach realtime /
  // materialization / sync), then `auditLog`, then `emitSideEffects`. Replayed
  // through `workspacesRouter.delete` so the shared singleton is the one used.
  //
  // IDENTITY: acts as the APPROVER. There is no ownership row predicate to trip
  // (`WorkspaceRepository.delete` deletes by id), and the re-entrant
  // `checkPermissionOrPropose` inside the procedure re-runs RBAC for the
  // approver — which is exactly the floor that should decide a workspace
  // deletion. Membership is verified up front so a non-member fails loudly
  // before anything is written.
  registerProposalExecutor({
    key: "workspace/delete",
    async execute({ proposal, userId, input, deps }) {
      const raw = (proposal.data ?? {}) as Record<string, unknown>;
      const inner = (raw.data ?? {}) as Record<string, unknown>;
      const workspaceId =
        (inner.id as string | undefined) ??
        (raw.id as string | undefined) ??
        proposal.targetId;
      if (!workspaceId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Workspace delete proposal is missing the workspace id",
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

      const membership = await getWorkspaceMembership(db, workspaceId, userId);
      if (!membership) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "No workspace access",
        });
      }

      const { workspacesRouter } = await import("../../workspaces.js");
      const workspaceCaller = workspacesRouter.createCaller({
        db,
        authenticated: true as const,
        userId,
        workspaceId,
        workspaceRole: membership.role,
      } as unknown as Context);

      // The replay must APPLY, never re-propose — see `assertApplied`.
      assertApplied(await workspaceCaller.delete({ id: workspaceId }));

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

  // ── role / delete ────────────────────────────────────────────────────────
  // Lives in this file because a role is a workspace-scoped object and there is
  // no `executors/role.ts` (adding one would mean editing the aggregator).
  //
  // `roles.delete` (routers/roles.ts:226) sits on the rung-2.5 DESTRUCTIVE
  // floor, so an agent deleting a role ALWAYS proposes; with no executor the
  // `*​/*` catch-all flipped it APPROVED and the role survived.
  //
  // PAYLOAD: FLAT `data: { id }` (nested as `data.data.id`); `proposal.targetId`
  // holds the same id. Note the gate's `workspaceId` comes from the OPTIONAL
  // `input.workspaceId`, so `proposal.workspaceId` can legitimately be null —
  // the router re-resolves the role's REAL workspace itself and gates on that.
  //
  // SECOND EFFECT: the direct path is `scopedDb` visibility load →
  // `assertWorkspaceWrite` on the ROLE's real workspace → `RoleRepository.delete`
  // (row + `role.delete.completed`) → `recordDomainMutation` (the ONE audit +
  // reactor door). Replayed through `rolesRouter.delete` so all of it fires.
  //
  // IDENTITY: acts as the APPROVER — `RoleRepository.delete` carries no
  // ownership predicate, and the router's own `scopedDb` + `assertWorkspaceWrite`
  // are authorization floors that must be cleared by whoever approves.
  registerProposalExecutor({
    key: "role/delete",
    async execute({ proposal, userId, input, deps }) {
      const raw = (proposal.data ?? {}) as Record<string, unknown>;
      const inner = (raw.data ?? {}) as Record<string, unknown>;
      const roleId =
        (inner.id as string | undefined) ??
        (raw.id as string | undefined) ??
        proposal.targetId;
      if (!roleId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Role delete proposal is missing the role id",
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

      const roleWorkspaceId = proposal.workspaceId ?? undefined;
      const membership = roleWorkspaceId
        ? await getWorkspaceMembership(db, roleWorkspaceId, userId)
        : null;
      if (roleWorkspaceId && !membership) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "No workspace access",
        });
      }

      const { rolesRouter } = await import("../../roles.js");
      const roleCaller = rolesRouter.createCaller({
        db,
        authenticated: true as const,
        userId,
        workspaceId: roleWorkspaceId,
        workspaceRole: membership?.role,
      } as unknown as Context);

      // The replay must APPLY, never re-propose — see `assertApplied`.
      assertApplied(
        await roleCaller.delete({
          id: roleId,
          ...(roleWorkspaceId ? { workspaceId: roleWorkspaceId } : {}),
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

  // ── apiKey / delete ──────────────────────────────────────────────────────
  // Lives in this file for the same reason as `role/delete` (no
  // `executors/api-key.ts`, and the aggregator is off-limits).
  //
  // ⚠️ The GATE is inside `apiKeys.revoke` (routers/api-keys.ts:317) but it
  // declares `action: "delete"`, so the stored key is `apiKey/delete` while the
  // door to replay is `revoke`. `delete` sits on the rung-2.5 DESTRUCTIVE
  // floor, so an agent revoking a key ALWAYS proposes; with no executor the
  // `*​/*` catch-all flipped the proposal APPROVED and the key STAYED LIVE —
  // the worst possible false-green, because the whole point of the action is
  // to stop a credential from working.
  //
  // PAYLOAD: FLAT `data: { id }` — the gate stamps `id: input.keyId` (nested as
  // `data.data.id`); `proposal.targetId` holds the same id.
  //
  // ⚠️ FIDELITY LOSS (stated, not hidden): the gate does NOT store
  // `input.reason`, so the replayed revoke writes `revokedReason: undefined`.
  // The revocation itself is complete — only the human note is lost. Fixing it
  // means widening the gate payload, which is a router edit.
  //
  // SECOND EFFECT: the direct path is `ApiKeyRepository.revoke` (sets
  // `isActive: false` + `revokedAt` + `revokedBy`; it deliberately emits NO
  // spine event — "revoke is a state change, not a delete"), then `auditLog`,
  // then `emitSideEffects`. Replayed through `apiKeysRouter.revoke`.
  //
  // IDENTITY: acts as the APPROVER. `revoke` answers NOT_FOUND when
  // `key.userId !== ctx.userId` — an API key is strictly personal, so replaying
  // as the key's owner would let a workspace admin revoke someone else's
  // credential through the approval door. A non-owner approver therefore gets a
  // loud NOT_FOUND, which is the correct answer, not a silent no-op.
  registerProposalExecutor({
    key: "apiKey/delete",
    async execute({ proposal, userId, input, deps }) {
      const raw = (proposal.data ?? {}) as Record<string, unknown>;
      const inner = (raw.data ?? {}) as Record<string, unknown>;
      const keyId =
        (inner.id as string | undefined) ??
        (raw.id as string | undefined) ??
        proposal.targetId;
      if (!keyId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "API key revoke proposal is missing the key id",
        });
      }

      // Idempotency: approve is not status-guarded before dispatch. (`revoke`
      // is itself idempotent — re-setting isActive:false is a no-op — but the
      // guard keeps the double-click path identical to every sibling.)
      const [alreadyDone] = await db
        .select({ status: proposals.status })
        .from(proposals)
        .where(eq(proposals.id, input.proposalId));
      if (alreadyDone?.status === ProposalStatus.APPROVED) {
        return { success: true, alreadyApproved: true };
      }

      const keyWorkspaceId = proposal.workspaceId ?? undefined;
      const membership = keyWorkspaceId
        ? await getWorkspaceMembership(db, keyWorkspaceId, userId)
        : null;
      if (keyWorkspaceId && !membership) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "No workspace access",
        });
      }

      const { apiKeysRouter } = await import("../../api-keys.js");
      const apiKeyCaller = apiKeysRouter.createCaller({
        db,
        authenticated: true as const,
        userId,
        workspaceId: keyWorkspaceId,
        workspaceRole: membership?.role,
      } as unknown as Context);

      // The replay must APPLY, never re-propose — see `assertApplied`.
      assertApplied(
        await apiKeyCaller.revoke({
          keyId,
          ...(keyWorkspaceId ? { workspaceId: keyWorkspaceId } : {}),
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

  // ── workspaceMember / add · remove · updateRole ───────────────────────────
  // The THREE membership doors. They live in this file for the same reason
  // `role/delete` and `apiKey/delete` do: there is no `executors/workspace-
  // member.ts`, and every one of them replays through `workspacesRouter`.
  //
  // WHY THEY PROPOSE: `workspaceMember.*` is not in DEFAULT_AUTO_APPROVE, so
  // any agent-authored membership change falls to rung 9 (propose). `remove`
  // additionally sits on the rung-2.5 DESTRUCTIVE floor, which no rung can
  // widen — so an agent removing a member ALWAYS proposes, by construction.
  //
  // WHAT APPROVAL USED TO DO: nothing that lands. `workspaceMember` is not in
  // the materializer's subject switch, so the `*​/*` catch-all's honesty gate
  // throws NOT_IMPLEMENTED today (it is one of the two doors that gate's own
  // test names). That throw is HONEST but it is still an unusable door: the
  // reviewer can never apply the change. These executors make it apply.
  //
  // PAYLOAD (verified at the gate, not assumed — this is the `gate stored only
  // {id}` check): all three gates in `routers/workspaces/invites.ts` store the
  // FULL argument set —
  //   add        (invites.ts:77)  → { workspaceId, targetUserId, role }
  //   remove     (invites.ts:219) → { workspaceId, targetUserId }
  //   updateRole (invites.ts:339) → { workspaceId, targetUserId, newRole }
  // — which is exactly the input each procedure takes. Nothing is lost.
  //
  // ⚠️ targetId IS NOT THE SUBJECT. None of these gates stamps `data.id`, and
  // `permission-check.ts` falls back to `randomUUID()` for `targetId` when
  // `data.id` is absent. So `proposal.targetId` is a RANDOM uuid here, and
  // reading it as the member id — the reflex every sibling executor above
  // uses — would act on nobody. Deliberately NOT read (same shape as
  // `playbook/run`, whose gate keys on `playbookId`).
  //
  // SECOND EFFECTS: each direct path is more than its membership row —
  // `add` also runs the team-person bridge and provisions the agent thread,
  // group channel and proactive feed; `remove` detaches the team-member facet;
  // `updateRole` fans pod-admin promotion out into every pod-visible workspace.
  // None of that is reconstructable from the payload (it is re-derived at
  // execution time), which is precisely why all three replay through the
  // ROUTER door rather than writing `workspace_members` here.
  //
  // IDENTITY: acts as the APPROVER. The procedures re-enter
  // `checkPermissionOrPropose`, whose RBAC reads the CALLER's workspace role,
  // so replaying as the approver keeps the authorization floor intact; an
  // approver who lacks the right role gets a loud re-propose that
  // `assertApplied` converts into FORBIDDEN, never a silent no-op.

  /**
   * Shared prologue for the three membership doors: read the payload (nested
   * + flat, never `targetId`), short-circuit an already-approved row, resolve
   * the approver's membership, and build the caller.
   *
   * ONE helper rather than three copies, because the three bodies differ only
   * in the procedure they call — and a copy is how `playbook/archive` and
   * `playbook/update` drifted apart inside one file.
   */
  async function prepareMembershipReplay(
    proposal: { data: unknown; workspaceId: string | null },
    userId: string,
    proposalId: string
  ): Promise<
    | { done: true }
    | {
        done: false;
        workspaceId: string;
        targetUserId: string;
        inner: Record<string, unknown>;
        raw: Record<string, unknown>;
        caller: ReturnType<
          (typeof import("../../workspaces.js"))["workspacesRouter"]["createCaller"]
        >;
      }
  > {
    const raw = (proposal.data ?? {}) as Record<string, unknown>;
    const inner = (raw.data ?? {}) as Record<string, unknown>;
    const targetUserId =
      (inner.targetUserId as string | undefined) ??
      (raw.targetUserId as string | undefined);
    const workspaceId =
      (inner.workspaceId as string | undefined) ??
      (raw.workspaceId as string | undefined) ??
      proposal.workspaceId ??
      undefined;
    if (!targetUserId || !workspaceId) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message:
          "Membership proposal is missing the target user or workspace — " +
          "it cannot be applied.",
      });
    }

    // Idempotency: approve is not status-guarded before dispatch.
    const [alreadyDone] = await db
      .select({ status: proposals.status })
      .from(proposals)
      .where(eq(proposals.id, proposalId));
    if (alreadyDone?.status === ProposalStatus.APPROVED) {
      return { done: true };
    }

    const membership = await getWorkspaceMembership(db, workspaceId, userId);
    if (!membership) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "No workspace access",
      });
    }

    const { workspacesRouter } = await import("../../workspaces.js");
    const caller = workspacesRouter.createCaller({
      db,
      authenticated: true as const,
      userId,
      workspaceId,
      workspaceRole: membership.role,
    } as unknown as Context);

    return { done: false, workspaceId, targetUserId, inner, raw, caller };
  }

  /** Shared epilogue — the status flip + the telemetry pair, verbatim. */
  async function closeMembershipApproval(
    proposal: { workspaceId: string | null; targetType: string },
    userId: string,
    input: { proposalId: string },
    deps: Parameters<
      Parameters<typeof registerProposalExecutor>[0]["execute"]
    >[0]["deps"],
    proposalRow: Parameters<
      Parameters<typeof registerProposalExecutor>[0]["execute"]
    >[0]["proposal"]
  ): Promise<void> {
    await db
      .update(proposals)
      .set({
        status: ProposalStatus.APPROVED,
        reviewedBy: userId,
        reviewedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(proposals.id, input.proposalId));

    reportApproved(deps, proposalRow, input.proposalId);

    deps.emitProposalReviewed(
      input.proposalId,
      proposal.workspaceId,
      "approved",
      userId
    );
  }

  registerProposalExecutor({
    key: "workspaceMember/add",
    async execute({ proposal, userId, input, deps }) {
      const prep = await prepareMembershipReplay(
        proposal,
        userId,
        input.proposalId
      );
      if (prep.done) return { success: true, alreadyApproved: true };

      // `role` is the gate's own field name for add (contrast `newRole` on
      // updateRole). No default: a missing role would silently seat the member
      // at whatever the schema picks, which is an authorization decision the
      // reviewer never made.
      const role =
        (prep.inner.role as string | undefined) ??
        (prep.raw.role as string | undefined);
      if (role !== "owner" && role !== "editor" && role !== "viewer") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Membership proposal does not name a valid role — refusing to " +
            "seat a member at an unreviewed access level.",
        });
      }

      // The replay must APPLY, never re-propose — see `assertApplied`.
      assertApplied(
        await prep.caller.addMember({
          workspaceId: prep.workspaceId,
          userId: prep.targetUserId,
          role,
        })
      );

      await closeMembershipApproval(proposal, userId, input, deps, proposal);
      return { success: true };
    },
  });

  registerProposalExecutor({
    key: "workspaceMember/remove",
    async execute({ proposal, userId, input, deps }) {
      const prep = await prepareMembershipReplay(
        proposal,
        userId,
        input.proposalId
      );
      if (prep.done) return { success: true, alreadyApproved: true };

      // The replay must APPLY, never re-propose — see `assertApplied`.
      assertApplied(
        await prep.caller.removeMember({
          workspaceId: prep.workspaceId,
          userId: prep.targetUserId,
        })
      );

      await closeMembershipApproval(proposal, userId, input, deps, proposal);
      return { success: true };
    },
  });

  registerProposalExecutor({
    key: "workspaceMember/updateRole",
    async execute({ proposal, userId, input, deps }) {
      const prep = await prepareMembershipReplay(
        proposal,
        userId,
        input.proposalId
      );
      if (prep.done) return { success: true, alreadyApproved: true };

      // ⚠️ The gate stores `newRole`, NOT `role` — a different field name from
      // `workspaceMember/add` in the SAME domain. Reading `role` here would
      // read undefined and refuse every proposal.
      //
      // The procedure's own enum is admin|editor|viewer (it does NOT accept
      // "owner"), so the guard mirrors that exactly rather than the add door's.
      const newRole =
        (prep.inner.newRole as string | undefined) ??
        (prep.raw.newRole as string | undefined);
      if (newRole !== "admin" && newRole !== "editor" && newRole !== "viewer") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Membership proposal does not name a valid role — refusing to " +
            "change a member's access level to an unreviewed value.",
        });
      }

      // The replay must APPLY, never re-propose — see `assertApplied`.
      assertApplied(
        await prep.caller.updateMemberRole({
          workspaceId: prep.workspaceId,
          userId: prep.targetUserId,
          role: newRole,
        })
      );

      await closeMembershipApproval(proposal, userId, input, deps, proposal);
      return { success: true };
    },
  });
}
