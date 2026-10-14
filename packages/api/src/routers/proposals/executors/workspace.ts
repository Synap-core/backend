import { unfilteredAiFanoutError } from "@synap-core/types/automations";
import { TRPCError } from "@trpc/server";
import {
  db,
  drizzleSql,
  proposals,
  eq,
  getWorkspaceMembership,
  users,
  workspaceMembers,
  workspaces,
} from "@synap/database";
import { readDeferredWrites } from "@synap-core/types/proposals/deferred-writes";
import { ProposalStatus } from "@synap/database/schema";
import { createLogger } from "@synap-core/core";
import { auditLog } from "../../../utils/audit-log.js";
import { workspaceRuntimePrimarySurfaceSchema } from "../../../schemas/workspace-primary-surface.js";
import {
  registerProposalExecutor,
  type ProposalExecutorArgs,
} from "../execution-registry.js";
import { assertApplied, reportApproved } from "./shared.js";
import type { Context } from "../../../context.js";

const logger = createLogger({ module: "proposal-approve-executors-workspace" });

/**
 * Approve a template apply (`source: "packages.apply"`, or any gated
 * create-from-definition): the ONE template apply (`applyTemplate`) the Hub
 * `/packages/apply` door runs — a FRESH create, or the space already holding
 * the template re-synced — then layer 2, then the version stamp, only if
 * layer 2 converged. This executor is the governance (a person approved);
 * the apply is the module's.
 *
 * Shared by `workspace/create` and by `workspace/update` for a template UPDATE
 * of an existing space (the honest shape the apply door files when the slug is
 * already installed) — one body, so the two can never diverge.
 */
async function executeTemplateApplyApproval({
  proposal,
  userId,
  input,
  deps,
}: ProposalExecutorArgs) {
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

  const { applyTemplate } =
    await import("../../../services/template-apply/index.js");

  // Template identity (0308): a template proposal installs under its slug
  // (installed once per pod). Falling back to the proposal ROW id as the
  // key matched nothing and minted a second, empty space beside the real
  // one (incident 2026-10-06: a catalog definition with no `_meta.slug`).
  // A template proposal with neither a slug nor an explicit key is refused;
  // only a freehand create may still key on its proposal id.
  const innerDefinition = (inner.definition ?? {}) as Record<
    string,
    unknown
  > & { _meta?: { slug?: unknown } };
  const metaSlug = innerDefinition._meta?.slug;
  const packageSlug =
    (inner.packageSlug as string | undefined) ??
    (typeof metaSlug === "string" && metaSlug.trim()
      ? metaSlug.trim()
      : undefined);
  const explicitKey = inner.proposalId as string | undefined;
  const isTemplateProposal = !!(
    packageSlug ||
    inner.templateId ||
    innerDefinition._meta ||
    inner.source === "packages.apply"
  );
  if (isTemplateProposal && !packageSlug && !explicitKey) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "This template proposal carries no package slug and no idempotency key, so approving it would create a duplicate space. Re-submit it with the catalog slug (`_meta.slug`).",
    });
  }

  // The ONE template apply, as the APPROVER: a fresh create, or the space
  // already holding the template re-synced (layer 1 from the catalog's fresh
  // copy, layer 2 from the same source), then the stamp — only if layer 2
  // converged. A layer-2 failure is recorded on the space and reported below,
  // never thrown: the space is in place.
  const applied = await approveTemplateApply(() =>
    applyTemplate({
      definition:
        innerDefinition as unknown as import("@synap/database").WorkspaceDefinitionInput,
      layerTwoBody:
        innerDefinition as unknown as ApplyTemplateInput["layerTwoBody"],
      // Approver authority covers ONLY what the server resolved from the
      // catalog; the agent's own body keeps the agent's governance (an
      // automation lands as a draft, a floored write proposes). The agent is
      // enrolled either way, so its follow-on writes don't collapse to joins.
      actor: {
        userId,
        agentUserId: proposal.agentUserId ?? undefined,
        approved: true,
        scopes: [],
      },
      source: "approve:workspace/create",
      alwaysRunLayerTwo: inner.source === "packages.apply",
      identity: {
        packageSlug,
        // The version the apply door stamped onto the proposal — the FALLBACK
        // for a private template the pod's catalog cache cannot resolve.
        packageVersion: inner.packageVersion as string | undefined,
        proposalId:
          explicitKey ??
          (isTemplateProposal ? packageSlug : undefined) ??
          input.proposalId,
        workspaceName: (inner.workspaceName as string | undefined) ?? name,
        templateId: inner.templateId as string | undefined,
        workspaceType: inner.workspaceType as
          "personal" | "agent" | "project" | "operational" | undefined,
        createdBy:
          (inner.createdBy as "user" | "provisioning" | "plugin" | undefined) ??
          "provisioning",
      },
    })
  );
  const workspaceId = applied.workspaceId;

  // Stamp the produced workspaceId onto the proposal row so clients/revert
  // can recover it (ProposalMaterializedRecord has no workspaceIds field —
  // store as a sibling lifecycle key next to materialized).
  await markApproved(proposal, input.proposalId, userId, applied);
  const refusals = layerTwoRefusals(applied, input.proposalId);

  // Report to IS telemetry (fire-and-forget — never blocks)
  reportApproved(deps, proposal, input.proposalId);

  deps.emitProposalReviewed(
    input.proposalId,
    proposal.workspaceId,
    "approved",
    userId
  );
  return {
    success: true,
    primaryId: workspaceId,
    ...(applied.pendingVersionStamp
      ? { versionStamped: applied.finished?.versionStamped ?? false }
      : {}),
    ...(refusals.length > 0 ? { refusals } : {}),
  };
}

type ApplyTemplateInput =
  import("../../../services/template-apply/index.js").ApplyTemplateInput;

type TemplateApplyResult = Awaited<
  ReturnType<
    (typeof import("../../../services/template-apply/index.js"))["applyTemplate"]
  >
>;

/** Run an approved apply; map its layer-1 errors to the executor's codes. */
async function approveTemplateApply(
  run: () => Promise<TemplateApplyResult>
): Promise<TemplateApplyResult> {
  const {
    ComposeBaseUnavailableError,
    DependencyResolutionError,
    ComposeBaseNotFoundError,
    ComposeOverlayError,
  } = await import("../../../services/workspace-materialization-service.js");
  try {
    return await run();
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
      throw new TRPCError({ code: "NOT_FOUND", message: (e as Error).message });
    }
    throw e;
  }
}

/** Mark the proposal APPROVED with the space it materialized. */
async function markApproved(
  proposal: ProposalExecutorArgs["proposal"],
  proposalId: string,
  userId: string,
  applied: TemplateApplyResult
): Promise<void> {
  await db
    .update(proposals)
    .set({
      status: ProposalStatus.APPROVED,
      data: {
        ...((proposal.data as Record<string, unknown> | null | undefined) ??
          {}),
        materializedWorkspaceId: applied.workspaceId,
        materializeStatus: applied.materializeStatus,
      },
      reviewedBy: userId,
      reviewedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(proposals.id, proposalId));
}

/**
 * What the reviewer is told when the approved apply did not finish: layer 2
 * failed (recorded on the space; `synap templates update` finishes it), or it
 * did not converge (the version is not stamped, so the next update re-applies).
 */
function layerTwoRefusals(
  applied: TemplateApplyResult,
  proposalId: string
): string[] {
  if (applied.layer2.status === "failed") {
    const err = applied.layer2.error;
    // The raw cause goes to the operator log only (it can carry internals).
    logger.warn(
      { proposalId, err: err instanceof Error ? err.message : String(err) },
      "template apply approved: package layers failed post-workspace — recorded on the space"
    );
    return [
      "The space is in place, but applying its package layers failed. Run `synap templates update` to finish it.",
    ];
  }
  if (applied.pendingVersionStamp && !applied.finished?.versionStamped) {
    logger.warn(
      {
        proposalId,
        workspaceId: applied.workspaceId,
        version: applied.pendingVersionStamp,
        state: applied.finished?.state,
      },
      "template apply approved, but its package layers did not all land — version not stamped, so the next update re-applies"
    );
  }
  return [];
}

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
    execute: executeTemplateApplyApproval,
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

      const agentUserId =
        proposal.agentUserId ??
        (typeof joinData.agentUserId === "string"
          ? joinData.agentUserId
          : null);
      const role =
        joinData.role === "owner" ||
        joinData.role === "editor" ||
        joinData.role === "viewer"
          ? joinData.role
          : "editor";
      // Defence-in-depth, the materializer's rule: a join only ever makes an
      // AGENT user row a member.
      const [agentRow] = agentUserId
        ? await db
            .select({ userType: users.userType })
            .from(users)
            .where(eq(users.id, agentUserId))
        : [];
      if (
        !targetWorkspaceId ||
        !agentUserId ||
        agentRow?.userType !== "agent"
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "This join request names no agent to add (or its requester is not " +
            "an agent), so no membership can be granted — reject it.",
        });
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

      // MEMBERSHIP IS SYNCHRONOUS (#6): the row lands in the SAME transaction
      // as the APPROVED flip, so the moment the join reads approved the agent
      // IS a member — the deferred writes below replay against it. The
      // materializer still receives `workspace.join.validated` and finds the
      // row already there (its existing idempotent skip); it is the backstop
      // for any other route into that insert, no longer the writer.
      const { rows: inserted, approved } = await db.transaction(async (tx) => {
        const rows = await tx
          .insert(workspaceMembers)
          .values({ workspaceId: targetWorkspaceId, userId: agentUserId, role })
          .onConflictDoNothing()
          .returning({ id: workspaceMembers.id });
        const [approved] = await tx
          .update(proposals)
          .set({
            status: ProposalStatus.APPROVED,
            // MERGED into the row, never the copy read above: a write kept
            // (or an item the reviewer dropped) since then must survive.
            ...(validatedEvent
              ? {
                  data: drizzleSql`coalesce(${proposals.data}, '{}'::jsonb) || jsonb_build_object('validatedEventId', ${validatedEvent.id}::text)`,
                }
              : {}),
            reviewedBy: userId,
            reviewedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(proposals.id, input.proposalId))
          .returning({ data: proposals.data });
        return { rows, approved };
      });

      // Report to IS telemetry (fire-and-forget — never blocks)
      reportApproved(deps, proposal, input.proposalId);

      deps.emitProposalReviewed(
        input.proposalId,
        proposal.workspaceId,
        "approved",
        userId
      );

      // Replay the writes the agent made while it waited, AS THE AGENT, each
      // through its own door — the ladder decides each one again (access was
      // approved here, content was not). Outcomes land on the join row.
      // Read from the row as approved: a write kept after this executor read
      // the proposal is in it too.
      if (readDeferredWrites(approved?.data).writes.length > 0) {
        const { replayDeferredWrites } =
          await import("../../../services/governance/deferred-writes.js");
        await replayDeferredWrites({
          proposalId: input.proposalId,
          workspaceId: targetWorkspaceId,
        });
      }

      return {
        success: true,
        // The storage engine's own answer: 1 = the agent became a member now,
        // 0 = it already was (the conflict was the row).
        effect: {
          applied: "verified",
          rows: inserted.length,
          ids: inserted.map((r) => r.id),
          subject: "workspace_members",
        },
      };
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
  // additive reconcile never ran. Runs the ONE template apply (`applyTemplate`,
  // targetWorkspaceId forces the compose branch) the grant path drives, from
  // the FULL package body the route stores as `data.definition`, as the
  // APPROVER (mirrors workspace/create's approve-as-authority above).
  registerProposalExecutor({
    key: "workspace/update",
    async execute(args) {
      const { proposal, payload, userId, input, deps } = args;
      void payload;
      const inner = ((proposal.data as Record<string, unknown>)?.data ??
        proposal.data ??
        {}) as Record<string, unknown>;

      // A template UPDATE of the space that already holds the template (Hub
      // `/packages/apply` with no `targetWorkspaceId`, slug already installed).
      // Filed as an update of THAT space so the reviewer reads what it is, and
      // approved through the very body `workspace/create` runs: the slug keys
      // the idempotent re-hit, layer 1 reconciles, layer 2 applies, then the
      // stamp. Never the `targetWorkspaceId` compose branch below — that one
      // OVERLAYS a package onto a foreign space.
      if (
        inner.source === "packages.apply" &&
        inner.operation === "template_update" &&
        inner.targetWorkspaceId === undefined
      ) {
        return executeTemplateApplyApproval(args);
      }
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

      // `workspacesRouter.update` shape — `{ id, name, description, settings }`,
      // no `definition`, no `operation`. This is the RENAME / settings door
      // (MCP `synap_update_workspace`, Hub `PATCH /workspaces/:id`); it lands
      // under the SAME key as a package install onto a workspace. Before this
      // branch, approving one fell through to `materializeWorkspaceCore` with an
      // empty definition and renamed nothing. REPLAY through the router as the
      // APPROVER, so settings stripping / server-owned preservation / audit /
      // side-effects all run exactly as on the direct path.
      if (
        inner.definition === undefined &&
        inner.operation === undefined &&
        typeof inner.id === "string"
      ) {
        // LEGACY SHAPE: a bare `{ id }` names nothing to change. Before
        // edec5fa4, `workspaces.setIntelligenceService` filed exactly this
        // (the chosen service was never recorded), and the reconcile door in
        // `definition-engine.ts` still files it when a non-admin is refused.
        // Replaying it renamed nothing yet flipped the row APPROVED — a
        // silent no-op that read as "done". Refuse it, classified as stale
        // (PRECONDITION_FAILED, never BAD_REQUEST: the reviewer did nothing
        // wrong), BEFORE the row is touched, so it stays pending to reject.
        if (
          inner.name === undefined &&
          inner.description === undefined &&
          inner.settings === undefined
        ) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message:
              "This request was filed by an earlier version and does not say what to change, so approving it would do nothing. Reject it and make the change again.",
          });
        }
        const membership = await getWorkspaceMembership(db, inner.id, userId);
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
          workspaceId: inner.id,
          workspaceRole: membership.role,
        } as unknown as Context);
        assertApplied(
          await workspaceCaller.update({
            id: inner.id,
            ...(typeof inner.name === "string" ? { name: inner.name } : {}),
            ...(typeof inner.description === "string"
              ? { description: inner.description }
              : {}),
            ...(inner.settings && typeof inner.settings === "object"
              ? { settings: inner.settings as Record<string, unknown> }
              : {}),
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
        return { success: true, primaryId: inner.id };
      }

      // The NARROW brief door (`services/space-brief-door.ts`). Replays the
      // PATCH against the brief as it is NOW (compare-and-set), never the
      // `brief.after` snapshot the reviewer saw — a field someone changed
      // since the proposal was filed and the patch does not name survives.
      if (inner.operation === "update_brief") {
        const membership = await getWorkspaceMembership(
          db,
          targetWorkspaceId,
          userId
        );
        if (!membership) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "No workspace access",
          });
        }
        const { spaceBriefPatchSchema, applySpaceBriefPatchNow } =
          await import("../../../services/space-brief-door.js");
        const patch = spaceBriefPatchSchema.safeParse(inner.patch);
        if (!patch.success) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Space brief proposal carries an invalid patch",
          });
        }
        await applySpaceBriefPatchNow(targetWorkspaceId, patch.data, userId);

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

      // Retire-into (`services/workspace-retire-into.ts`): move a space off a
      // retired template. RE-PLANS against the data as it is now and runs the
      // install / move / archive-if-empty doors as the APPROVER — the plan on
      // the proposal is what the reviewer saw, never what is replayed.
      if (inner.operation === "retire_into") {
        const sourceId =
          typeof inner.id === "string" ? inner.id : targetWorkspaceId;
        const { applyRetireInto } =
          await import("../../../services/workspace-retire-into.js");
        const { result } = await applyRetireInto({
          workspaceId: sourceId,
          userId,
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

        reportApproved(deps, proposal, input.proposalId);
        deps.emitProposalReviewed(
          input.proposalId,
          proposal.workspaceId,
          "approved",
          userId
        );
        // The source is kept when anything is left in it (by contract), and
        // a per-entity move can fail: both are told to the reviewer.
        const refusals = [
          ...(result.keptBecause
            ? [`The old space was kept: ${result.keptBecause}`]
            : []),
          ...result.failed.map(
            (f) => `Item ${f.entityId} was not moved: ${f.error}`
          ),
        ];
        return {
          success: true,
          primaryId: result.targetWorkspaceId,
          ...(refusals.length > 0 ? { refusals } : {}),
        };
      }

      // `workspaces.setIntelligenceService` — pin a space to a service, or
      // `null` = remove the pin (follow the pod default). REPLAYED through the
      // procedure as the APPROVER, so the owner/admin floor, the active-service
      // check and the null-removes-the-key write all run exactly as on the
      // direct path (never a reconstructed settings patch).
      if (inner.operation === "set_intelligence_service") {
        const serviceId = inner.intelligenceServiceId;
        if (
          !Object.prototype.hasOwnProperty.call(
            inner,
            "intelligenceServiceId"
          ) ||
          (serviceId !== null && typeof serviceId !== "string")
        ) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              "Intelligence service proposal is missing the chosen service",
          });
        }
        const membership = await getWorkspaceMembership(
          db,
          targetWorkspaceId,
          userId
        );
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
          workspaceId: targetWorkspaceId,
          workspaceRole: membership.role,
        } as unknown as Context);
        assertApplied(
          await workspaceCaller.setIntelligenceService({
            workspaceId: targetWorkspaceId,
            serviceId,
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
        return { success: true, primaryId: targetWorkspaceId };
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

      // Install ONTO this space (compose): the ONE template apply, as the
      // APPROVER — the additive reconcile, the same layer 2, then the
      // `--onto` identity's stamp / the pack's version, only on convergence.
      const definition = (inner.definition ?? {}) as Record<string, unknown>;
      const { applyTemplate } =
        await import("../../../services/template-apply/index.js");
      const applied = await approveTemplateApply(() =>
        applyTemplate({
          definition:
            definition as unknown as import("@synap/database").WorkspaceDefinitionInput,
          layerTwoBody: definition,
          actor: {
            userId,
            agentUserId: proposal.agentUserId ?? undefined,
            approved: true,
            scopes: [],
          },
          source: "approve:workspace/update",
          targetWorkspaceId,
          alwaysRunLayerTwo: true,
          identity: {
            packageSlug: inner.packageSlug as string | undefined,
            packageVersion: inner.packageVersion as string | undefined,
            proposalId:
              (inner.proposalId as string | undefined) ?? input.proposalId,
            workspaceName: inner.workspaceName as string | undefined,
            templateId: inner.templateId as string | undefined,
            workspaceType: inner.workspaceType as
              "personal" | "agent" | "project" | "operational" | undefined,
          },
        })
      );
      const workspaceId = applied.workspaceId;
      await markApproved(proposal, input.proposalId, userId, applied);
      const refusals = layerTwoRefusals(applied, input.proposalId);

      // Report to IS telemetry (fire-and-forget — never blocks)
      reportApproved(deps, proposal, input.proposalId);

      deps.emitProposalReviewed(
        input.proposalId,
        proposal.workspaceId,
        "approved",
        userId
      );
      return {
        success: true,
        primaryId: workspaceId,
        ...(refusals.length > 0 ? { refusals } : {}),
      };
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
        writeTemplateState,
      } = await import("@synap/database");

      const dbConn = await getDb();
      // Approver is the authority — same as workspace/create above. The
      // identity is the template state's `slug` (the ONE writer).
      await writeTemplateState(
        dbConn,
        workspaceId,
        { slug: templateSlug },
        { userId }
      );
      const workspaceRepo = new WorkspaceRepository(dbConn, eventRepository);
      await workspaceRepo.mergeSettings(
        workspaceId,
        { proposalId: templateSlug },
        userId
      );

      const report = await reconcileWorkspaceFromDefinition({
        validateFlow: unfilteredAiFanoutError,
        workspaceId,
        userId,
        definition: resolved.workspaceDefinition as unknown as Parameters<
          typeof reconcileWorkspaceFromDefinition
        >[0]["definition"],
        mergeCapabilities: true,
      });
      // Adopt binds the identity and reconciles layer 1 only: the version is
      // NOT earned here. The finisher records "layer-2-not-run", health reads
      // the space drifted, and `synap templates update` applies the rest and
      // stamps it.
      const { finishTemplateApply } =
        await import("../../../services/template-apply-finisher.js");
      await finishTemplateApply({
        workspaceId,
        userId,
        built: false,
        pendingVersionStamp: resolved.version ?? undefined,
        post: null,
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

  // ── workspace / archive + workspace / restore ─────────────────────────────
  // Filed by `workspacesRouter.archive` (R8a). The gate passes the PLURAL
  // `workspaces`; the stored key is singularized (see workspace/delete above),
  // so `workspace/archive` / `workspace/restore` are the keys approval resolves.
  //
  // `archive` sits on the rung-2.5 DESTRUCTIVE floor and `restore` on the
  // rung-2 ADMIN floor, so an agent ALWAYS proposes. With no executor the
  // catch-all would flip it APPROVED and archive nothing.
  //
  // PAYLOAD: `data: { id, name }` (nested as `data.data`) — the ACTION key
  // says archive vs restore; no payload flag (P1: it rendered as a stray row);
  // `proposal.targetId` holds the same id.
  //
  // REPLAY, never reconstruct: through `workspacesRouter.archive` as the
  // APPROVER, so the owner/pod-admin floor, the system-workspace refusal, the
  // automation pause and the audit row all run exactly as on the direct path.
  // The re-entrant gate grants the human approver; `assertApplied` refuses a
  // re-proposal instead of flipping APPROVED with nothing done.
  for (const action of ["archive", "restore"] as const) {
    registerProposalExecutor({
      key: `workspace/${action}`,
      async execute({ proposal, userId, input, deps }) {
        const raw = (proposal.data ?? {}) as Record<string, unknown>;
        const inner = (raw.data ?? raw) as Record<string, unknown>;
        const workspaceId =
          (inner.id as string | undefined) ?? proposal.targetId ?? undefined;
        if (!workspaceId) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Workspace ${action} proposal is missing the workspace id`,
          });
        }

        const [alreadyDone] = await db
          .select({ status: proposals.status })
          .from(proposals)
          .where(eq(proposals.id, input.proposalId));
        if (alreadyDone?.status === ProposalStatus.APPROVED) {
          return { success: true, alreadyApproved: true };
        }

        const membership = await getWorkspaceMembership(
          db,
          workspaceId,
          userId
        );
        const { workspacesRouter } = await import("../../workspaces.js");
        const workspaceCaller = workspacesRouter.createCaller({
          db,
          authenticated: true as const,
          userId,
          workspaceId,
          workspaceRole: membership?.role ?? null,
        } as unknown as Context);

        const result = await workspaceCaller.archive({
          workspaceId,
          restore: action === "restore",
        });
        assertApplied(result);

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
        return { success: true, primaryId: workspaceId };
      },
    });
  }

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

  // ── apiKey / create ──────────────────────────────────────────────────────
  // Same home as `apiKey/delete` above (no `executors/api-key.ts`, and the
  // aggregator is off-limits). Severed since it was seeded — an approved
  // `apiKey/create` hit the `*​/*` catch-all, which flips the row APPROVED and
  // returns success while NO KEY IS MINTED. The reviewer reads "granted" and
  // the app that asked holds nothing.
  //
  // WHY IT PROPOSES: `apiKey.create` is in the credential-shaped class that no
  // governance rung widens, so an agent-authored mint ALWAYS proposes.
  //
  // PAYLOAD: `data: { id, keyName, scope, hubId?, expiresInDays? }` — nested by
  // the request-shaped envelope as `data.data.*`. The gate used to store only
  // `{ id, keyName }`; `scope` is REQUIRED by `apiKeys.create`, so the replay
  // was not merely lossy, it was impossible. Widened at the gate
  // (routers/api-keys.ts) rather than guessed here: a mint whose scope the
  // executor invented would grant authority the reviewer never saw.
  //
  // ⚠️ `proposal.targetId` is a PHANTOM here and is deliberately NOT read: the
  // router mints `const id = randomUUID()` for the gate, then
  // `ApiKeyRepository.create` generates the row's OWN id. The two are never the
  // same, so passing targetId anywhere would name a key that does not exist.
  // (Same shape as `playbook/run`'s `readsTargetId: false`.)
  //
  // ⚠️ FIDELITY LOSS (stated, not hidden): `apiKeys.create` returns the
  // plaintext key ONCE, to its caller. On this path the caller is the approval
  // dispatcher and `ProposalExecutorResult` has no field for a secret — so the
  // key material is discarded. The key EXISTS and is listed/revocable; nobody
  // ever sees its bearer string. Delivering it is a separate design question
  // (it must not land in `proposals.data`, which is readable), so it is named
  // here rather than solved with a storage shortcut.
  //
  // SECOND EFFECT: replayed through `apiKeysRouter.create`, which owns the
  // bcrypt hashing + `auditLog` + `emitSideEffects` — never a hand-written
  // insert, which would drop the last two.
  //
  // IDENTITY: acts as the APPROVER, so the key belongs to the reviewer who
  // granted it — the same rule `apiKey/delete` states, and the only one that
  // cannot mint a credential into someone else's account.
  registerProposalExecutor({
    key: "apiKey/create",
    async execute({ proposal, userId, input, deps }) {
      const raw = (proposal.data ?? {}) as Record<string, unknown>;
      const inner = (raw.data ?? {}) as Record<string, unknown>;
      const keyName =
        (inner.keyName as string | undefined) ??
        (raw.keyName as string | undefined);
      const scopeRaw = inner.scope ?? raw.scope;
      const scope = Array.isArray(scopeRaw)
        ? scopeRaw.filter((s): s is string => typeof s === "string")
        : [];
      if (!keyName) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "API key create proposal is missing the key name",
        });
      }
      if (scope.length === 0) {
        // A proposal filed BEFORE the gate carried `scope` (or by a door that
        // still does not). Refusing is the only honest answer — minting with a
        // guessed scope grants authority nobody reviewed.
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "API key create proposal carries no scope, so the key it asked for cannot be minted. File the request again.",
        });
      }

      // Idempotency: approve is not status-guarded before dispatch, and create
      // is NOT idempotent — a double-click would mint a second live credential.
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

      const hubId = (inner.hubId ?? raw.hubId) as string | undefined;
      // `null` = never (explicit) and must survive the replay; only an ABSENT
      // value falls back to the door's 90-day default.
      const expiresInDays = (
        "expiresInDays" in inner ? inner.expiresInDays : raw.expiresInDays
      ) as number | null | undefined;
      // The grant the requester asked for — replayed verbatim. A proposal
      // filed before a grant was required carries none: refuse, like a
      // missing scope — guessing one grants access nobody reviewed (P5).
      const grant = (inner.grant ?? raw.grant) as
        { permissions: string[] } | undefined;
      if (!grant) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "API key create proposal carries no access (grant), so the key it asked for cannot be minted. File the request again.",
        });
      }

      // The replay must APPLY, never re-propose — see `assertApplied`.
      const minted = await apiKeyCaller.create({
        keyName,
        scope,
        ...(hubId ? { hubId } : {}),
        ...(expiresInDays !== undefined ? { expiresInDays } : {}),
        grant,
        ...(keyWorkspaceId ? { workspaceId: keyWorkspaceId } : {}),
      });
      assertApplied(minted);

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
      return { success: true, primaryId: minted.id };
    },
  });

  // ── apiKey / update ──────────────────────────────────────────────────────
  // ⚠️ The GATE is inside `apiKeys.rotate` (routers/api-keys.ts) but it
  // declares `action: "update"`, so the stored key is `apiKey/update` while the
  // door to replay is `rotate` — the same gate-says-X/door-is-Y shape as
  // `apiKey/delete` above. Severed since it was seeded: approving flipped the
  // row APPROVED while the compromised key STAYED LIVE and no replacement was
  // ever minted, which is the same false-green as an unapplied revoke.
  //
  // PAYLOAD: FLAT `data: { id }` — the gate stamps `id: input.keyId` (nested as
  // `data.data.id`); `proposal.targetId` holds the same id. Rotate needs
  // nothing else, so unlike `create` this door lost nothing at the gate.
  //
  // ⚠️ FIDELITY LOSS: as with `create`, the new plaintext key is returned ONCE
  // to the caller and the caller here is the dispatcher, so the bearer string
  // is discarded. The OLD key is revoked either way — the security half of
  // rotate is complete.
  //
  // SECOND EFFECT: `ApiKeyRepository.rotate` (mint + revoke old, one door) plus
  // `auditLog` and `emitSideEffects`, all replayed through `apiKeysRouter`.
  //
  // IDENTITY: acts as the APPROVER. `rotate` answers NOT_FOUND when
  // `oldKey.userId !== ctx.userId`, so a non-owner approver gets a loud refusal
  // instead of silently rotating someone else's credential — the rule
  // `apiKey/delete` states, for the same reason.
  registerProposalExecutor({
    key: "apiKey/update",
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
          message: "API key rotate proposal is missing the key id",
        });
      }

      // Idempotency: rotate is NOT idempotent — re-running it revokes the key
      // the first approval just minted and issues a third.
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
      const rotated = await apiKeyCaller.rotate({
        keyId,
        ...(keyWorkspaceId ? { workspaceId: keyWorkspaceId } : {}),
      });
      assertApplied(rotated);

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
      return { success: true, primaryId: rotated.id };
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
