/**
 * Workspaces Router - Multi-user workspace management
 * 
 * Handles:
 * - Workspace CRUD
 * - Member management
 * - Invitation system
 */

import { z } from 'zod';
import { router, protectedProcedure } from '../trpc.js';
import { db, eq, and, desc } from '@synap/database';
import { workspaces, workspaceMembers, workspaceInvites } from '@synap/database/schema';
import { TRPCError } from '@trpc/server';
import { randomBytes } from 'crypto';
import { WorkspaceEvents, WorkspaceMemberEvents } from '../lib/event-helpers.js';

/**
 * Workspace CRUD operations
 */
export const workspacesRouter = router({
  /**
   * Create a new workspace
   */
  create: protectedProcedure
    .input(z.object({
      name: z.string().min(1).max(100),
      description: z.string().optional(),
      type: z.enum(['personal', 'team', 'enterprise']).default('personal'),
    }))
    .mutation(async ({ input, ctx }) => {
      // Log requested event
      await WorkspaceEvents.createRequested(ctx.userId, input);
      
      // Create workspace
      const [workspace] = await db.insert(workspaces).values({
        ownerId: ctx.userId,
        name: input.name,
        description: input.description,
        type: input.type,
        settings: {},
      }).returning();

      // Add creator as owner
      await db.insert(workspaceMembers).values({
        workspaceId: workspace.id,
        userId: ctx.userId,
        role: 'owner',
        invitedBy: ctx.userId,
      });
      
      // Log validated event
      await WorkspaceEvents.createValidated(ctx.userId, {
        id: workspace.id,
        name: workspace.name,
        type: workspace.type,
        ownerId: workspace.ownerId,
      });

      return workspace;
    }),

  /**
   * List user's workspaces
   */
  list: protectedProcedure.query(async ({ ctx }) => {
    const memberships = await db.query.workspaceMembers.findMany({
      where: eq(workspaceMembers.userId, ctx.userId),
      with: {
        workspace: true,
      },
    });

    return memberships.map(m => {
      const workspace = m.workspace!;
      return {
        ...workspace,
        role: m.role,
        joinedAt: m.joinedAt,
      };
    });
  }),

  /**
   * Get workspace details
   */
  get: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ input, ctx }) => {
      const workspace = await db.query.workspaces.findFirst({
        where: eq(workspaces.id, input.id),
      });

      if (!workspace) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Workspace not found' });
      }

      // Check user has access
      const membership = await db.query.workspaceMembers.findFirst({
        where: and(
          eq(workspaceMembers.workspaceId, input.id),
          eq(workspaceMembers.userId, ctx.userId)
        ),
      });

      if (!membership) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Access denied' });
      }

      return { ...workspace, role: membership.role };
    }),

  /**
   * Update workspace
   */
  update: protectedProcedure
    .input(z.object({
      id: z.string().uuid(),
      name: z.string().min(1).max(100).optional(),
      description: z.string().optional(),
      settings: z.record(z.any()).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      // Check user is owner/admin
      const membership = await db.query.workspaceMembers.findFirst({
        where: and(
          eq(workspaceMembers.workspaceId, input.id),
          eq(workspaceMembers.userId, ctx.userId)
        ),
      });

      if (!membership || !['owner', 'admin'].includes(membership.role)) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Only owners/admins can update workspace' });
      }
      
      // Log requested event
      const { id, ...updates } = input;
      await WorkspaceEvents.updateRequested(ctx.userId, input.id, updates);

      const [updated] = await db.update(workspaces)
        .set({
          name: input.name,
          description: input.description,
          settings: input.settings,
          updatedAt: new Date(),
        })
        .where(eq(workspaces.id, input.id))
        .returning();
      
      // Log validated event
      await WorkspaceEvents.updateValidated(ctx.userId, input.id, updates);

      return updated;
    }),

  /**
   * Delete workspace
   */
  delete: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      // Check user is owner
      const workspace = await db.query.workspaces.findFirst({
        where: eq(workspaces.id, input.id),
      });

      if (!workspace) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Workspace not found' });
      }

      if (workspace.ownerId !== ctx.userId) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Only owner can delete workspace' });
      }

      await db.delete(workspaces).where(eq(workspaces.id, input.id));

      return { success: true };
    }),

  /**
   * List workspace members
   */
  listMembers: protectedProcedure
    .input(z.object({ workspaceId: z.string().uuid() }))
    .query(async ({ input, ctx }) => {
      // Check user has access to workspace
      const membership = await db.query.workspaceMembers.findFirst({
        where: and(
          eq(workspaceMembers.workspaceId, input.workspaceId),
          eq(workspaceMembers.userId, ctx.userId)
        ),
      });

      if (!membership) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Access denied' });
      }

      return await db.query.workspaceMembers.findMany({
        where: eq(workspaceMembers.workspaceId, input.workspaceId),
        orderBy: [desc(workspaceMembers.joinedAt)],
      });
    }),

  /**
   * Remove member from workspace
   */
  removeMember: protectedProcedure
    .input(z.object({
      workspaceId: z.string().uuid(),
      userId: z.string(),
    }))
    .mutation(async ({ input, ctx }) => {
      // Check user is owner/admin
      const membership = await db.query.workspaceMembers.findFirst({
        where: and(
          eq(workspaceMembers.workspaceId, input.workspaceId),
          eq(workspaceMembers.userId, ctx.userId)
        ),
      });

      if (!membership || !['owner', 'admin'].includes(membership.role)) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Only owners/admins can remove members' });
      }

      // Can't remove owner
      const targetMember = await db.query.workspaceMembers.findFirst({
        where: and(
          eq(workspaceMembers.workspaceId, input.workspaceId),
          eq(workspaceMembers.userId, input.userId)
        ),
      });

      if (targetMember?.role === 'owner') {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Cannot remove owner' });
      }

      await db.delete(workspaceMembers)
        .where(and(
          eq(workspaceMembers.workspaceId, input.workspaceId),
          eq(workspaceMembers.userId, input.userId)
        ));

      return { success: true };
    }),

  /**
   * Update member role
   */
  updateMemberRole: protectedProcedure
    .input(z.object({
      workspaceId: z.string().uuid(),
      userId: z.string(),
      role: z.enum(['admin', 'editor', 'viewer']),
    }))
    .mutation(async ({ input, ctx }) => {
      // Check user is owner/admin
      const membership = await db.query.workspaceMembers.findFirst({
        where: and(
          eq(workspaceMembers.workspaceId, input.workspaceId),
          eq(workspaceMembers.userId, ctx.userId)
        ),
      });

      if (!membership || !['owner', 'admin'].includes(membership.role)) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Only owners/admins can change roles' });
      }

      await db.update(workspaceMembers)
        .set({ role: input.role })
        .where(and(
          eq(workspaceMembers.workspaceId, input.workspaceId),
          eq(workspaceMembers.userId, input.userId)
        ));

      return { success: true };
    }),

  /**
   * Create invitation
   */
  createInvite: protectedProcedure
    .input(z.object({
      workspaceId: z.string().uuid(),
      email: z.string().email(),
      role: z.enum(['admin', 'editor', 'viewer']),
    }))
    .mutation(async ({ input, ctx }) => {
      // Check user is owner/admin
      const membership = await db.query.workspaceMembers.findFirst({
        where: and(
          eq(workspaceMembers.workspaceId, input.workspaceId),
          eq(workspaceMembers.userId, ctx.userId)
        ),
      });

      if (!membership || !['owner', 'admin'].includes(membership.role)) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Only owners/admins can invite' });
      }
      
      // Log requested event
      await WorkspaceMemberEvents.inviteRequested(ctx.userId, input);

      // Generate token
      const token = randomBytes(32).toString('hex');

      // Create invite
      const [invite] = await db.insert(workspaceInvites).values({
        workspaceId: input.workspaceId,
        email: input.email,
        role: input.role,
        token,
        invitedBy: ctx.userId,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
      }).returning();
      
      // Log validated event (invite created)
      await WorkspaceMemberEvents.inviteValidated(ctx.userId, {
        id: invite.id,
        workspaceId: invite.workspaceId,
        userId: invite.email, // Email as placeholder until accepted
        role: invite.role,
      });

      // TODO: Send email via Inngest job
      // await inngest.send({ name: 'workspace/invite', data: { inviteId: invite.id } });

      return invite;
    }),

  /**
   * List pending invites
   */
  listInvites: protectedProcedure
    .input(z.object({ workspaceId: z.string().uuid() }))
    .query(async ({ input, ctx }) => {
      // Check user has access
      const membership = await db.query.workspaceMembers.findFirst({
        where: and(
          eq(workspaceMembers.workspaceId, input.workspaceId),
          eq(workspaceMembers.userId, ctx.userId)
        ),
      });

      if (!membership) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Access denied' });
      }

      return await db.query.workspaceInvites.findMany({
        where: eq(workspaceInvites.workspaceId, input.workspaceId),
        orderBy: [desc(workspaceInvites.createdAt)],
      });
    }),

  /**
   * Accept invitation
   */
  acceptInvite: protectedProcedure
    .input(z.object({ token: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const invite = await db.query.workspaceInvites.findFirst({
        where: eq(workspaceInvites.token, input.token),
      });

      if (!invite) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Invite not found' });
      }

      if (invite.expiresAt < new Date()) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invite expired' });
      }

      // Add user to workspace
      await db.insert(workspaceMembers).values({
        workspaceId: invite.workspaceId,
        userId: ctx.userId,
        role: invite.role,
        invitedBy: invite.invitedBy,
      });

      // Delete invite
      await db.delete(workspaceInvites).where(eq(workspaceInvites.id, invite.id));

      return { success: true, workspaceId: invite.workspaceId };
    }),

  /**
   * Revoke invitation
   */
  revokeInvite: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      const invite = await db.query.workspaceInvites.findFirst({
        where: eq(workspaceInvites.id, input.id),
      });

      if (!invite) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Invite not found' });
      }

      // Check user is owner/admin
      const membership = await db.query.workspaceMembers.findFirst({
        where: and(
          eq(workspaceMembers.workspaceId, invite.workspaceId),
          eq(workspaceMembers.userId, ctx.userId)
        ),
      });

      if (!membership || !['owner', 'admin'].includes(membership.role)) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Only owners/admins can revoke invites' });
      }

      await db.delete(workspaceInvites).where(eq(workspaceInvites.id, input.id));

      return { success: true };
    }),
});
