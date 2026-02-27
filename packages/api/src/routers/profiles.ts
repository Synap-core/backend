/**
 * Profiles Router - Profile Management API
 *
 * Event-driven CRUD with 3-phase lifecycle for entity type profiles.
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
import { checkPermissionOrPropose } from "../utils/permission-check.js";
import { auditLog } from "../utils/audit-log.js";
import { randomUUID } from "crypto";

const logger = createLogger({ module: "profiles-router" });

const ProfileScopeSchema = z.enum(["system", "shared", "workspace", "user"]);

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
        /**
         * For scope="shared": list of workspace IDs to grant access to immediately.
         * The calling workspace is always included automatically.
         */
        allowedWorkspaceIds: z.array(z.string().uuid()).optional(),
        source: z.enum(["user", "ai", "intelligence", "system"]).optional(),
        reasoning: z.string().optional(),
        agentUserId: z.string().uuid().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const correlationId = randomUUID();
      const profileId = randomUUID();

      const db = await getDb();
      const profileRepo = new ProfileRepository(db);

      // Check for slug conflict — return existing profile gracefully
      // Profiles have a global unique slug constraint, so reuse across workspaces.
      // For shared profiles, also grant access to the requesting workspace.
      const existing = await profileRepo.getBySlug(input.slug);
      if (existing) {
        logger.info(
          { slug: input.slug, existingId: existing.id },
          "Profile slug exists, returning existing"
        );
        // Grant access if this workspace doesn't already have it
        if (
          existing.scope === ProfileScope.SHARED ||
          input.scope === "shared"
        ) {
          await profileRepo.grantAccess(existing.id, ctx.workspaceId);
        }
        return { profile: existing, existing: true };
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

      // 1. Emit .requested event
      auditLog({
        subjectType: "profile",
        action: "create",
        phase: "requested",
        subjectId: profileId,
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
        correlationId,
        data: {
          slug: input.slug,
          displayName: input.displayName,
          parentProfileId: input.parentProfileId,
          scope: input.scope,
        },
      });

      // 2. Permission check (may create proposal)
      const perm = await checkPermissionOrPropose({
        userId: ctx.userId,
        agentUserId: input.agentUserId,
        workspaceId: ctx.workspaceId,
        subjectType: "profile",
        action: "create",
        source: input.source,
        reasoning: input.reasoning,
        correlationId,
        data: {
          id: profileId,
          slug: input.slug,
          displayName: input.displayName,
          parentProfileId: input.parentProfileId,
          uiHints: input.uiHints,
          scope: input.scope,
        },
      });

      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("proposalId" in perm) {
        return {
          profile: null as any,
          status: "proposed",
          message: "Profile creation proposed for review",
          proposalId: perm.proposalId,
        };
      }

      // 3. Materialize — inline DB write (auto-approved)
      let userId: string | undefined;
      let workspaceId: string | undefined;

      if (input.scope === "system") {
        userId = undefined;
        workspaceId = undefined;
      } else if (input.scope === "shared") {
        // Shared profiles are owned by the creating workspace
        workspaceId = ctx.workspaceId;
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

      // For shared profiles, grant access to the creating workspace + any extra workspaces
      if (input.scope === "shared") {
        await profileRepo.grantAccess(profile.id, ctx.workspaceId);
        for (const wsId of input.allowedWorkspaceIds ?? []) {
          if (wsId !== ctx.workspaceId) {
            await profileRepo.grantAccess(profile.id, wsId);
          }
        }
      }

      // 4. Emit .completed event + side-effects
      auditLog({
        subjectType: "profile",
        action: "create",
        phase: "completed",
        subjectId: profile.id,
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
        correlationId,
        data: {
          slug: profile.slug,
          displayName: profile.displayName,
          scope: input.scope,
        },
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

  /**
   * Grant a workspace access to a shared profile.
   * Idempotent — safe to call multiple times.
   */
  grantAccess: workspaceProcedure
    .input(
      z.object({
        profileId: z.string().uuid(),
        targetWorkspaceId: z.string().uuid(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      const profileRepo = new ProfileRepository(db);
      const resolutionService = new ProfileResolutionService(db);

      // Verify the profile exists and the calling workspace can see it
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
      if (profile.scope !== "shared") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Only shared profiles can have workspace access grants",
        });
      }
      // Only the workspace that owns the profile can grant access to others
      if (profile.workspaceId !== ctx.workspaceId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message:
            "Only the owning workspace can grant access to a shared profile",
        });
      }

      await profileRepo.grantAccess(input.profileId, input.targetWorkspaceId);

      logger.info(
        {
          profileId: input.profileId,
          targetWorkspaceId: input.targetWorkspaceId,
        },
        "Profile access granted"
      );

      return { success: true };
    }),

  /**
   * Revoke a workspace's access to a shared profile.
   */
  revokeAccess: workspaceProcedure
    .input(
      z.object({
        profileId: z.string().uuid(),
        targetWorkspaceId: z.string().uuid(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      const profileRepo = new ProfileRepository(db);
      const resolutionService = new ProfileResolutionService(db);

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
      if (profile.scope !== "shared") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Only shared profiles can have workspace access revoked",
        });
      }
      if (profile.workspaceId !== ctx.workspaceId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message:
            "Only the owning workspace can revoke access to a shared profile",
        });
      }

      await profileRepo.revokeAccess(input.profileId, input.targetWorkspaceId);

      logger.info(
        {
          profileId: input.profileId,
          targetWorkspaceId: input.targetWorkspaceId,
        },
        "Profile access revoked"
      );

      return { success: true };
    }),
});
