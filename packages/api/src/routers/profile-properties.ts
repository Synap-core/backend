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
import {
  assertProfileSchemaWrite,
  propertyLinkLevel,
} from "../utils/profile-schema-write-access.js";

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

      // Ownership gate on the LOADED profile. A new optional link onto a system
      // kind stays open to editors; `required`, a default, or re-linking an
      // existing pair (the repository upserts) needs the profile's owner.
      const existingLinks = await profilePropertyRepo.getByProfile(profile.id);
      await assertProfileSchemaWrite(db, ctx.userId, profile, {
        level: propertyLinkLevel({
          required: input.required,
          defaultValue: input.defaultValue,
          alreadyLinked: existingLinks.some(
            (l) => l.propertyDefId === input.propertyDefId
          ),
        }),
        actingWorkspaceId: ctx.workspaceId,
      });

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

      // Owners/admins of the PROFILE's workspace — not of the request's.
      await assertProfileSchemaWrite(db, ctx.userId, profile, {
        level: "admin",
        actingWorkspaceId: ctx.workspaceId,
      });

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

      // Flipping `required` / `defaultValue` / order on a link changes the
      // schema for every workspace using the profile — never additive.
      await assertProfileSchemaWrite(db, ctx.userId, profile, {
        level: "editor",
        actingWorkspaceId: ctx.workspaceId,
      });

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

      // Get effective properties (with inheritance) through this workspace's lens
      const effectiveProperties =
        await resolutionService.getEffectiveProperties(
          input.profileId,
          ctx.workspaceId
        );

      return { properties: effectiveProperties };
    }),
});
