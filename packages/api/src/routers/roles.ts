/**
 * Roles Router - Custom role management
 * 
 * Allows workspace admins/owners to create custom roles with:
 * - Fine-grained permissions (RBAC)
 * - Attribute filters (ABAC)
 */

import { z } from 'zod';
import { router, protectedProcedure } from '../trpc.js';
import { db, eq, and, or, isNull } from '@synap/database';
import { roles, workspaceMembers } from '@synap/database/schema';
import { TRPCError } from '@trpc/server';

const PermissionsSchema = z.object({
  entities: z.object({
    create: z.boolean().default(false),
    read: z.boolean().default(true),
    update: z.boolean().default(false),
    delete: z.boolean().default(false),
  }).optional(),
  views: z.object({
    create: z.boolean().default(false),
    read: z.boolean().default(true),
    update: z.boolean().default(false),
    delete: z.boolean().default(false),
  }).optional(),
  workspaces: z.object({
    read: z.boolean().default(true),
    update: z.boolean().default(false),
    delete: z.boolean().default(false),
  }).optional(),
  relations: z.object({
    create: z.boolean().default(false),
    read: z.boolean().default(true),
    update: z.boolean().default(false),
    delete: z.boolean().default(false),
  }).optional(),
});

export const rolesRouter = router({
  /**
   * List roles available in workspace (including system roles)
   */
  list: protectedProcedure
    .input(z.object({
      workspaceId: z.string().uuid(),
    }))
    .query(async ({ ctx, input }) => {
      // Check user has access to workspace
      const member = await db.query.workspaceMembers.findFirst({
        where: and(
          eq(workspaceMembers.workspaceId, input.workspaceId),
          eq(workspaceMembers.userId, ctx.userId)
        ),
      });
      
      if (!member) {
        throw new TRPCError({ code: 'FORBIDDEN' });
      }
      
      // Get workspace-specific + system roles
      return await db.query.roles.findMany({
        where: or(
          eq(roles.workspaceId, input.workspaceId),
          isNull(roles.workspaceId) // System roles
        ),
        orderBy: (roles, { asc }) => [asc(roles.name)],
      });
    }),
    
  /**
   * Create custom role (admin/owner only)
   */
  create: protectedProcedure
    .input(z.object({
      workspaceId: z.string().uuid(),
      name: z.string().min(1).max(50),
      description: z.string().optional(),
      permissions: PermissionsSchema,
      filters: z.record(z.any()).optional(),
      // Example filters: {"entity.type": ["task"], "entity.metadata.category": ["dev"]}
    }))
    .mutation(async ({ ctx, input }) => {
      // Check user is admin/owner
      const member = await db.query.workspaceMembers.findFirst({
        where: and(
          eq(workspaceMembers.workspaceId, input.workspaceId),
          eq(workspaceMembers.userId, ctx.userId)
        ),
      });
      
      if (!member || !['owner', 'admin'].includes(member.role)) {
        throw new TRPCError({ 
          code: 'FORBIDDEN',
          message: 'Only owners/admins can create roles'
        });
      }
      
      // Create role
      const [role] = await db.insert(roles).values({
        name: input.name,
        description: input.description,
        workspaceId: input.workspaceId,
        permissions: input.permissions as any,
        filters: input.filters || {},
        createdBy: ctx.userId,
      }).returning();
      
      return role;
    }),
    
  /**
   * Update custom role
   */
  update: protectedProcedure
    .input(z.object({
      roleId: z.string().uuid(),
      name: z.string().min(1).max(50).optional(),
      description: z.string().optional(),
      permissions: PermissionsSchema.optional(),
      filters: z.record(z.any()).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      // Get role
      const role = await db.query.roles.findFirst({
        where: eq(roles.id, input.roleId),
      });
      
      if (!role) {
        throw new TRPCError({ code: 'NOT_FOUND' });
      }
      
      // Cannot update system roles
      if (!role.workspaceId) {
        throw new TRPCError({ 
          code: 'FORBIDDEN',
          message: 'Cannot update system roles'
        });
      }
      
      // Check user is admin/owner of workspace
      const member = await db.query.workspaceMembers.findFirst({
        where: and(
          eq(workspaceMembers.workspaceId, role.workspaceId),
          eq(workspaceMembers.userId, ctx.userId)
        ),
      });
      
      if (!member || !['owner', 'admin'].includes(member.role)) {
        throw new TRPCError({ code: 'FORBIDDEN' });
      }
      
      // Update
      const [updated] = await db.update(roles)
        .set({
          name: input.name,
          description: input.description,
          permissions: input.permissions as any,
          filters: input.filters,
          updatedAt: new Date(),
        })
        .where(eq(roles.id, input.roleId))
        .returning();
      
      return updated;
    }),
    
  /**
   * Delete custom role
   */
  delete: protectedProcedure
    .input(z.object({
      roleId: z.string().uuid(),
    }))
    .mutation(async ({ ctx, input }) => {
      // Get role
      const role = await db.query.roles.findFirst({
        where: eq(roles.id, input.roleId),
      });
      
      if (!role || !role.workspaceId) {
        throw new TRPCError({ 
          code: 'FORBIDDEN',
          message: 'Cannot delete system roles'
        });
      }
      
      // Check user is owner
      const member = await db.query.workspaceMembers.findFirst({
        where: and(
          eq(workspaceMembers.workspaceId, role.workspaceId),
          eq(workspaceMembers.userId, ctx.userId)
        ),
      });
      
      if (!member || member.role !== 'owner') {
        throw new TRPCError({ code: 'FORBIDDEN' });
      }
      
      // Delete
      await db.delete(roles).where(eq(roles.id, input.roleId));
      
      return { success: true };
    }),
});
