/**
 * Property Definitions Router - Property Management API
 *
 * Handles CRUD operations for property definitions.
 * Property definitions are reusable schemas for entity properties.
 */

import { z } from "zod";
import {
  router,
  protectedProcedure,
  workspaceProcedure,
  podProcedure,
} from "../trpc.js";
import {
  getDb,
  PropertyDefRepository,
  ProfileRepository,
  type PropertyValueType,
  eq,
  drizzleSql,
} from "@synap/database";
import { entityPropertyIndex } from "@synap/database/schema";
// PropertySlugConflictError not used, removed
import { TRPCError } from "@trpc/server";
import { assertWorkspaceWrite } from "../utils/workspace-write-access.js";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "property-defs-router" });

const PropertyValueTypeSchema = z.enum([
  "string",
  "number",
  "boolean",
  "date",
  "entity_id",
  "array",
  "object",
  "secret",
]);

export const propertyDefsRouter = router({
  /**
   * List property definitions accessible to the calling workspace.
   *
   * Returns only defs whose profile is accessible to this workspace
   * (system profiles, workspace-owned profiles, shared profiles with access,
   * user profiles) plus globally-scoped defs (profileId IS NULL).
   *
   * Uses workspaceProcedure so ctx.workspaceId is available.
   */
  list: workspaceProcedure
    .input(
      z
        .object({
          /**
           * Optional targeted read for callers that need schemas for only a
           * few already-resolved profiles. Omit to preserve the full listing.
           */
          profileIds: z.array(z.string().uuid()).optional(),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      const propertyDefRepo = new PropertyDefRepository(db);
      const profileRepo = new ProfileRepository(db);

      // Get profiles accessible to this workspace, then return their property defs
      // plus any global (profileId IS NULL) defs — filtered through this
      // workspace's lens so overlays owned by other workspaces don't leak.
      const requestedProfileIds = input?.profileIds;
      const accessibleProfiles = await profileRepo.getAccessibleProfiles(
        ctx.userId,
        ctx.workspaceId,
        requestedProfileIds ? { ids: requestedProfileIds } : undefined
      );
      const accessibleProfileIds = accessibleProfiles.map((p) => p.id);
      const profileIds = requestedProfileIds
        ? requestedProfileIds.filter((id) => accessibleProfileIds.includes(id))
        : accessibleProfileIds;

      const propertyDefs = await propertyDefRepo.listForProfiles(
        profileIds,
        ctx.workspaceId
      );

      return { propertyDefs };
    }),

  /**
   * Get property definition by slug — optionally scoped by profile + workspace.
   *
   * With Phase 2 layered schemas, the same slug can exist on multiple
   * rows (global, profile-base, workspace overlays). Callers should pass
   * `profileId` + `workspaceId` to target a specific scope. Omitting both
   * is legacy behaviour: returns the first match (typically the global/base
   * def), which is nondeterministic when overlays exist.
   *
   * Scope resolution for `workspaceScope`:
   *   • 'any'     → no workspace filter (legacy)
   *   • 'base'    → match only base defs (workspace_id IS NULL)
   *   • 'current' → match only overlays owned by the calling workspace
   */
  get: podProcedure
    .input(
      z.object({
        slug: z.string(),
        profileId: z.string().uuid().optional(),
        workspaceScope: z.enum(["any", "base", "current"]).default("any"),
      })
    )
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      const propertyDefRepo = new PropertyDefRepository(db);

      // Single-object read: only the 'current' scope needs a workspace, and it
      // needs it as an explicit part of the request — not as a hard precondition
      // on every call. 'any'/'base' resolve lens-free. (podProcedure still
      // validates membership when a lens IS present.)
      if (input.workspaceScope === "current" && !ctx.workspaceId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "workspaceScope 'current' requires an active workspace lens",
        });
      }

      const workspaceFilter =
        input.workspaceScope === "base"
          ? null
          : input.workspaceScope === "current"
            ? ctx.workspaceId
            : undefined;

      const propertyDef = await propertyDefRepo.getBySlug(
        input.slug,
        input.profileId,
        workspaceFilter
      );

      if (!propertyDef) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Property definition not found: ${input.slug}`,
        });
      }

      return { propertyDef };
    }),

  /**
   * Create a new property definition.
   *
   * Three ways to scope the new def (see Phase 2 / migration 0065):
   *   • `profileId` omitted               → global def (any profile)
   *   • `profileId` set, overlay = false  → profile-base def (every workspace
   *                                          that uses the profile renders it)
   *   • `profileId` set, overlay = true   → workspace overlay (only the
   *                                          calling workspace renders it)
   *
   * Use `overlay: true` from a UI flow like "Add a field just to this space"
   * to extend a pod-wide profile without leaking the field to other spaces.
   */
  create: workspaceProcedure
    .input(
      z.object({
        slug: z
          .string()
          .min(1)
          .max(100)
          .regex(/^[a-z0-9-]+$/),
        valueType: PropertyValueTypeSchema,
        constraints: z.record(z.string(), z.unknown()).optional(),
        uiHints: z.record(z.string(), z.unknown()).optional(),
        /** Profile UUID — scopes this def to a single profile. */
        profileId: z.string().uuid().optional(),
        /**
         * When true, the new def is an overlay owned by the calling workspace
         * and invisible to other workspaces. Requires `profileId` (overlays
         * without a profile are meaningless). Default false = base def.
         */
        overlay: z.boolean().default(false),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      const propertyDefRepo = new PropertyDefRepository(db);

      if (input.overlay && !input.profileId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "overlay=true requires profileId — overlays must attach to a profile",
        });
      }

      const overlayWorkspaceId = input.overlay ? ctx.workspaceId : null;

      // Return existing on slug conflict — match exactly the scope we're
      // about to create into (base vs this workspace's overlay). An overlay
      // in a different workspace is a distinct unique-index row and must
      // NOT be treated as "existing".
      const existing = await propertyDefRepo.getBySlug(
        input.slug,
        input.profileId,
        overlayWorkspaceId
      );
      if (existing) {
        logger.info(
          {
            slug: input.slug,
            existingId: existing.id,
            profileId: input.profileId,
            overlay: input.overlay,
          },
          "Property def slug exists in this scope, returning existing"
        );
        return { propertyDef: existing, existing: true };
      }

      const propertyDef = await propertyDefRepo.create({
        slug: input.slug,
        valueType: input.valueType as PropertyValueType,
        constraints: input.constraints,
        uiHints: input.uiHints,
        profileId: input.profileId,
        workspaceId: overlayWorkspaceId,
      });

      logger.info(
        {
          propertyDefId: propertyDef.id,
          slug: propertyDef.slug,
          profileId: propertyDef.profileId,
          overlayWorkspaceId,
          userId: ctx.userId,
        },
        "Property definition created"
      );

      return { propertyDef };
    }),

  /**
   * Update a property definition
   */
  update: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        slug: z
          .string()
          .min(1)
          .max(100)
          .regex(/^[a-z0-9-]+$/)
          .optional(),
        valueType: PropertyValueTypeSchema.optional(),
        constraints: z.record(z.string(), z.unknown()).optional(),
        uiHints: z.record(z.string(), z.unknown()).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      const propertyDefRepo = new PropertyDefRepository(db);

      // Check if property definition exists
      const existing = await propertyDefRepo.getById(input.id);
      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Property definition not found: ${input.id}`,
        });
      }

      // Gate against the ROW's workspace (never a request value). Global/base
      // defs (workspaceId null) are system-managed → denied here.
      await assertWorkspaceWrite(db, ctx.userId, {
        workspaceId: existing.workspaceId,
      });

      // Check for slug conflict if slug is being changed.
      // Look up an exact replacement — same profile_id + same workspace_id
      // scope as the row being updated. Finding a row in the same scope
      // means the new slug would collide on the partial unique index.
      if (input.slug && input.slug !== existing.slug) {
        const conflict = await propertyDefRepo.getBySlug(
          input.slug,
          existing.profileId ?? undefined,
          existing.workspaceId ?? null
        );
        if (conflict && conflict.id !== existing.id) {
          throw new TRPCError({
            code: "CONFLICT",
            message: `Property definition slug already exists: ${input.slug}`,
          });
        }
      }

      const updated = await propertyDefRepo.update(input.id, {
        slug: input.slug,
        valueType: input.valueType as PropertyValueType | undefined,
        constraints: input.constraints,
        uiHints: input.uiHints,
      });

      logger.info(
        { propertyDefId: updated.id, userId: ctx.userId },
        "Property definition updated"
      );

      return { propertyDef: updated };
    }),

  /**
   * Delete a property definition
   */
  delete: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      const propertyDefRepo = new PropertyDefRepository(db);

      // Check if property definition exists
      const existing = await propertyDefRepo.getById(input.id);
      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Property definition not found: ${input.id}`,
        });
      }

      // Gate against the ROW's workspace (never a request value). Global/base
      // defs (workspaceId null) are system-managed → denied here.
      await assertWorkspaceWrite(db, ctx.userId, {
        workspaceId: existing.workspaceId,
      });

      // Prevent deletion if any entity is still using this property
      const usageResult = await db
        .select({ count: drizzleSql<number>`count(*)::int` })
        .from(entityPropertyIndex)
        .where(eq(entityPropertyIndex.propertyDefId, input.id));
      const usageCount = usageResult[0]?.count ?? 0;
      if (usageCount > 0) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `Cannot delete property definition: it is used by ${usageCount} entity record(s). Remove those values first.`,
        });
      }

      await propertyDefRepo.delete(input.id);

      logger.info(
        { propertyDefId: input.id, userId: ctx.userId },
        "Property definition deleted"
      );

      return { success: true };
    }),
});
