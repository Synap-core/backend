/**
 * Profile Properties Router - Profile-Property Linking API
 *
 * Handles linking properties to profiles with configuration.
 */

import { z } from "zod";
import { router, workspaceProcedure } from "../trpc.js";
import {
  getDb,
  ProfilePropertyRepository,
  PropertyDefRepository,
  ProfileResolutionService,
} from "@synap/database";
import { TRPCError } from "@trpc/server";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "profile-properties-router" });

export const profilePropertiesRouter = router({
  /**
   * Link a property to a profile
   */
  link: workspaceProcedure
    .input(
      z.object({
        profileId: z.string().uuid(),
        propertyDefId: z.string().uuid(),
        required: z.boolean().default(false),
        defaultValue: z.unknown().optional(),
        displayOrder: z.number().int().default(0),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      const propertyDefRepo = new PropertyDefRepository(db);
      const profilePropertyRepo = new ProfilePropertyRepository(db);
      const resolutionService = new ProfileResolutionService(db);

      // Verify profile is accessible
      const profile = await resolutionService.resolveProfile(
        input.profileId,
        ctx.userId,
        ctx.workspaceId
      );

      if (!profile) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Profile not found: ${input.profileId}`,
        });
      }

      // Verify property definition exists
      const propertyDef = await propertyDefRepo.getById(input.propertyDefId);
      if (!propertyDef) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Property definition not found: ${input.propertyDefId}`,
        });
      }

      const link = await profilePropertyRepo.link({
        profileId: input.profileId,
        propertyDefId: input.propertyDefId,
        required: input.required,
        defaultValue: input.defaultValue,
        displayOrder: input.displayOrder,
      });

      logger.info(
        {
          profileId: input.profileId,
          propertyDefId: input.propertyDefId,
          userId: ctx.userId,
        },
        "Property linked to profile"
      );

      return { link };
    }),

  /**
   * Unlink a property from a profile
   *
   * @deprecated Properties cannot be removed from profiles to prevent data loss.
   * Instead, mark properties as not required or hide them in UI.
   * This endpoint is kept for admin use only (future: workspace admin role check).
   *
   * Restricted to workspace owner/admin roles.
   */
  unlink: workspaceProcedure
    .input(
      z.object({
        profileId: z.string().uuid(),
        propertyDefId: z.string().uuid(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Only workspace owners/admins can unlink properties
      if (!["owner", "admin"].includes(ctx.workspaceRole)) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Only workspace owners/admins can unlink properties",
        });
      }

      logger.warn(
        {
          profileId: input.profileId,
          propertyDefId: input.propertyDefId,
          userId: ctx.userId,
        },
        "Property unlink requested - consider hiding property instead of unlinking"
      );

      const db = await getDb();
      const resolutionService = new ProfileResolutionService(db);

      // Verify profile is accessible
      const profile = await resolutionService.resolveProfile(
        input.profileId,
        ctx.userId,
        ctx.workspaceId
      );

      if (!profile) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Profile not found: ${input.profileId}`,
        });
      }

      // Prevent unlinking system profiles
      if (profile.scope === "system") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Cannot unlink properties from system profiles",
        });
      }

      const profilePropertyRepo = new ProfilePropertyRepository(db);
      await profilePropertyRepo.unlink(input.profileId, input.propertyDefId);

      logger.info(
        {
          profileId: input.profileId,
          propertyDefId: input.propertyDefId,
          userId: ctx.userId,
        },
        "Property unlinked from profile (admin action)"
      );

      return { success: true };
    }),

  /**
   * Update link configuration
   */
  update: workspaceProcedure
    .input(
      z.object({
        profileId: z.string().uuid(),
        propertyDefId: z.string().uuid(),
        required: z.boolean().optional(),
        defaultValue: z.unknown().optional(),
        displayOrder: z.number().int().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      const resolutionService = new ProfileResolutionService(db);

      // Verify profile is accessible
      const profile = await resolutionService.resolveProfile(
        input.profileId,
        ctx.userId,
        ctx.workspaceId
      );

      if (!profile) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Profile not found: ${input.profileId}`,
        });
      }

      const profilePropertyRepo = new ProfilePropertyRepository(db);
      const updated = await profilePropertyRepo.update(
        input.profileId,
        input.propertyDefId,
        {
          required: input.required,
          defaultValue: input.defaultValue,
          displayOrder: input.displayOrder,
        }
      );

      logger.info(
        {
          profileId: input.profileId,
          propertyDefId: input.propertyDefId,
          userId: ctx.userId,
        },
        "Profile property link updated"
      );

      return { link: updated };
    }),

  /**
   * Get all properties for a profile
   */
  getByProfile: workspaceProcedure
    .input(
      z.object({
        profileId: z.string().uuid(),
      })
    )
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      const resolutionService = new ProfileResolutionService(db);

      // Verify profile is accessible
      const profile = await resolutionService.resolveProfile(
        input.profileId,
        ctx.userId,
        ctx.workspaceId
      );

      if (!profile) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Profile not found: ${input.profileId}`,
        });
      }

      // Get effective properties (with inheritance)
      const effectiveProperties =
        await resolutionService.getEffectiveProperties(input.profileId);

      return { properties: effectiveProperties };
    }),
});
