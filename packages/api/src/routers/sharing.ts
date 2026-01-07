
/**
 * Sharing Router - Public links and invitations
 * 
 * Handles:
 * - Public link generation
 * - User invitations
 * - Share management
 */

import { z } from 'zod';
import { router, protectedProcedure, publicProcedure } from '../trpc.js';
import { db, eq, and, sqlDrizzle } from '@synap/database';
import { resourceShares, views, entities, insertResourceShareSchema } from '@synap/database/schema';
import { TRPCError } from '@trpc/server';
import { randomBytes } from 'crypto';
import { requireEditor, requireViewer, requireResourceOwner } from '../utils/workspace-permissions.js';

export const sharingRouter = router({
  /**
   * Create public link
   */
  createPublicLink: protectedProcedure
    .input(
      insertResourceShareSchema.pick({
        resourceType: true,
        resourceId: true,
      }).extend({
        expiresInDays: z.number().min(1).max(365).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // Check user owns resource or has editor permission
      let resource;
      if (input.resourceType === 'view') {
        resource = await db.query.views.findFirst({
          where: eq(views.id, input.resourceId),
        });
        if (!resource) throw new TRPCError({ code: 'NOT_FOUND', message: 'Resource not found' });
        
        if (resource.workspaceId) {
          await requireEditor(db, resource.workspaceId, ctx.userId);
        } else {
          requireResourceOwner(resource, ctx.userId);
        }
      } else if (input.resourceType === 'entity') {
        resource = await db.query.entities.findFirst({
          where: eq(entities.id, input.resourceId),
        });
        if (!resource) throw new TRPCError({ code: 'NOT_FOUND', message: 'Resource not found' });
        
        if (resource.workspaceId) {
          await requireEditor(db, resource.workspaceId, ctx.userId);
        } else {
          requireResourceOwner(resource, ctx.userId);
        }
      }
      
      // Generate secure token
      const token = randomBytes(16).toString('hex');
      
      // Create share
      const [share] = await db.insert(resourceShares).values({
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        visibility: 'public',
        publicToken: token,
        permissions: { read: true },
        expiresAt: input.expiresInDays 
          ? new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000)
          : null,
        createdBy: ctx.userId,
      }).returning();
      
      return {
        share,
        url: `${process.env.APP_URL}/s/${token}`,
      };
    }),
    
  /**
   * Invite user to resource
   */
  invite: protectedProcedure
    .input(
      insertResourceShareSchema.pick({
        resourceType: true,
        resourceId: true,
      }).extend({
        userEmail: z.string().email(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // Get or create share
      let share = await db.query.resourceShares.findFirst({
        where: and(
          eq(resourceShares.resourceType, input.resourceType),
          eq(resourceShares.resourceId, input.resourceId)
        ),
      });
      
      if (!share) {
        [share] = await db.insert(resourceShares).values({
          resourceType: input.resourceType,
          resourceId: input.resourceId,
          visibility: 'invite_only',
          permissions: { read: true },
          createdBy: ctx.userId,
        }).returning();
      }
      
      // Add user to invited list
      await db.update(resourceShares)
        .set({
          invitedUsers: sqlDrizzle`array_append(${resourceShares.invitedUsers}, ${input.userEmail})`,
          updatedAt: new Date(),
        })
        .where(and(
          eq(resourceShares.resourceId, input.resourceId),
          eq(resourceShares.resourceType, input.resourceType)
        ));
      
      // TODO: Send email notification
      
      return { success: true };
    }),

  /**
   * Increment view count (public)
   */
  incrementView: publicProcedure
    .input(z.object({
      shareId: z.string().uuid(),
    }))
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
    .input(z.object({
      token: z.string(),
    }))
    .query(async ({ input }) => {
      // Find share
      const share = await db.query.resourceShares.findFirst({
        where: and(
          eq(resourceShares.publicToken, input.token),
          eq(resourceShares.visibility, 'public')
        ),
      });
      
      if (!share) {
        throw new TRPCError({ code: 'NOT_FOUND' });
      }
      
      // Check expiration
      if (share.expiresAt && share.expiresAt < new Date()) {
        throw new TRPCError({ 
          code: 'FORBIDDEN',
          message: 'Link has expired'
        });
      }
      
      // Fetch resource
      let resource;
      if (share.resourceType === 'view') {
        resource = await db.query.views.findFirst({
          where: eq(views.id, share.resourceId),
          with: { document: true },
        });
      } else if (share.resourceType === 'entity') {
        resource = await db.query.entities.findFirst({
          where: eq(entities.id, share.resourceId),
        });
      }
      
      if (!resource) {
        throw new TRPCError({ code: 'NOT_FOUND' });
      }
      
      // Track view
      await db.update(resourceShares)
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
    .input(insertResourceShareSchema.pick({
      resourceType: true,
      resourceId: true,
      visibility: true,
      expiresAt: true,
    }))
    .query(async ({ input, ctx }) => {
      // Check user owns resource or has viewer permission
      let resource;
      if (input.resourceType === 'view') {
        resource = await db.query.views.findFirst({
          where: eq(views.id, input.resourceId),
        });
      } else {
        resource = await db.query.entities.findFirst({
          where: eq(entities.id, input.resourceId),
        });
      }
      
      if (!resource) throw new TRPCError({ code: 'NOT_FOUND', message: 'Resource not found' });
      
      if (resource.workspaceId) {
        await requireViewer(db, resource.workspaceId, ctx.userId);
      } else {
        requireResourceOwner(resource, ctx.userId);
      }
      
      return await db.query.resourceShares.findMany({
        where: and(
          eq(resourceShares.resourceType, input.resourceType),
          eq(resourceShares.resourceId, input.resourceId)
        ),
      });
    }),
    
  /**
   * Revoke share
   */
  revoke: protectedProcedure
    .input(z.object({
      shareId: z.string().uuid(),
    }))
    .mutation(async ({ input, ctx }) => {
      // Check user owns the shared resource
      const share = await db.query.resourceShares.findFirst({
        where: eq(resourceShares.id, input.shareId),
      });
      
      if (!share) throw new TRPCError({ code: 'NOT_FOUND' });
      
      // Load resource to check ownership
      let resource;
      if (share.resourceType === 'view') {
        resource = await db.query.views.findFirst({ where: eq(views.id, share.resourceId) });
      } else {
        resource = await db.query.entities.findFirst({ where: eq(entities.id, share.resourceId) });
      }
      
      if (!resource) throw new TRPCError({ code: 'NOT_FOUND', message: 'Resource not found' });
      
      if (resource.workspaceId) {
        await requireEditor(db, resource.workspaceId, ctx.userId);
      } else {
        requireResourceOwner(resource, ctx.userId);
      }
      
      await db.delete(resourceShares)
        .where(eq(resourceShares.id, input.shareId));
      
      return { success: true };
    }),
});

