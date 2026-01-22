/**
 * Sharing Router - Public links and invitations
 *
 * Handles:
 * - Public link generation
 * - User invitations
 * - Share management
 */

import { z } from "zod";
import { router, protectedProcedure, publicProcedure } from "../trpc.js";
import { db, eq, and, sqlDrizzle } from "@synap/database";
import { resourceShares, views, entities } from "@synap/database/schema";
import { TRPCError } from "@trpc/server";
import { randomBytes } from "crypto";
import { verifyPermission } from "@synap/database";
import { emitRequestEvent } from "../utils/emit-event.js";

export const sharingRouter = router({
  /**
   * Create public link
   */
  createPublicLink: protectedProcedure
    .input(
      z.object({
        resourceType: z.enum(["view", "entity", "document"]),
        resourceId: z.string().uuid(),
        expiresInDays: z.number().min(1).max(365).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // Check user owns resource or has editor permission
      let resource;
      if ((input.resourceType as string) === "view") {
        resource = await db.query.views.findFirst({
          where: eq(views.id, input.resourceId as string),
        });
        if (!resource)
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Resource not found",
          });

        if (!resource.workspaceId) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Resource must belong to a workspace",
          });
        }
        const permResult = await verifyPermission({
          db,
          userId: ctx.userId,
          workspace: { id: resource.workspaceId },
          requiredPermission: "write",
        });
        if (!permResult.allowed)
          throw new TRPCError({
            code: "FORBIDDEN",
            message: permResult.reason || "Insufficient permissions",
          });
      } else if ((input.resourceType as string) === "entity") {
        resource = await db.query.entities.findFirst({
          where: eq(entities.id, input.resourceId as string),
        });
        if (!resource)
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Resource not found",
          });

        if (!resource.workspaceId) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Resource must belong to a workspace",
          });
        }
        const permResult = await verifyPermission({
          db,
          userId: ctx.userId,
          workspace: { id: resource.workspaceId },
          requiredPermission: "write",
        });
        if (!permResult.allowed)
          throw new TRPCError({
            code: "FORBIDDEN",
            message: permResult.reason || "Insufficient permissions",
          });
      }

      // Generate secure token
      const token = randomBytes(16).toString("hex");
      const { randomUUID } = await import("crypto");
      const shareId = randomUUID();

      // Emit event for share creation
      await emitRequestEvent({
        type: "sharing.createPublicLink.requested",
        subjectId: shareId,
        subjectType: "share",
        data: {
          id: shareId,
          resourceType: input.resourceType,
          resourceId: input.resourceId,
          visibility: "public",
          publicToken: token,
          permissions: { read: true },
          expiresAt: input.expiresInDays
            ? new Date(
                Date.now() +
                  (input.expiresInDays as number) * 24 * 60 * 60 * 1000
              )
            : null,
          createdBy: ctx.userId,
          userId: ctx.userId,
        },
        userId: ctx.userId,
      });

      return {
        status: "requested",
        shareId,
        url: `${process.env.APP_URL}/s/${token}`,
      };
    }),

  /**
   * Invite user to resource
   */
  invite: protectedProcedure
    .input(
      z.object({
        resourceType: z.enum(["view", "entity", "document"]),
        resourceId: z.string().uuid(),
        userEmail: z.string().email(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { randomUUID } = await import("crypto");
      const inviteId = randomUUID();

      // Emit event for invitation
      await emitRequestEvent({
        type: "sharing.invite.requested",
        subjectId: inviteId,
        subjectType: "share",
        data: {
          id: inviteId,
          resourceType: input.resourceType,
          resourceId: input.resourceId,
          userEmail: input.userEmail,
          userId: ctx.userId,
        },
        userId: ctx.userId,
      });

      return { status: "requested", inviteId };
    }),

  /**
   * Increment view count (public)
   */
  incrementView: publicProcedure
    .input(
      z.object({
        shareId: z.string().uuid(),
      })
    )
    .mutation(async ({ input }) => {
      await db
        .update(resourceShares)
        .set({
          viewCount: sqlDrizzle`${resourceShares.viewCount} + 1`,
          lastAccessedAt: new Date(),
        })
        .where(eq(resourceShares.id, input.shareId));

      return { success: true };
    }),

  /**
   * Access public resource (no auth required)
   */
  getPublic: publicProcedure
    .input(
      z.object({
        token: z.string(),
      })
    )
    .query(async ({ input }) => {
      // Find share
      const share = await db.query.resourceShares.findFirst({
        where: and(
          eq(resourceShares.publicToken, input.token),
          eq(resourceShares.visibility, "public")
        ),
      });

      if (!share) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }

      // Check expiration
      if (share.expiresAt && share.expiresAt < new Date()) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Link has expired",
        });
      }

      // Fetch resource
      let resource;
      if (share.resourceType === "view") {
        resource = await db.query.views.findFirst({
          where: eq(views.id, share.resourceId),
          with: { document: true },
        });
      } else if (share.resourceType === "entity") {
        resource = await db.query.entities.findFirst({
          where: eq(entities.id, share.resourceId),
        });
      }

      if (!resource) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }

      // Track view
      await db
        .update(resourceShares)
        .set({
          viewCount: sqlDrizzle`${resourceShares.viewCount} + 1`,
          lastAccessedAt: new Date(),
        })
        .where(eq(resourceShares.id, share.id));

      return {
        resource,
        permissions: share.permissions,
      };
    }),

  /**
   * List shares for resource
   */
  list: protectedProcedure
    .input(
      z.object({
        resourceType: z.enum(["view", "entity", "document"]),
        resourceId: z.string().uuid(),
        visibility: z.enum(["public", "private"]).optional(),
        expiresAt: z.date().optional(),
      })
    )
    .query(async ({ input, ctx }) => {
      // Check user owns resource or has viewer permission
      let resource;
      if ((input.resourceType as string) === "view") {
        resource = await db.query.views.findFirst({
          where: eq(views.id, input.resourceId as string),
        });
      } else {
        resource = await db.query.entities.findFirst({
          where: eq(entities.id, input.resourceId as string),
        });
      }

      if (!resource)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Resource not found",
        });

      if (!resource.workspaceId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Resource must belong to a workspace",
        });
      }
      const permResult = await verifyPermission({
        db,
        userId: ctx.userId,
        workspace: { id: resource.workspaceId },
        requiredPermission: "read",
      });
      if (!permResult.allowed)
        throw new TRPCError({
          code: "FORBIDDEN",
          message: permResult.reason || "Insufficient permissions",
        });

      return await db.query.resourceShares.findMany({
        where: and(
          eq(resourceShares.resourceType, input.resourceType as string),
          eq(resourceShares.resourceId, input.resourceId as string)
        ),
      });
    }),

  /**
   * Revoke share
   */
  revoke: protectedProcedure
    .input(
      z.object({
        shareId: z.string().uuid(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Check user owns the shared resource
      const share = await db.query.resourceShares.findFirst({
        where: eq(resourceShares.id, input.shareId),
      });

      if (!share) throw new TRPCError({ code: "NOT_FOUND" });

      // Load resource to check ownership
      let resource;
      if (share.resourceType === "view") {
        resource = await db.query.views.findFirst({
          where: eq(views.id, share.resourceId),
        });
      } else {
        resource = await db.query.entities.findFirst({
          where: eq(entities.id, share.resourceId),
        });
      }

      if (!resource)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Resource not found",
        });

      if (!resource.workspaceId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Resource must belong to a workspace",
        });
      }
      const permResult = await verifyPermission({
        db,
        userId: ctx.userId,
        workspace: { id: resource.workspaceId },
        requiredPermission: "write",
      });
      if (!permResult.allowed)
        throw new TRPCError({
          code: "FORBIDDEN",
          message: permResult.reason || "Insufficient permissions",
        });

      // Emit event for share revocation
      await emitRequestEvent({
        type: "sharing.revoke.requested",
        subjectId: input.shareId,
        subjectType: "share",
        data: {
          shareId: input.shareId,
          userId: ctx.userId,
        },
        userId: ctx.userId,
      });

      return { status: "requested" };
    }),
});
