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
import { db, eq, and, or, inArray, sqlDrizzle } from "@synap/database";
import {
  resourceShares,
  views,
  entities,
  documents,
} from "@synap/database/schema";
import { TRPCError } from "@trpc/server";
import { verifyPermission } from "@synap/database";
import { emitRequestEvent } from "../utils/emit-event.js";
import {
  generateShareToken,
  hashToken,
  hashPassword,
  verifyPassword,
} from "../utils/share-token.js";

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
        access: z.enum(["workspace_only", "anyone_with_link"]).optional(),
        password: z.string().min(1).optional(),
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

      const token = generateShareToken();
      const tokenHash = hashToken(token);
      const { randomUUID } = await import("crypto");
      const shareId = randomUUID();
      const expiresAt = input.expiresInDays
        ? new Date(
            Date.now() + (input.expiresInDays as number) * 24 * 60 * 60 * 1000
          )
        : null;
      const passwordHash = input.password ? hashPassword(input.password) : null;

      await emitRequestEvent({
        subjectType: "sharing",
        action: "create",
        subjectId: shareId,
        data: {
          id: shareId,
          resourceType: input.resourceType,
          resourceId: input.resourceId,
          visibility: "public",
          publicToken: token,
          tokenHash,
          permission: "view",
          expiresAt,
          access: input.access ?? "anyone_with_link",
          passwordHash,
          sharedByUserId: ctx.userId,
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
        subjectType: "sharing",
        action: "create",
        subjectId: inviteId,
        data: {
          id: inviteId,
          resourceType: input.resourceType,
          resourceId: input.resourceId,
          sharedWithEmail: input.userEmail,
          permission: "view",
          sharedByUserId: ctx.userId,
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
        password: z.string().optional(),
      })
    )
    .query(async ({ input }) => {
      const tokenHash = hashToken(input.token);
      const shares = await db.query.resourceShares.findMany({
        where: and(eq(resourceShares.visibility, "public")),
      });
      const share = shares.find(
        (s) => s.tokenHash === tokenHash || s.publicToken === input.token
      );

      if (!share) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }

      if (share.revokedAt) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Link has been revoked",
        });
      }

      if (share.expiresAt && share.expiresAt < new Date()) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Link has expired",
        });
      }

      if (share.passwordHash) {
        if (!input.password) {
          throw new TRPCError({
            code: "UNAUTHORIZED",
            message: "Password required",
          });
        }
        if (!verifyPassword(input.password, share.passwordHash)) {
          throw new TRPCError({
            code: "UNAUTHORIZED",
            message: "Invalid password",
          });
        }
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
        resourceType: share.resourceType,
        permissions: share.permissions,
      };
    }),

  /**
   * List all active (non-revoked) shares for the current workspace.
   * Used by Settings > Sharing to show "what I've shared".
   */
  listByWorkspace: protectedProcedure
    .input(z.object({ workspaceId: z.string().uuid() }))
    .query(async ({ input, ctx }) => {
      const permResult = await verifyPermission({
        db,
        userId: ctx.userId,
        workspace: { id: input.workspaceId },
        requiredPermission: "read",
      });
      if (!permResult.allowed)
        throw new TRPCError({
          code: "FORBIDDEN",
          message: permResult.reason || "Insufficient permissions",
        });

      const [viewRows, entityRows, documentRows] = await Promise.all([
        db.query.views.findMany({
          where: eq(views.workspaceId, input.workspaceId),
          columns: { id: true, name: true },
        }),
        db.query.entities.findMany({
          where: eq(entities.workspaceId, input.workspaceId),
          columns: { id: true, title: true },
        }),
        db.query.documents.findMany({
          where: eq(documents.workspaceId, input.workspaceId),
          columns: { id: true, title: true },
        }),
      ]);

      const viewIds = viewRows.map((r) => r.id);
      const entityIds = entityRows.map((r) => r.id);
      const documentIds = documentRows.map((r) => r.id);

      if (
        viewIds.length === 0 &&
        entityIds.length === 0 &&
        documentIds.length === 0
      ) {
        return { shares: [], resourceLabels: {} };
      }

      const conditions: ReturnType<typeof and>[] = [];
      if (viewIds.length)
        conditions.push(
          and(
            eq(resourceShares.resourceType, "view"),
            inArray(resourceShares.resourceId, viewIds)
          )
        );
      if (entityIds.length)
        conditions.push(
          and(
            eq(resourceShares.resourceType, "entity"),
            inArray(resourceShares.resourceId, entityIds)
          )
        );
      if (documentIds.length)
        conditions.push(
          and(
            eq(resourceShares.resourceType, "document"),
            inArray(resourceShares.resourceId, documentIds)
          )
        );

      const allShares = await db.query.resourceShares.findMany({
        where: or(...conditions),
      });

      const active = allShares.filter((s) => !s.revokedAt);

      const resourceLabels: Record<string, string> = {};
      viewRows.forEach((r) => {
        resourceLabels[`view:${r.id}`] = r.name ?? "View";
      });
      entityRows.forEach((r) => {
        resourceLabels[`entity:${r.id}`] = r.title ?? "Entity";
      });
      documentRows.forEach((r) => {
        resourceLabels[`document:${r.id}`] = r.title ?? "Document";
      });

      return {
        shares: active,
        resourceLabels,
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

      const all = await db.query.resourceShares.findMany({
        where: and(
          eq(resourceShares.resourceType, input.resourceType as string),
          eq(resourceShares.resourceId, input.resourceId as string)
        ),
      });
      return all.filter((s) => !s.revokedAt);
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

      await db
        .update(resourceShares)
        .set({ revokedAt: new Date() })
        .where(eq(resourceShares.id, input.shareId));

      return { status: "revoked" };
    }),

  /**
   * Extend share link expiry
   */
  extendShareLink: protectedProcedure
    .input(
      z.object({
        shareId: z.string().uuid(),
        expiresInDays: z.number().min(1).max(365),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const share = await db.query.resourceShares.findFirst({
        where: eq(resourceShares.id, input.shareId),
      });
      if (!share) throw new TRPCError({ code: "NOT_FOUND" });

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
      if (!resource?.workspaceId) throw new TRPCError({ code: "NOT_FOUND" });

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

      const expiresAt = new Date(
        Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000
      );
      await db
        .update(resourceShares)
        .set({ expiresAt, revokedAt: null })
        .where(eq(resourceShares.id, input.shareId));

      return { status: "extended", expiresAt };
    }),

  /**
   * Rotate share link token - generates new token, invalidates old
   */
  rotateShareLinkToken: protectedProcedure
    .input(z.object({ shareId: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      const share = await db.query.resourceShares.findFirst({
        where: eq(resourceShares.id, input.shareId),
      });
      if (!share) throw new TRPCError({ code: "NOT_FOUND" });

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
      if (!resource?.workspaceId) throw new TRPCError({ code: "NOT_FOUND" });

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

      const token = generateShareToken();
      const tokenHash = hashToken(token);
      await db
        .update(resourceShares)
        .set({ tokenHash, publicToken: null })
        .where(eq(resourceShares.id, input.shareId));

      return {
        status: "rotated",
        url: `${process.env.APP_URL}/s/${token}`,
      };
    }),
});
