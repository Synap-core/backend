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
import { assertMayActAs } from "./guard.js";
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
        offset: z.number().min(0).optional(),
        /**
         * Project focus lens — narrows to the project (its entity + everything
         * that belongs_to it). Pure-narrowing, orthogonal to workspaceId.
         * Forwarded to the regular `list` procedure (applies projectLensWhere).
         */
        projectId: z.string().uuid().optional(),
        /**
         * Scoped-by-default (PRODUCT DECISION): with a workspaceId set, only that
         * workspace's entities are returned. Pass true to also include pod-wide
         * (workspaceId IS NULL) globals — the legacy behavior. Forwarded to the
         * regular `list` procedure.
         */
        includePodWide: z.boolean().optional(),
        /** Kind + Facets filter — only entities carrying a live facet of this role-profile. */
        facetSlug: z.string().optional(),
        facetProfileId: z.string().uuid().optional(),
      })
    )
    .query(async ({ input, ctx }) => {
      const workspaceId =
        input.workspaceId ??
        ((ctx as Record<string, unknown>).workspaceId as string | null) ??
        null;
      // Use input.userId (the real user) not ctx.userId (the API key owner "system")
      assertMayActAs(ctx, input.userId);
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
        offset: input.offset ?? 0,
        ...(input.projectId ? { projectId: input.projectId } : {}),
        ...(input.includePodWide !== undefined
          ? { includePodWide: input.includePodWide }
          : {}),
        ...(input.facetSlug ? { facetSlug: input.facetSlug } : {}),
        ...(input.facetProfileId
          ? { facetProfileId: input.facetProfileId }
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
        /**
         * Long-form markdown body. MUST be declared here (mirrors the tRPC
         * `entities.create` input) — zod strips undeclared keys, so an omitted
         * field silently DROPPED the body of every `POST /api/hub/entities`
         * call: 200 OK, `documentId = NULL`, essay gone. Forwarded to
         * `caller.create` below, where `EntityBodyService` materializes it
         * into a versioned document (or folds short content into
         * `properties.content`). Same class of bug already fixed for capture.
         */
        content: z.string().optional(),
        // File the entity into a project — threaded to checkPermissionOrPropose
        // so the proposal carries projectId and the materializer stamps the
        // belongs_to_project edge that project-scoped recall relies on.
        projectId: z.string().uuid().optional(),
        /**
         * EXPLICIT workspace target. When supplied, it pins the entity to this
         * workspace (rung-1 placement, wins over the profile's entityScope) — the
         * ONLY thing that should become `targetWorkspaceId`. Left unset by normal
         * agent creates, whose placement is derived from the profile's entityScope
         * (pod → NULL, workspace → the caller's ambient workspace). Never defaulted
         * from the ambient workspace — that was the four-door bug.
         */
        workspaceId: z.string().uuid().optional(),
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
        /**
         * Kind + Facets: attach role-profiles to the entity in the SAME call, so
         * an agent can create an entity WITH its roles (e.g. a person who is a
         * client + investor) in one round-trip. Each is attached via the governed
         * `entities.attachFacet` door (fast-fail kind validation + proposal-gated
         * for agents) AFTER the entity materializes — dropped when the create
         * itself is proposal-gated (no id yet to attach to).
         */
        facets: z
          .array(
            z.object({
              slug: z.string(),
              properties: z.record(z.string(), z.unknown()).optional(),
            })
          )
          .optional(),
        /**
         * Bypass the weak same-name create gate (entities.create Phase 1).
         * Strong-signal auto-merge is never bypassed. Prefer reusing an
         * existing id; only set when the subject is genuinely distinct.
         */
        forceCreate: z.boolean().optional(),
        /**
         * Strong `external_id` identity anchor (`provider:id`, e.g. `discord:123`).
         * Must be declared here or Zod's default `.strip()` drops it before the
         * real `entities.create` sees it — the bug that made connector dedup
         * silently no-op (email rode `properties`, which IS declared; external_id
         * had no home in this wrapper). Forwarded to `caller.create` below.
         */
        externalId: z.string().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Use the real user (input.userId), not ctx.userId (API key owner).
      //
      // `ambientWorkspaceId` is the caller's governance/ambient workspace — it
      // flows to entities.create as ctx.workspaceId (NOT as an explicit
      // targetWorkspaceId), so the mutation derives placement from the profile's
      // entityScope: pod-scope kinds land pod-wide (NULL), workspace-scope kinds
      // land in this ambient workspace. Only an EXPLICIT `input.workspaceId` pins.
      //
      // Ambient lens = URL/session pin only. Do NOT invent "most recently
      // updated membership" — that silent wrong-home was the #1 agent dump
      // footgun. Placement for kinds/roles is derived in entities.create via
      // resolveWorkspacePlacement (ontology rung) when ambient is absent.
      const ambientWorkspaceId: string | undefined =
        ctx.workspaceId ?? undefined;

      assertMayActAs(ctx, input.userId);
      const callerContext = await createHubProtocolCallerContext(
        input.userId,
        ctx.scopes || [],
        ambientWorkspaceId,
        ctx.sourceMessageId ?? undefined,
        ctx.sessionId ?? undefined
      );
      const caller = regularEntitiesRouter.createCaller(callerContext);

      const result = await caller.create({
        profileSlug: input.profileSlug ?? input.type,
        title: input.title,
        description: input.description,
        properties: input.properties,
        // Long-form body → linked document (versioned) via EntityBodyService,
        // inside the entities `create` door.
        // Must be forwarded or the create runs with documentId = NULL.
        ...(input.content ? { content: input.content } : {}),
        ...(input.projectId ? { projectId: input.projectId } : {}),
        // Only an EXPLICIT body workspaceId becomes a targetWorkspaceId (rung-1
        // pin). The ambient workspace is NEVER forced here — it already flows via
        // the caller ctx above, so pod-scope kinds resolve to NULL and
        // workspace-scope kinds to the ambient workspace (invariant I3).
        ...(input.workspaceId ? { targetWorkspaceId: input.workspaceId } : {}),
        // Agent's own rationale for the proposal inbox. Top-level `reasoning`
        // wins; fall back to the legacy `aiMetadata.reasoning` alias.
        reasoning: input.reasoning ?? input.aiMetadata?.reasoning,
        // Provenance: explicit `source` from caller wins; otherwise infer
        // "agent" when an agentUserId is present, else "intelligence".
        // "agent" is not a valid EventSource — agent identity is on agentUserId; see SynapEventSchema
        source: input.source ?? "intelligence",
        // Only pass agentUserId when explicitly provided — ctx.userId is the API key
        // owner ("system") which is not a valid UUID and would fail Zod validation.
        agentUserId: input.agentUserId,
        // Kind + Facets: the door owns facet-attach now (the ONE place) — it
        // attaches each role AFTER the entity materializes (or onto a dedup
        // match), through the governed `attachFacet` door, and reports a per-role
        // outcome. Map the hub's `{slug}` contract onto the door's `profileSlug`.
        ...(input.facets?.length
          ? {
              facets: input.facets.map((f) => ({
                profileSlug: f.slug,
                properties: f.properties,
              })),
            }
          : {}),
        ...(input.forceCreate ? { forceCreate: true } : {}),
        // Strong external_id anchor → real entities.create registers it as an
        // identity signal so a repeat create with the same provider id dedups.
        ...(input.externalId ? { externalId: input.externalId } : {}),
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

      // Kind + Facets: the door (entities.create) attached the roles and
      // returned a per-role outcome — forward it verbatim (it already reports
      // the proposal-gated "dropped" case). No duplicated attach here.
      const attachedFacets =
        (
          result as {
            facets?: Array<{
              slug: string;
              status: string;
              facetId?: string;
              proposalId?: string;
              error?: string;
            }>;
          }
        ).facets ?? [];

      // Unknown-property signal (`PropertyValidationService` → EntityRepository
      // → the created row). Keys the caller invented are STORED verbatim but not
      // modelled/queryable — forward them so the write receipt can tell the
      // agent instead of handing it a silent 200. The door's own envelope drops
      // everything it doesn't name, so this must be lifted explicitly; the
      // regular `entities.create` procedure forwards it at the TOP LEVEL.
      const resultShape = result as Record<string, unknown>;
      const rawUnmodeled = resultShape.unmodeled;
      const unmodeled = Array.isArray(rawUnmodeled)
        ? (rawUnmodeled as Array<{ key: string; didYouMean?: string }>)
        : [];

      return {
        status: result.status,
        message: result.message,
        id: result.id,
        // Cast like `proposalType`/`reviewUrl` below: `proposedEntityId` is now
        // CONDITIONAL on the create door (omitted on a workspace-JOIN gate,
        // where no entity id was ever allocated). That widened the inferred
        // union, so these two bare reads no longer narrow.
        proposalId: (result as { proposalId?: string }).proposalId,
        // Additive: signals the door merged onto an existing entity (strong
        // identity match) instead of creating a duplicate.
        ...((result as { deduplicated?: boolean }).deduplicated
          ? { deduplicated: true as const }
          : {}),
        // Forward the governance discriminator + review link from the inner
        // create so hub callers (Discord bridge, CLI, MCP) can tell a workspace
        // JOIN gate ("join") from a content proposal, and surface a clickable
        // review URL — instead of mislabeling a membership gate as "entity
        // proposed". Undefined on the auto-approved / created path.
        proposalType: (result as { proposalType?: string }).proposalType,
        reviewUrl: (result as { reviewUrl?: string }).reviewUrl,
        // Stable entity ID exposed at propose-time for cross-write proposal
        // graphs. Only populated when the action was proposal-gated.
        proposedEntityId: (result as { proposedEntityId?: string })
          .proposedEntityId,
        // Echo the ambient workspace lens for the caller. NOTE: this is the
        // GOVERNANCE context, not necessarily the entity's placement — a
        // pod-scope kind lands at workspaceId=null even though the ambient lens
        // is non-null. The authoritative placement is on the returned entity.
        workspaceId: ambientWorkspaceId ?? null,
        // Kind + Facets: the roles attached in this call (empty/omitted when none
        // were requested or the create was proposal-gated).
        ...(attachedFacets.length ? { facets: attachedFacets } : {}),
        // Property keys this write invented (stored, but not modelled). Omitted
        // when there are none, so the common envelope is byte-identical.
        ...(unmodeled.length ? { unmodeled } : {}),
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
      assertMayActAs(ctx, input.userId);
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
        // "agent" is not a valid EventSource — agent identity is on agentUserId; see SynapEventSchema
        source: "intelligence",
        agentUserId: input.agentUserId,
      });

      if (result.status === "proposed" && result.proposalId) {
        const {
          buildProposalResponseFields,
          isJoinGate,
          proposedMessageFor,
          JOIN_GATE_SUMMARY,
        } = await import("../../utils/permission-check.js");
        const proposalType = (result as { proposalType?: string }).proposalType;
        const joinGate = isJoinGate(proposalType);
        const envelope = buildProposalResponseFields({
          proposalId: result.proposalId,
          subjectType: "entity",
          action: "update",
          data: { id: input.entityId, title: input.title },
        });
        return {
          status: result.status,
          // Derive the prose from the discriminator: on a JOIN gate the entity
          // update was NOT proposed — a workspace-join request was filed
          // instead — so both the message and the SYNTHESIZED summary/reasoning
          // must not narrate an "Update entity …" that does not exist.
          message: proposedMessageFor(proposalType, result.message),
          proposalId: result.proposalId,
          // Same forwarding the sibling `createEntity` already does, so hub
          // callers (CLI, MCP, Discord bridge) can tell the two apart at all.
          proposalType,
          summary: joinGate ? JOIN_GATE_SUMMARY : envelope.summary,
          reasoning: joinGate
            ? proposedMessageFor(proposalType, result.message)
            : envelope.reasoning,
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
      assertMayActAs(ctx, input.userId);
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
        // "agent" is not a valid EventSource — agent identity is on agentUserId; see SynapEventSchema
        source: "intelligence",
        agentUserId: input.agentUserId,
      });

      // proposalId only exists on the proposed branch — narrow before access.
      if (
        result.status === "proposed" &&
        "proposalId" in result &&
        result.proposalId
      ) {
        const {
          buildProposalResponseFields,
          isJoinGate,
          proposedMessageFor,
          JOIN_GATE_SUMMARY,
        } = await import("../../utils/permission-check.js");
        const proposalType = (result as { proposalType?: string }).proposalType;
        const joinGate = isJoinGate(proposalType);
        const envelope = buildProposalResponseFields({
          proposalId: result.proposalId,
          subjectType: "entity",
          action: "delete",
          data: { id: input.entityId },
        });
        return {
          status: result.status,
          // See `updateEntity` above: a JOIN gate proposed no delete at all.
          message: proposedMessageFor(proposalType, result.message),
          proposalId: result.proposalId,
          proposalType,
          summary: joinGate ? JOIN_GATE_SUMMARY : envelope.summary,
          reasoning: joinGate
            ? proposedMessageFor(proposalType, result.message)
            : envelope.reasoning,
          reviewPath: envelope.reviewPath,
          reviewUrl: envelope.reviewUrl,
        };
      }

      return { status: result.status, message: result.message };
    }),

  /**
   * Attach a facet (role-profile) to an entity — Kind + Facets (Wave 1C).
   * Requires: hub-protocol.write scope. Thin wrapper over the regular
   * entities.attachFacet procedure so governance + the emit chain are inherited.
   */
  attachFacet: scopedProcedure(["hub-protocol.write"])
    .input(
      z.object({
        userId: z.string(),
        entityId: z.string().uuid(),
        profileSlug: z.string().optional(),
        profileId: z.string().uuid().optional(),
        workspaceId: z.string().uuid().nullable().optional(),
        contextEntityId: z.string().uuid().nullable().optional(),
        status: z.string().optional(),
        properties: z.record(z.string(), z.unknown()).optional(),
        agentUserId: z.string().uuid().optional(),
        reasoning: z.string().optional(),
        source: z
          .enum([
            "intelligence",
            "agent",
            "openwebui-pipeline",
            "extension",
            "cli",
            "n8n",
            "raycast",
          ])
          .optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      assertMayActAs(ctx, input.userId);
      const callerContext = await createHubProtocolCallerContext(
        input.userId,
        ctx.scopes || [],
        ctx.workspaceId ?? undefined,
        ctx.sourceMessageId ?? undefined,
        ctx.sessionId ?? undefined
      );
      const caller = regularEntitiesRouter.createCaller(callerContext);

      const result = await caller.attachFacet({
        entityId: input.entityId,
        profileSlug: input.profileSlug,
        profileId: input.profileId,
        ...(input.workspaceId !== undefined
          ? { workspaceId: input.workspaceId }
          : {}),
        ...(input.contextEntityId !== undefined
          ? { contextEntityId: input.contextEntityId }
          : {}),
        status: input.status,
        properties: input.properties,
        reasoning: input.reasoning,
        // "agent" is not a valid EventSource — agent identity is on agentUserId; see SynapEventSchema
        source: input.source ?? "intelligence",
        agentUserId: input.agentUserId,
      });

      return {
        status: result.status,
        message: result.message,
        facetId: (result as { facetId?: string }).facetId,
        proposalId: (result as { proposalId?: string }).proposalId,
        proposalType: (result as { proposalType?: string }).proposalType,
        reviewUrl: (result as { reviewUrl?: string }).reviewUrl,
      };
    }),

  /**
   * Update a facet's status/properties — Kind + Facets (Wave 1C).
   * Requires: hub-protocol.write scope.
   */
  updateFacet: scopedProcedure(["hub-protocol.write"])
    .input(
      z.object({
        userId: z.string(),
        facetId: z.string().uuid(),
        status: z.string().optional(),
        properties: z.record(z.string(), z.unknown()).optional(),
        workspaceId: z.string().uuid().nullable().optional(),
        agentUserId: z.string().uuid().optional(),
        reasoning: z.string().optional(),
        source: z
          .enum([
            "intelligence",
            "agent",
            "openwebui-pipeline",
            "extension",
            "cli",
            "n8n",
            "raycast",
          ])
          .optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      assertMayActAs(ctx, input.userId);
      const callerContext = await createHubProtocolCallerContext(
        input.userId,
        ctx.scopes || [],
        ctx.workspaceId ?? undefined,
        ctx.sourceMessageId ?? undefined,
        ctx.sessionId ?? undefined
      );
      const caller = regularEntitiesRouter.createCaller(callerContext);

      const result = await caller.updateFacet({
        facetId: input.facetId,
        status: input.status,
        properties: input.properties,
        ...(input.workspaceId !== undefined
          ? { workspaceId: input.workspaceId }
          : {}),
        reasoning: input.reasoning,
        // "agent" is not a valid EventSource — agent identity is on agentUserId; see SynapEventSchema
        source: input.source ?? "intelligence",
        agentUserId: input.agentUserId,
      });

      return {
        status: result.status,
        message: result.message,
        proposalId: (result as { proposalId?: string }).proposalId,
        proposalType: (result as { proposalType?: string }).proposalType,
        reviewUrl: (result as { reviewUrl?: string }).reviewUrl,
      };
    }),

  /**
   * Detach a facet (soft-delete) — Kind + Facets (Wave 1C).
   * Requires: hub-protocol.write scope.
   */
  detachFacet: scopedProcedure(["hub-protocol.write"])
    .input(
      z.object({
        userId: z.string(),
        facetId: z.string().uuid(),
        agentUserId: z.string().uuid().optional(),
        reasoning: z.string().optional(),
        source: z
          .enum([
            "intelligence",
            "agent",
            "openwebui-pipeline",
            "extension",
            "cli",
            "n8n",
            "raycast",
          ])
          .optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      assertMayActAs(ctx, input.userId);
      const callerContext = await createHubProtocolCallerContext(
        input.userId,
        ctx.scopes || [],
        ctx.workspaceId ?? undefined,
        ctx.sourceMessageId ?? undefined,
        ctx.sessionId ?? undefined
      );
      const caller = regularEntitiesRouter.createCaller(callerContext);

      const result = await caller.detachFacet({
        facetId: input.facetId,
        reasoning: input.reasoning,
        // "agent" is not a valid EventSource — agent identity is on agentUserId; see SynapEventSchema
        source: input.source ?? "intelligence",
        agentUserId: input.agentUserId,
      });

      return {
        status: result.status,
        message: result.message,
        proposalId: (result as { proposalId?: string }).proposalId,
        proposalType: (result as { proposalType?: string }).proposalType,
        reviewUrl: (result as { reviewUrl?: string }).reviewUrl,
      };
    }),
});
