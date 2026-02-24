/**
 * Profile Relations Router - Profile-to-Profile Linking API
 *
 * Handles linking profiles to each other via relation definitions.
 * Defines which entity types can connect (e.g., contact → company via "works_at").
 */

import { z } from "zod";
import { router, workspaceProcedure } from "../trpc.js";
import {
  getDb,
  ProfileRelationRepository,
  RelationDefRepository,
  ProfileResolutionService,
} from "@synap/database";
import { TRPCError } from "@trpc/server";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "profile-relations-router" });

export const profileRelationsRouter = router({
  /**
   * Link two profiles via a relation definition
   */
  link: workspaceProcedure
    .input(
      z.object({
        sourceProfileId: z.string().uuid(),
        targetProfileId: z.string().uuid(),
        relationDefId: z.string().uuid(),
        displayOrder: z.number().int().default(0),
        metadata: z.record(z.string(), z.unknown()).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      const resolutionService = new ProfileResolutionService(db);
      const relDefRepo = new RelationDefRepository(db);
      const profileRelRepo = new ProfileRelationRepository(db);

      // Verify both profiles are accessible in this workspace
      const [sourceProfile, targetProfile] = await Promise.all([
        resolutionService.resolveProfile(
          input.sourceProfileId,
          ctx.userId,
          ctx.workspaceId
        ),
        resolutionService.resolveProfile(
          input.targetProfileId,
          ctx.userId,
          ctx.workspaceId
        ),
      ]);

      if (!sourceProfile) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Source profile not found: ${input.sourceProfileId}`,
        });
      }
      if (!targetProfile) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Target profile not found: ${input.targetProfileId}`,
        });
      }

      // Verify relation definition exists in this workspace
      const allDefs = await relDefRepo.list(ctx.workspaceId);
      const defExists = allDefs.some(
        (d: { id: string }) => d.id === input.relationDefId
      );
      if (!defExists) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Relation definition not found: ${input.relationDefId}`,
        });
      }

      const link = await profileRelRepo.link({
        sourceProfileId: input.sourceProfileId,
        targetProfileId: input.targetProfileId,
        relationDefId: input.relationDefId,
        displayOrder: input.displayOrder,
        metadata: input.metadata,
      });

      logger.info(
        {
          sourceProfileId: input.sourceProfileId,
          targetProfileId: input.targetProfileId,
          relationDefId: input.relationDefId,
          userId: ctx.userId,
        },
        "Profile relation linked"
      );

      return { link };
    }),

  /**
   * Unlink two profiles (owner/admin only)
   */
  unlink: workspaceProcedure
    .input(
      z.object({
        sourceProfileId: z.string().uuid(),
        targetProfileId: z.string().uuid(),
        relationDefId: z.string().uuid(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      if (!["owner", "admin"].includes(ctx.workspaceRole)) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Only workspace owners/admins can unlink profile relations",
        });
      }

      const db = await getDb();
      const profileRelRepo = new ProfileRelationRepository(db);
      await profileRelRepo.unlink(
        input.sourceProfileId,
        input.targetProfileId,
        input.relationDefId
      );

      logger.info(
        {
          sourceProfileId: input.sourceProfileId,
          targetProfileId: input.targetProfileId,
          relationDefId: input.relationDefId,
          userId: ctx.userId,
        },
        "Profile relation unlinked"
      );

      return { success: true };
    }),

  /**
   * Get all profile relations for a specific profile
   */
  getByProfile: workspaceProcedure
    .input(z.object({ profileId: z.string().uuid() }))
    .query(async ({ input, ctx }) => {
      const db = await getDb();
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

      const profileRelRepo = new ProfileRelationRepository(db);
      const relations = await profileRelRepo.getByProfile(input.profileId);

      return { relations };
    }),
});
