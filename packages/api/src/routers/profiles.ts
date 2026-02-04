/**
 * Profiles Router - Profile Management API
 *
 * Handles CRUD operations for entity type profiles.
 * Profiles define entity types as configuration, not code.
 */

import { z } from "zod";
import { router, workspaceProcedure } from "../trpc.js";
import {
  getDb,
  ProfileRepository,
  ProfileResolutionService,
  ProfileScope,
} from "@synap/database";
import { TRPCError } from "@trpc/server";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "profiles-router" });

const ProfileScopeSchema = z.enum(["system", "workspace", "user"]);

export const profilesRouter = router({
  /**
   * List accessible profiles (system + workspace + user)
   */
  list: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    const profileRepo = new ProfileRepository(db);

    const profiles = await profileRepo.getAccessibleProfiles(
      ctx.userId,
      ctx.workspaceId
    );

    return { profiles };
  }),

  /**
   * Get profile by slug or ID
   */
  get: workspaceProcedure
    .input(
      z.object({
        identifier: z.string(), // slug or ID
      })
    )
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      const resolutionService = new ProfileResolutionService(db);

      const profile = await resolutionService.resolveProfile(
        input.identifier,
        ctx.userId,
        ctx.workspaceId
      );

      if (!profile) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Profile not found: ${input.identifier}`,
        });
      }

      // Get effective properties (with inheritance)
      const effectiveProperties =
        await resolutionService.getEffectiveProperties(profile.id);

      return {
        profile,
        effectiveProperties,
      };
    }),

  /**
   * Create a new profile
   */
  create: workspaceProcedure
    .input(
      z.object({
        slug: z
          .string()
          .min(1)
          .max(100)
          .regex(/^[a-z0-9-]+$/),
        displayName: z.string().min(1).max(200),
        parentProfileId: z.string().uuid().optional(),
        uiHints: z.record(z.string(), z.unknown()).optional(),
        scope: ProfileScopeSchema.default("workspace"),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      const profileRepo = new ProfileRepository(db);

      // Check for slug conflict
      const existing = await profileRepo.getBySlug(input.slug);
      if (existing) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `Profile slug already exists: ${input.slug}`,
        });
      }

      // Validate parent profile if provided
      if (input.parentProfileId) {
        const parent = await profileRepo.getById(input.parentProfileId);
        if (!parent) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Parent profile not found: ${input.parentProfileId}`,
          });
        }

        // Check for inheritance cycles
        const resolutionService = new ProfileResolutionService(db);
        const hierarchy = await resolutionService.getProfileHierarchy(
          input.parentProfileId
        );
        const cycle = hierarchy.find((p) => p.slug === input.slug);
        if (cycle) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Inheritance cycle detected: ${input.slug} would create a cycle`,
          });
        }
      }

      // Determine scope-based ownership
      let userId: string | undefined;
      let workspaceId: string | undefined;

      if (input.scope === "system") {
        // System profiles have no owner
        userId = undefined;
        workspaceId = undefined;
      } else if (input.scope === "workspace") {
        workspaceId = ctx.workspaceId;
      } else if (input.scope === "user") {
        userId = ctx.userId;
      }

      const profile = await profileRepo.create({
        slug: input.slug,
        displayName: input.displayName,
        parentProfileId: input.parentProfileId,
        uiHints: input.uiHints,
        scope: input.scope as ProfileScope,
        userId,
        workspaceId,
      });

      logger.info(
        { profileId: profile.id, slug: profile.slug, userId: ctx.userId },
        "Profile created"
      );

      return { profile };
    }),

  /**
   * Update a profile
   */
  update: workspaceProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        displayName: z.string().min(1).max(200).optional(),
        parentProfileId: z.string().uuid().optional().nullable(),
        uiHints: z.record(z.string(), z.unknown()).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      const profileRepo = new ProfileRepository(db);
      const resolutionService = new ProfileResolutionService(db);

      // Verify profile exists and is accessible
      const existing = await resolutionService.resolveProfile(
        input.id,
        ctx.userId,
        ctx.workspaceId
      );

      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Profile not found: ${input.id}`,
        });
      }

      // Check for inheritance cycles if parent is being changed
      if (input.parentProfileId !== undefined) {
        if (input.parentProfileId) {
          const parent = await profileRepo.getById(input.parentProfileId);
          if (!parent) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: `Parent profile not found: ${input.parentProfileId}`,
            });
          }

          // Check for cycles
          const hierarchy = await resolutionService.getProfileHierarchy(
            input.parentProfileId
          );
          const cycle = hierarchy.find((p) => p.id === input.id);
          if (cycle) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: `Inheritance cycle detected`,
            });
          }
        }
      }

      const updated = await profileRepo.update(input.id, {
        displayName: input.displayName,
        parentProfileId: input.parentProfileId ?? undefined,
        uiHints: input.uiHints,
      });

      logger.info(
        { profileId: updated.id, userId: ctx.userId },
        "Profile updated"
      );

      return { profile: updated };
    }),

  /**
   * Delete a profile (soft delete)
   */
  delete: workspaceProcedure
    .input(
      z.object({
        id: z.string().uuid(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      const profileRepo = new ProfileRepository(db);
      const resolutionService = new ProfileResolutionService(db);

      // Verify profile exists and is accessible
      const existing = await resolutionService.resolveProfile(
        input.id,
        ctx.userId,
        ctx.workspaceId
      );

      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Profile not found: ${input.id}`,
        });
      }

      // Don't allow deleting system profiles
      if (existing.scope === "system") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Cannot delete system profiles",
        });
      }

      await profileRepo.delete(input.id);

      logger.info(
        { profileId: input.id, userId: ctx.userId },
        "Profile deleted"
      );

      return { success: true };
    }),

  /**
   * Get effective properties for a profile (with inheritance)
   */
  getEffectiveProperties: workspaceProcedure
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

      const effectiveProperties =
        await resolutionService.getEffectiveProperties(input.profileId);

      return { properties: effectiveProperties };
    }),

  /**
   * Get profile hierarchy (root → leaf)
   */
  getHierarchy: workspaceProcedure
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

      const hierarchy = await resolutionService.getProfileHierarchy(
        input.profileId
      );

      return { hierarchy };
    }),
});
