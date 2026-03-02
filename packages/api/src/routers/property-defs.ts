/**
 * Property Definitions Router - Property Management API
 *
 * Handles CRUD operations for property definitions.
 * Property definitions are reusable schemas for entity properties.
 */

import { z } from "zod";
import { router, protectedProcedure, workspaceProcedure } from "../trpc.js";
import {
  getDb,
  PropertyDefRepository,
  ProfileRepository,
  PropertyValueType,
  eq,
  sql,
} from "@synap/database";
import { entityPropertyIndex } from "@synap/database/schema";
// PropertySlugConflictError not used, removed
import { TRPCError } from "@trpc/server";
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
  list: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    const propertyDefRepo = new PropertyDefRepository(db);
    const profileRepo = new ProfileRepository(db);

    // Get profiles accessible to this workspace, then return their property defs
    // plus any global (profileId IS NULL) defs.
    const accessibleProfiles = await profileRepo.getAccessibleProfiles(
      ctx.userId,
      ctx.workspaceId
    );
    const accessibleProfileIds = accessibleProfiles.map((p) => p.id);

    const propertyDefs =
      await propertyDefRepo.listForProfiles(accessibleProfileIds);

    return { propertyDefs };
  }),

  /**
   * Get property definition by slug
   */
  get: protectedProcedure
    .input(
      z.object({
        slug: z.string(),
      })
    )
    .query(async ({ input }) => {
      const db = await getDb();
      const propertyDefRepo = new PropertyDefRepository(db);

      const propertyDef = await propertyDefRepo.getBySlug(input.slug);

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
   * When profileId is provided the def is profile-scoped — allowing each profile
   * to define its own `status`, `type`, `owner`, etc. without slug collisions.
   * When omitted the def is global (legacy behaviour).
   */
  create: protectedProcedure
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
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      const propertyDefRepo = new PropertyDefRepository(db);

      // Return existing on slug conflict (scoped to the same profile, or globally).
      const existing = await propertyDefRepo.getBySlug(
        input.slug,
        input.profileId
      );
      if (existing) {
        logger.info(
          {
            slug: input.slug,
            existingId: existing.id,
            profileId: input.profileId,
          },
          "Property def slug exists, returning existing"
        );
        return { propertyDef: existing, existing: true };
      }

      const propertyDef = await propertyDefRepo.create({
        slug: input.slug,
        valueType: input.valueType as PropertyValueType,
        constraints: input.constraints,
        uiHints: input.uiHints,
        profileId: input.profileId,
      });

      logger.info(
        {
          propertyDefId: propertyDef.id,
          slug: propertyDef.slug,
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

      // Check for slug conflict if slug is being changed
      if (input.slug && input.slug !== existing.slug) {
        const conflict = await propertyDefRepo.getBySlug(input.slug);
        if (conflict) {
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

      // Prevent deletion if any entity is still using this property
      const db = await getDb();
      const usageResult = await db
        .select({ count: sql<number>`count(*)::int` })
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
