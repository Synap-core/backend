/**
 * Hub Protocol - Entities Router
 *
 * Thin wrapper around regular API endpoints.
 * Uses API key authentication but calls regular API internally
 * to ensure all operations go through the same event sourcing,
 * validation, security, and worker infrastructure.
 */

import { z } from "zod";
import { router } from "../../trpc.js";
import { scopedProcedure } from "../../middleware/api-key-auth.js";
import { entitiesRouter as regularEntitiesRouter } from "../entities.js";
import { createHubProtocolCallerContext } from "./utils.js";
import { db, workspaceMembers, eq } from "@synap/database";
import { emitChatEvent } from "../../utils/chat-realtime-broadcast.js";

export const entitiesRouter = router({
  /**
   * Get entities for user
   * Requires: hub-protocol.read scope
   *
   * Calls regular API's list endpoint internally
   */
  getEntities: scopedProcedure(["hub-protocol.read"])
    .input(
      z.object({
        userId: z.string(),
        workspaceId: z.string().uuid().optional(),
        /** Profile slug filter (canonical). */
        profileSlug: z.string().optional(),
        /**
         * @deprecated Same as profileSlug — legacy query param name from when
         * entities used a `type` field before profiles were slug-based.
         */
        type: z.string().optional(),
        limit: z.number().optional(),
        /**
         * Scoped-by-default (PRODUCT DECISION): with a workspaceId set, only that
         * workspace's entities are returned. Pass true to also include pod-wide
         * (workspaceId IS NULL) globals — the legacy behavior. Forwarded to the
         * regular `list` procedure.
         */
        includePodWide: z.boolean().optional(),
      })
    )
    .query(async ({ input, ctx }) => {
      const workspaceId =
        input.workspaceId ??
        ((ctx as Record<string, unknown>).workspaceId as string | null) ??
        null;
      // Use input.userId (the real user) not ctx.userId (the API key owner "system")
      const callerContext = await createHubProtocolCallerContext(
        input.userId,
        ctx.scopes || [],
        workspaceId
      );
      const caller = regularEntitiesRouter.createCaller(callerContext);

      const profileSlug = input.profileSlug ?? input.type;

      const result = await caller.list({
        profileSlug: profileSlug ?? undefined,
        limit: input.limit || 50,
        ...(input.includePodWide !== undefined
          ? { includePodWide: input.includePodWide }
          : {}),
      });

      return result.entities;
    }),

  /**
   * Create entity
   * Requires: hub-protocol.write scope
   *
   * Calls regular API's create endpoint internally
   */
  createEntity: scopedProcedure(["hub-protocol.write"])
    .input(
      z.object({
        userId: z.string(),
        // profileSlug is canonical; type is a deprecated alias accepted for backward compat
        profileSlug: z.string().optional(),
        type: z.string().optional(),
        title: z.string(),
        description: z.string().optional(),
        properties: z.record(z.string(), z.unknown()).optional(),
        agentUserId: z.string().uuid().optional(),
        /**
         * The proposing agent's own rationale for this action. Surfaced in the
         * proposal inbox so reviewers see *why* the agent acted, instead of the
         * generic "AI proposal requires review" fallback.
         */
        reasoning: z.string().optional(),
        /**
         * Provenance tag for AI-governance/auto-approve gating + downstream
         * audit trail. Defaults to `"agent"` when `agentUserId` is set,
         * otherwise `"intelligence"`. Connectors and integrations should
         * pass their own source so events carry the correct origin.
         */
        source: z
          .enum([
            "intelligence",
            "agent",
            "openwebui-pipeline",
            "openclaw",
            "extension",
            "cli",
            "n8n",
            "raycast",
          ])
          .optional(),
        aiMetadata: z
          .object({
            messageId: z.string().optional(),
            confidence: z.number().min(0).max(1).optional(),
            model: z.string().optional(),
            reasoning: z.string().optional(),
          })
          .optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Use the real user (input.userId), not ctx.userId (API key owner).
      //
      // workspaceProcedure (used by entities.create) requires a non-null workspaceId
      // for its auth gate. Pod-scoped profiles (bookmark, note, task, …) have no
      // workspace but still need the gate to pass — so we resolve the user's first
      // accessible workspace for auth purposes only. The mutation itself determines
      // the entity's actual workspaceId from the profile's entityScope (null for pod).
      let authWorkspaceId: string | undefined = ctx.workspaceId ?? undefined;
      if (!authWorkspaceId) {
        const rows = await db
          .select({ workspaceId: workspaceMembers.workspaceId })
          .from(workspaceMembers)
          .where(eq(workspaceMembers.userId, input.userId))
          .limit(1);
        authWorkspaceId = rows[0]?.workspaceId;
      }

      const callerContext = await createHubProtocolCallerContext(
        input.userId,
        ctx.scopes || [],
        authWorkspaceId,
        ctx.sourceMessageId ?? undefined,
        ctx.sessionId ?? undefined
      );
      const caller = regularEntitiesRouter.createCaller(callerContext);

      const result = await caller.create({
        profileSlug: input.profileSlug ?? input.type,
        title: input.title,
        description: input.description,
        properties: input.properties,
        // Agent's own rationale for the proposal inbox. Top-level `reasoning`
        // wins; fall back to the legacy `aiMetadata.reasoning` alias.
        reasoning: input.reasoning ?? input.aiMetadata?.reasoning,
        // Provenance: explicit `source` from caller wins; otherwise infer
        // "agent" when an agentUserId is present, else "intelligence".
        source: input.source ?? (input.agentUserId ? "agent" : "intelligence"),
        // Only pass agentUserId when explicitly provided — ctx.userId is the API key
        // owner ("system") which is not a valid UUID and would fail Zod validation.
        agentUserId: input.agentUserId,
      });
      // Emit session event so whiteboards in ambient mode can mirror new entities.
      if (result.status === "created" && result.id) {
        emitChatEvent({
          event: "ai:capture",
          data: {
            entityId: result.id,
            title: input.title,
            profileSlug: input.profileSlug ?? input.type ?? null,
          },
          userId: input.userId,
        });
      }

      return {
        status: result.status,
        message: result.message,
        id: result.id,
        proposalId: result.proposalId,
        // Echo the workspace lens we resolved for the caller — useful when
        // the request omitted workspaceId and we picked the user's first
        // accessible workspace, or when entityScope='pod' (workspaceId=null).
        workspaceId: authWorkspaceId ?? null,
      };
    }),

  /**
   * Update entity
   * Requires: hub-protocol.write scope
   *
   * Calls regular API's update endpoint internally
   */
  updateEntity: scopedProcedure(["hub-protocol.write"])
    .input(
      z.object({
        entityId: z.string().uuid(),
        userId: z.string(),
        title: z.string().optional(),
        preview: z.string().optional(),
        metadata: z.record(z.string(), z.any()).optional(),
        /** Keys to remove from the entity's properties object. Applied before `metadata` merge. */
        deleteProperties: z.array(z.string()).optional(),
        // agentUserId: the per-human agent user acting on behalf of userId.
        agentUserId: z.string().uuid().optional(),
        /** The proposing agent's own rationale, surfaced in the proposal inbox. */
        reasoning: z.string().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Use the real user (input.userId), not ctx.userId (API key owner)
      const callerContext = await createHubProtocolCallerContext(
        input.userId,
        ctx.scopes || [],
        ctx.workspaceId ?? undefined,
        ctx.sourceMessageId ?? undefined,
        ctx.sessionId ?? undefined
      );
      const caller = regularEntitiesRouter.createCaller(callerContext);

      const result = await caller.update({
        id: input.entityId,
        title: input.title,
        description: input.preview,
        properties: input.metadata,
        deleteProperties: input.deleteProperties,
        reasoning: input.reasoning,
        source: input.agentUserId ? "agent" : "intelligence",
        agentUserId: input.agentUserId,
      });

      if (result.status === "proposed" && result.proposalId) {
        const { buildProposalResponseFields } =
          await import("../../utils/permission-check.js");
        const envelope = buildProposalResponseFields({
          proposalId: result.proposalId,
          subjectType: "entity",
          action: "update",
          data: { id: input.entityId, title: input.title },
        });
        return {
          status: result.status,
          message: result.message,
          proposalId: result.proposalId,
          summary: envelope.summary,
          reasoning: envelope.reasoning,
          reviewPath: envelope.reviewPath,
          reviewUrl: envelope.reviewUrl,
        };
      }

      return {
        status: result.status,
        message: result.message,
        proposalId: result.proposalId,
      };
    }),

  /**
   * Delete an entity.
   * Requires: hub-protocol.write scope.
   *
   * Thin wrapper over the regular entities.delete procedure so governance
   * (proposal-gated for agents) and the event chain are inherited. Closes the
   * gap where the hub could create/read/update entities but not delete them.
   */
  deleteEntity: scopedProcedure(["hub-protocol.write"])
    .input(
      z.object({
        entityId: z.string().uuid(),
        userId: z.string(),
        // agentUserId: the per-human agent user acting on behalf of userId.
        agentUserId: z.string().uuid().optional(),
        /** The proposing agent's own rationale, surfaced in the proposal inbox. */
        reasoning: z.string().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Use the real user (input.userId), not ctx.userId (API key owner).
      const callerContext = await createHubProtocolCallerContext(
        input.userId,
        ctx.scopes || [],
        ctx.workspaceId ?? undefined,
        ctx.sourceMessageId ?? undefined,
        ctx.sessionId ?? undefined
      );
      const caller = regularEntitiesRouter.createCaller(callerContext);

      const result = await caller.delete({
        id: input.entityId,
        reasoning: input.reasoning,
        source: input.agentUserId ? "agent" : "intelligence",
        agentUserId: input.agentUserId,
      });

      // proposalId only exists on the proposed branch — narrow before access.
      if (
        result.status === "proposed" &&
        "proposalId" in result &&
        result.proposalId
      ) {
        const { buildProposalResponseFields } =
          await import("../../utils/permission-check.js");
        const envelope = buildProposalResponseFields({
          proposalId: result.proposalId,
          subjectType: "entity",
          action: "delete",
          data: { id: input.entityId },
        });
        return {
          status: result.status,
          message: result.message,
          proposalId: result.proposalId,
          summary: envelope.summary,
          reasoning: envelope.reasoning,
          reviewPath: envelope.reviewPath,
          reviewUrl: envelope.reviewUrl,
        };
      }

      return { status: result.status, message: result.message };
    }),
});
