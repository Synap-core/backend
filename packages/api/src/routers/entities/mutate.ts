/**
 * Entities Router — mutations (Wave 3 router-decomposition).
 *
 * `update`, `delete`, `moveToWorkspace`, `setEntityViewMode`,
 * `setEntityRenderer`.
 */

import { z } from "zod";
import { workspaceProcedure, podProcedure } from "../../trpc.js";
import {
  db,
  eq,
  and,
  isNull,
  getDb,
  eventRepository,
  EntityRepository,
  extractIdentitySignals,
  registerIdentitySignals,
  IDENTITY_SIGNAL_PROPERTY_KEYS,
} from "@synap/database";
import { entities, views, workspaces } from "@synap/database/schema";
import { TRPCError } from "@trpc/server";
import { checkPermissionOrPropose } from "../../utils/permission-check.js";
import { assertWorkspaceWrite } from "../../utils/workspace-write-access.js";
import { resolveViewTrust } from "../../services/view-trust-service.js";
import { auditLog } from "../../utils/audit-log.js";
import { recordDomainMutation } from "../../utils/domain-mutation.js";
import { emitAiCorrection } from "../../utils/ai-feedback-events.js";
import { AI_KIND } from "../../lib/ai-events.js";
import { getBoss } from "@synap/events";
import { randomUUID } from "crypto";
import { syncPropertyToRelations } from "../../utils/property-relation-sync.js";
import { dispatchWebhooksForEvent } from "../../utils/webhook-delivery.js";
import { createLogger } from "@synap-core/core";
import {
  entityWriteVisibleWhere,
  runSignalWrite,
  mergeSystemData,
  EntityRendererRefSchema,
  DEFAULT_ENTITY_BENTO_TEMPLATES,
} from "./helpers.js";

const logger = createLogger({ module: "entities-router" });

export const mutateProcs = {
  update: podProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        title: z.string().optional(),
        description: z.string().optional(),
        documentId: z.string().uuid().nullable().optional(),
        properties: z.record(z.string(), z.unknown()).optional(),
        /** Keys to delete from the entity's properties object. Applied before `properties` merge. */
        deleteProperties: z.array(z.string()).optional(),
        /** Change entity's profile type by slug (e.g. 'person' → 'contact') */
        profileSlug: z.string().optional(),
        source: z
          .enum(["user", "ai", "intelligence", "system", "agent", "extension"])
          .optional(),
        reasoning: z.string().optional(),
        agentUserId: z.string().uuid().optional(),
        /**
         * Caller-requested review: force this update through the proposal path
         * even when it would otherwise auto-approve. For machine-sourced writes
         * where a human clicked the trigger but did not author the DATA — data
         * enrichment being the first case: the operator reviews the diff on the
         * entity's proposal panel before it lands. Never DOWNGRADES governance;
         * it is OR-ed with the checks that already force a proposal.
         */
        forcePropose: z.boolean().optional(),
        /** When true, removes workspace scoping — entity becomes pod-wide (visible in all workspaces). */
        global: z.boolean().optional(),
        /** Workspace used for permission, audit, overlays, and side effects. */
        targetWorkspaceId: z.string().uuid().optional(),
        /**
         * Host-stamped framed-view identity (NOT a trust assertion). Trust is
         * re-resolved server-side via `resolveViewTrust()`. See `create`'s
         * `viewContext` for the full security contract. Absent → legacy behavior.
         */
        viewContext: z
          .object({
            viewId: z.string().uuid().optional(),
            typeKey: z.string().optional(),
          })
          .optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const correlationId = randomUUID();

      // PROPOSE-TIME VALIDATION: reject an update against a NONEXISTENT entity
      // up front. Previously a missing target sailed past the gate and only blew
      // up at approval with a raw 500 "Entity not found" — a proposal that can
      // never materialize. Check existence BEFORE checkPermissionOrPropose so the
      // caller gets an immediate NOT_FOUND instead of a doomed proposal.
      const existing = await db.query.entities.findFirst({
        where: and(
          eq(entities.id, input.id),
          isNull(entities.deletedAt),
          entityWriteVisibleWhere(ctx.userId)
        ),
        columns: { id: true, workspaceId: true, type: true },
      });
      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Entity not found: ${input.id}`,
        });
      }

      if (input.targetWorkspaceId) {
        const { validateWorkspaceAccess } =
          await import("../../utils/workspace-membership.js");
        const allowedWorkspaceIds = await validateWorkspaceAccess(ctx.userId, [
          input.targetWorkspaceId,
        ]);
        if (!allowedWorkspaceIds.includes(input.targetWorkspaceId)) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Access denied to target workspace",
          });
        }
      }

      const placementWorkspaceId = input.global ? null : existing.workspaceId;
      const overlayWorkspaceId =
        input.targetWorkspaceId ??
        ctx.workspaceId ??
        existing.workspaceId ??
        null;
      const governanceWorkspaceId = existing.workspaceId ?? overlayWorkspaceId;

      // Resolve framed-view trust SERVER-SIDE (never from the request body).
      const issuer = input.viewContext
        ? await resolveViewTrust(
            input.viewContext,
            ctx.userId,
            overlayWorkspaceId
          )
        : undefined;

      // 1. Emit .requested event
      const requestedEvent = await auditLog({
        subjectType: "entity",
        action: "update",
        phase: "requested",
        subjectId: input.id,
        userId: ctx.userId,
        agentUserId: input.agentUserId,
        workspaceId: governanceWorkspaceId,
        correlationId,
        data: {
          title: input.title,
          description: input.description,
          properties: input.properties,
          documentId: input.documentId,
          profileSlug: input.profileSlug,
        },
      });

      // Scope/identity-bearing edits are NOT field patches: promoting a
      // workspace entity to pod-wide (global) or changing its profile TYPE
      // changes the record's visibility/identity. These must ALWAYS be reviewed,
      // even when entity.update otherwise auto-approves — so force a proposal.
      const promotesToGlobal =
        input.global === true && existing.workspaceId !== null;
      const changesProfileType =
        input.profileSlug !== undefined && input.profileSlug !== existing.type;
      const forcePropose =
        promotesToGlobal || changesProfileType || input.forcePropose === true;

      // 2. Permission check
      const perm = await checkPermissionOrPropose({
        userId: ctx.userId,
        agentUserId: input.agentUserId,
        workspaceId: governanceWorkspaceId,
        subjectType: "entity",
        action: "update",
        source: input.source,
        issuer,
        forcePropose,
        reasoning: input.reasoning,
        correlationId,
        requestedEventId: requestedEvent?.id,
        sessionId: ctx.sessionId ?? undefined,
        data: {
          id: input.id,
          title: input.title,
          description: input.description,
          properties: input.properties,
          deleteProperties: input.deleteProperties,
          documentId: input.documentId,
          profileSlug: input.profileSlug,
        },
      });

      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("proposalId" in perm) {
        return {
          status: "proposed",
          message: "Update proposed for review",
          proposalId: perm.proposalId,
          proposalType: perm.proposalType,
          reviewUrl: perm.reviewUrl,
        };
      }

      // 3. Materialize — inline DB write (auto-approved)
      const database = await getDb();
      // Must be the shared singleton, not `new EventRepository(sql)` — a fresh
      // instance has no registered hooks, so emitCompleted()'s append silently
      // never reaches the realtime/materialization/sync hooks.
      const eventRepo = eventRepository;
      const entityRepo = new EntityRepository(database, eventRepo);

      // Snapshot old properties for relation sync (before update)
      let oldEntity:
        | { profileId: string | null; properties: unknown; type: string | null }
        | undefined;
      if (input.properties || input.deleteProperties?.length) {
        oldEntity = await database.query.entities.findFirst({
          where: eq(entities.id, input.id),
          columns: { profileId: true, properties: true, type: true },
        });
      }

      await entityRepo.update(
        input.id,
        {
          title: input.title || undefined,
          preview: input.description || undefined,
          documentId: input.documentId,
          properties: input.properties || undefined,
          deleteProperties: input.deleteProperties,
          profileSlug: input.profileSlug || undefined,
          // Thread the workspace lens so overlay props validate/index correctly
          workspaceId: overlayWorkspaceId,
        },
        ctx.userId
      );

      // 3b. Persist explicit global placement changes after the content/property update.
      // `targetWorkspaceId` is a validation/overlay lens for legacy callers, not an
      // entity move operation. Moving between workspaces should stay explicit.
      if (input.global === true && existing.workspaceId !== null) {
        await database
          .update(entities)
          .set({ workspaceId: placementWorkspaceId })
          .where(eq(entities.id, input.id));
      }

      // 3c. Auto-sync entity_id properties → relations (non-blocking)
      if (input.properties && oldEntity?.profileId) {
        const oldProps =
          (oldEntity.properties as Record<string, unknown>) ?? {};
        const newProps = { ...oldProps, ...input.properties };
        syncPropertyToRelations(
          input.id,
          oldEntity.profileId,
          governanceWorkspaceId,
          ctx.userId,
          oldProps,
          newProps
        ).catch((err) => {
          logger.warn(
            { err },
            "[entities.update] Property→relation sync failed"
          );
        });

        // 3d. Auto-register identity signals (email/phone/url/handle) — non-blocking.
        // Only when a signal-relevant key actually changed, so an unrelated
        // property edit doesn't re-scan + re-write signals every time.
        const changedKeys = new Set(Object.keys(input.properties));
        const touchedIdentityKey = Object.values(
          IDENTITY_SIGNAL_PROPERTY_KEYS
        ).some((keys) => keys.some((k) => changedKeys.has(k)));
        if (touchedIdentityKey) {
          const signals = extractIdentitySignals(newProps);
          if (signals.length > 0) {
            runSignalWrite(() =>
              registerIdentitySignals(
                database,
                input.id,
                signals,
                "entities.update"
              ).catch((err) => {
                logger.warn(
                  { err },
                  "[entities.update] Identity signal registration failed"
                );
              })
            );
          }
        }
      }

      // Compute changed properties before emit so automation triggers can filter on them
      const changedProperties: Record<string, unknown> = {};
      if ((input.properties || input.deleteProperties?.length) && oldEntity) {
        const oldProps =
          (oldEntity.properties as Record<string, unknown>) ?? {};
        // Apply deletions then merge new values, mirroring EntityRepository.update
        const afterDeletions = { ...oldProps };
        for (const key of input.deleteProperties ?? []) {
          delete afterDeletions[key];
        }
        const mergedProps = { ...afterDeletions, ...(input.properties ?? {}) };
        for (const key of new Set([
          ...Object.keys(oldProps),
          ...Object.keys(mergedProps),
        ])) {
          if (
            JSON.stringify(oldProps[key]) !== JSON.stringify(mergedProps[key])
          ) {
            changedProperties[key] = mergedProps[key];
          }
        }
      }

      // 4. Emit .completed event + side-effects — ONE door (recordDomainMutation).
      // Session-scope lifecycle updates (e.g. dealStage lead→client inside a
      // session) so playbook `member_of` automations fire. Null otherwise.
      // `logData: {}` keeps the audit row payload as it was (no changed-prop
      // detail on the log — that shape belongs only to the automation fan-out).
      await recordDomainMutation({
        subjectType: "entity",
        action: "update",
        subjectId: input.id,
        userId: ctx.userId,
        agentUserId: input.agentUserId,
        // Governance linkage (0231): auto-approve receipt (perm is granted here).
        proposalId: "granted" in perm ? perm.autoApprovedProposalId : undefined,
        workspaceId: governanceWorkspaceId,
        correlationId,
        sessionId: ctx.sessionId ?? null,
        data: {
          profileSlug: input.profileSlug ?? oldEntity?.type ?? undefined,
          ...(Object.keys(changedProperties).length > 0
            ? {
                changedKeys: Object.keys(changedProperties),
                ...Object.fromEntries(
                  Object.keys(changedProperties).map((k) => [
                    `changed.${k}`,
                    true,
                  ])
                ),
                ...changedProperties,
              }
            : {}),
        },
        logData: {},
      });

      // Dispatch webhooks for entity property updates (fire-and-forget, non-blocking)
      if (input.properties && oldEntity) {
        if (Object.keys(changedProperties).length > 0) {
          dispatchWebhooksForEvent("entity.update.completed", {
            entityId: input.id,
            entityType: oldEntity.type,
            workspaceId: governanceWorkspaceId,
            changedProperties,
          });
        }
      }

      // Dispatch entity embedding job (non-blocking — only if searchable fields changed).
      // Debounce: rapid successive edits to the SAME entity collapse into one
      // queued embedding job via pg-boss singleton throttling (singletonKey =
      // entity id, throttled over a short window) so a burst of keystroke-level
      // updates doesn't fire one embedding LLM call each.
      if (input.title !== undefined || input.description !== undefined) {
        try {
          await getBoss().send(
            "entity-embedding",
            {
              entityId: input.id,
              title: input.title,
              preview: input.description,
              userId: ctx.userId,
              action: "update",
            },
            {
              singletonKey: `entity-embedding:${input.id}`,
              singletonSeconds: 30,
            }
          );
        } catch (err) {
          logger.warn(
            { err },
            "[entities.update] Failed to queue embedding job"
          );
        }
      }

      return { status: "updated", message: "Entity updated" };
    }),
  delete: podProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        source: z
          .enum(["user", "ai", "intelligence", "system", "agent"])
          .optional(),
        reasoning: z.string().optional(),
        agentUserId: z.string().uuid().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const correlationId = randomUUID();

      // PROPOSE-TIME VALIDATION: reject a delete against a NONEXISTENT (or
      // already-deleted) entity up front, so an agent never files a proposal that
      // can only fail at approval with a raw 500.
      const existing = await db.query.entities.findFirst({
        where: and(
          eq(entities.id, input.id),
          isNull(entities.deletedAt),
          entityWriteVisibleWhere(ctx.userId)
        ),
        columns: { id: true, workspaceId: true, correlationId: true },
      });
      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Entity not found: ${input.id}`,
        });
      }
      const governanceWorkspaceId = existing.workspaceId ?? null;

      // 1. Emit .requested event
      const requestedEvent = await auditLog({
        subjectType: "entity",
        action: "delete",
        phase: "requested",
        subjectId: input.id,
        userId: ctx.userId,
        agentUserId: input.agentUserId,
        workspaceId: governanceWorkspaceId,
        correlationId,
        data: { id: input.id },
      });

      // 2. Permission check
      const perm = await checkPermissionOrPropose({
        userId: ctx.userId,
        agentUserId: input.agentUserId,
        workspaceId: governanceWorkspaceId,
        subjectType: "entity",
        action: "delete",
        source: input.source,
        reasoning: input.reasoning,
        correlationId,
        requestedEventId: requestedEvent?.id,
        data: { id: input.id },
      });

      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("proposalId" in perm) {
        return {
          status: "proposed",
          message: "Deletion proposed for review",
          proposalId: perm.proposalId,
          proposalType: perm.proposalType,
          reviewUrl: perm.reviewUrl,
        };
      }

      // 3. Materialize — inline DB write (auto-approved)
      const database = await getDb();

      // B1 / soft-delete reversibility: this is a SOFT delete (sets `deletedAt`
      // below, "Keeping deleted rows preserves audit/proposal reversibility").
      // We DELIBERATELY do NOT delete the entity's document/storage here — a
      // restore must be able to recover the body. The old user-pref-gated
      // `entity.deleteDocument` cascade was removed: on a soft delete it would
      // have orphaned a restore (deleting the body of a still-restorable row).
      // The unconditional document→storage reverse-cascade (EntityBodyService
      // .deleteBody) fires only on the HARD/permanent delete paths
      // (`adminDelete` / `adminBatchDelete`).

      // Snapshot profileSlug before deletion for automation trigger filtering
      const [deletedEntityRow] = await database
        .select({ type: entities.type })
        .from(entities)
        .where(eq(entities.id, input.id))
        .limit(1);

      // Permission is already verified above — soft-delete by id only, no userId
      // filter. entityRepo.delete() restricts to creator (user_id=$userId) which
      // would silently no-op for workspace admins deleting others' entities.
      // Keeping deleted rows preserves audit/proposal reversibility.
      await database
        .update(entities)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(eq(entities.id, input.id));

      // 4. Emit .completed event + side-effects — ONE door (recordDomainMutation).
      // Fire-and-forget (delete already committed); symmetric with create/update,
      // session-scope deletes so playbook automations fire. `logData: {}` keeps
      // the audit row payload unchanged (profileSlug is fan-out-only).
      void recordDomainMutation({
        subjectType: "entity",
        action: "delete",
        subjectId: input.id,
        userId: ctx.userId,
        agentUserId: input.agentUserId,
        workspaceId: governanceWorkspaceId,
        correlationId,
        sessionId: ctx.sessionId ?? null,
        data: { profileSlug: deletedEntityRow?.type ?? undefined },
        logData: {},
      });

      // Feedback signal — a human deleted an entity the AI created (carries a
      // correlationId back to the decision that produced it). Best-effort:
      // never fail the delete over an audit-log hiccup.
      if (existing.correlationId) {
        await emitAiCorrection({
          action: "delete",
          userId: ctx.userId,
          subjectId: input.id,
          agentUserId: input.agentUserId,
          workspaceId: governanceWorkspaceId,
          data: {
            kind: AI_KIND.EXTRACT,
            entityId: input.id,
            correlationId: existing.correlationId,
          },
        });
      }

      return { status: "deleted", message: "Entity deleted" };
    }),

  /**
   * Move entities to a different workspace — a governed operation distinct
   * from `update`'s `global` flag (which only promotes to pod-wide/null).
   *
   * Two-sided access check:
   *   - SOURCE: `checkPermissionOrPropose` gated on the entity's CURRENT
   *     workspaceId (mirrors `update`'s governance so agent callers get
   *     proposal-gated instead of blocked, per CLAUDE.md).
   *   - TARGET: `assertWorkspaceWrite` — the caller must also be an editor+
   *     member of the DESTINATION workspace, since moving an entity there is
   *     a write to that workspace too (new check; `update`'s `global` path
   *     never needed one because it only ever moves TO null).
   *
   * Best-effort per entity (mirrors `batchCreate`'s partial-success shape) —
   * one entity's not-found/denied/proposed outcome never blocks the others.
   */
  moveToWorkspace: podProcedure
    .input(
      z.object({
        entityIds: z.array(z.string().uuid()).min(1),
        workspaceId: z.string().uuid(),
        reason: z.string().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const database = await getDb();

      // Target-side gate: caller must be able to write INTO the destination
      // workspace. Membership check, not row-scoped (there is no row there yet).
      await assertWorkspaceWrite(database, ctx.userId, {
        workspaceId: input.workspaceId,
      });

      const moved: string[] = [];
      const proposed: Array<{ entityId: string; proposalId: string }> = [];
      const errors: Array<{ entityId: string; error: string }> = [];

      for (const entityId of input.entityIds) {
        try {
          const existing = await db.query.entities.findFirst({
            where: and(
              eq(entities.id, entityId),
              isNull(entities.deletedAt),
              entityWriteVisibleWhere(ctx.userId)
            ),
            columns: { id: true, workspaceId: true, correlationId: true },
          });
          if (!existing) {
            errors.push({ entityId, error: "Entity not found" });
            continue;
          }
          const fromWorkspaceId = existing.workspaceId;

          // No-op guard: the entity is already in the destination. Skip the
          // write AND — critically — the `ai_correction` emit. Emitting a
          // `kind:"route"` correction with fromWorkspaceId === toWorkspaceId
          // would tag the entity's AI decision as "corrected", dropping
          // routingAccuracy for a decision that was actually right — the exact
          // metric this feature exists to produce. Reachable via a batch move
          // that includes an entity already in the target. Count it as moved
          // (the caller's desired end-state holds) and move on.
          if (fromWorkspaceId === input.workspaceId) {
            moved.push(entityId);
            continue;
          }

          const correlationId = randomUUID();

          // 1. Emit .requested event
          const requestedEvent = await auditLog({
            subjectType: "entity",
            action: "move",
            phase: "requested",
            subjectId: entityId,
            userId: ctx.userId,
            workspaceId: fromWorkspaceId,
            correlationId,
            data: {
              fromWorkspaceId,
              toWorkspaceId: input.workspaceId,
              reason: input.reason,
            },
          });

          // 2. Source-side permission check — gated on the CURRENT workspace,
          // same governance ladder `update` uses (action mapped to "write" via
          // requiredPermissionFor("update"); "move" itself isn't a registered
          // action in @synap/governance-policy).
          const perm = await checkPermissionOrPropose({
            userId: ctx.userId,
            workspaceId: fromWorkspaceId,
            subjectType: "entity",
            action: "update",
            reasoning: input.reason,
            correlationId,
            requestedEventId: requestedEvent?.id,
            data: { id: entityId, toWorkspaceId: input.workspaceId },
          });

          if ("denied" in perm && perm.denied) {
            errors.push({ entityId, error: perm.reason });
            continue;
          }
          if ("proposalId" in perm) {
            proposed.push({ entityId, proposalId: perm.proposalId });
            continue;
          }

          // 3. Materialize — inline DB write (auto-approved)
          await database
            .update(entities)
            .set({ workspaceId: input.workspaceId })
            .where(eq(entities.id, entityId));

          // 4. Emit .completed event
          await auditLog({
            subjectType: "entity",
            action: "move",
            phase: "completed",
            subjectId: entityId,
            userId: ctx.userId,
            workspaceId: input.workspaceId,
            correlationId,
          });

          moved.push(entityId);

          // Feedback signal (PRIMARY) — a human rerouted an entity the AI
          // placed via a captured decision. Best-effort: never fail the move.
          if (existing.correlationId) {
            await emitAiCorrection({
              action: "reroute",
              userId: ctx.userId,
              subjectId: entityId,
              workspaceId: input.workspaceId,
              data: {
                kind: AI_KIND.ROUTE,
                entityId,
                fromWorkspaceId,
                toWorkspaceId: input.workspaceId,
                correlationId: existing.correlationId,
              },
            });
          }
        } catch (err) {
          errors.push({
            entityId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      return { moved, proposed, errors };
    }),
  setEntityViewMode: workspaceProcedure
    .input(
      z.object({
        entityId: z.string().uuid(),
        mode: z.enum(["document", "bento"]),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Any workspace MEMBER may set the view mode (not just the creator) —
      // that part is deliberate. What was NOT deliberate: the previous lookup
      // was `or(eq(workspaceId, ctx.workspaceId), isNull(workspaceId))`, and
      // that `isNull` branch carried NO user term. A pod-personal row
      // (`workspace_id IS NULL`) belonging to ANOTHER user matched it, so any
      // authenticated user could pass a foreign entity id and mutate its
      // `systemData` — a cross-user WRITE, not merely a read.
      // `entityWriteVisibleWhere` is the canonical floor and applies the OWNER
      // condition to NULL-workspace rows. Same fix as the door below; the two
      // must not diverge again.
      const entity = await db.query.entities.findFirst({
        where: and(
          eq(entities.id, input.entityId),
          isNull(entities.deletedAt),
          entityWriteVisibleWhere(ctx.userId)
        ),
      });

      if (!entity) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Entity not found" });
      }

      const currentSystemData =
        (entity.systemData as Record<string, unknown>) || {};
      let bentoViewId = currentSystemData.bentoViewId as string | undefined;

      // Create bento view on first switch to bento mode
      if (input.mode === "bento" && !bentoViewId) {
        // Look up workspace settings for a profile-specific bento template
        const workspace = await db.query.workspaces.findFirst({
          where: eq(workspaces.id, ctx.workspaceId as string),
        });

        const profileSlug = entity.type; // entity.type === profile slug
        const workspaceSettings =
          (workspace?.settings as Record<string, unknown>) ?? {};
        const profileTemplates =
          workspaceSettings.profileEntityBentoTemplates as
            Record<string, { blocks: unknown[] }> | undefined;

        // Level 1: profile-specific template from workspace settings
        // Level 2: built-in profile templates for common entity types
        // Level 3: generic 3-widget fallback
        const blocks = profileTemplates?.[profileSlug]?.blocks ??
          DEFAULT_ENTITY_BENTO_TEMPLATES[profileSlug] ?? [
            {
              id: "entity-header",
              kind: "widget",
              widgetType: "entity-header",
              pos: { x: 0, y: 0, w: 12, h: 2 },
            },
            {
              id: "entity-props",
              kind: "widget",
              widgetType: "entity-properties",
              pos: { x: 0, y: 2, w: 4, h: 6 },
            },
            {
              id: "entity-content",
              kind: "widget",
              widgetType: "entity-links",
              pos: { x: 4, y: 2, w: 8, h: 6 },
            },
          ];

        const newViewId = randomUUID();
        await db.insert(views).values({
          id: newViewId,
          workspaceId: ctx.workspaceId || null,
          userId: ctx.userId,
          type: "bento",
          category: "composite",
          name: `${entity.title || "Entity"} Dashboard`,
          config: { layout: "bento", blocks },
          metadata: {
            entityId: input.entityId,
            source: "entity-bento",
            profileSlug,
          },
        });
        bentoViewId = newViewId;
      }

      // Write to systemData column (not properties) — clean separation from user fields
      const updatedSystemData: Record<string, unknown> = {
        ...currentSystemData,
        viewMode: input.mode,
        ...(bentoViewId ? { bentoViewId } : {}),
      };

      await db
        .update(entities)
        .set({ systemData: updatedSystemData, updatedAt: new Date() })
        .where(eq(entities.id, input.entityId));

      return {
        status: "ok",
        viewMode: input.mode,
        bentoViewId: bentoViewId ?? null,
      };
    }),

  /**
   * Set (or clear) the PER-ENTITY renderer override.
   *
   * This is the governed write door for `entities.system_data.renderer` — the
   * lowest, most specific layer of renderer resolution. Precedence (one
   * definition, mirrored in `@synap-core/renderer-runtime`):
   *
   *   1. entity `systemData.renderer`   ← this door
   *   2. entity `systemData.viewMode`/`bentoViewId` (legacy bento toggle)
   *   3. workspace overlay / profile default  (profiles.setProfileRendererOverride)
   *   4. hardcoded host fallback
   *
   * GOVERNED, unlike the sibling `setEntityViewMode` (which is an ungoverned
   * `workspaceProcedure` — a known hole; do not copy it). Same three-way
   * contract as `profiles.setProfileRendererOverride`: applied / proposed /
   * FORBIDDEN.
   */
  setEntityRenderer: workspaceProcedure
    .input(
      z.object({
        entityId: z.string().uuid(),
        /** `null` clears the override. Narrowed to `cell` — see EntityRendererRefSchema. */
        ref: EntityRendererRefSchema.nullable(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Load first — the write is gated on the row's OWN workspace via the
      // canonical write floor, never on a request-supplied workspaceId
      // (access-layer rule). `entityWriteVisibleWhere` also applies the
      // OWNER floor to NULL-workspace (pod-personal) rows — the naive
      // `or(eq(workspaceId, ctx.workspaceId), isNull(workspaceId))` that
      // `setEntityViewMode` uses does NOT, and lets any user reach another
      // user's unfiled entities.
      const entity = await db.query.entities.findFirst({
        where: and(
          eq(entities.id, input.entityId),
          isNull(entities.deletedAt),
          entityWriteVisibleWhere(ctx.userId)
        ),
        columns: {
          id: true,
          workspaceId: true,
          type: true,
          title: true,
          systemData: true,
        },
      });

      if (!entity) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Entity not found" });
      }

      const perm = await checkPermissionOrPropose({
        userId: ctx.userId,
        agentUserId: ctx.agentUserId ?? undefined,
        workspaceId: entity.workspaceId ?? ctx.workspaceId,
        subjectType: "entity",
        action: "renderer.set",
        source: ctx.source ?? undefined,
        sourceMessageId: ctx.sourceMessageId ?? undefined,
        sessionId: ctx.sessionId ?? undefined,
        projectId: ctx.projectId ?? undefined,
        data: {
          entityId: input.entityId,
          entityTitle: entity.title,
          profileSlug: entity.type,
          ref: input.ref,
        },
      });

      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("proposalId" in perm) {
        return {
          success: false,
          status: "proposed" as const,
          proposalId: perm.proposalId,
        };
      }

      // MERGE — `systemData` is a shared bag (viewMode, bentoViewId,
      // onboardingScaffold, mergedInto, …). A wholesale `.set({ systemData })`
      // would silently destroy every other key.
      const nextSystemData = mergeSystemData(entity.systemData, {
        renderer: input.ref,
      });

      await db
        .update(entities)
        .set({ systemData: nextSystemData, updatedAt: new Date() })
        .where(eq(entities.id, input.entityId));

      logger.info(
        {
          entityId: input.entityId,
          cleared: input.ref === null,
          cellKey: input.ref?.cellKey,
          workspaceId: entity.workspaceId ?? ctx.workspaceId,
        },
        "Entity renderer override updated"
      );

      return {
        success: true,
        status: "applied" as const,
        proposalId: null,
      };
    }),
};
