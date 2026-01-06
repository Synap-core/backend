import { z } from 'zod';
import { router, protectedProcedure } from '../trpc.js';
import {
  TemplateConfigSchema,
  TemplateTargetTypeSchema,
} from '@synap-core/types';
import { and, eq, or } from '@synap/database';
import { entityTemplates } from '@synap/database';

export const templatesRouter = router({
  // List templates (user's + workspace's)
  list: protectedProcedure
    .input(z.object({
      targetType: TemplateTargetTypeSchema.optional(),
      entityType: z.string().optional(),
      inboxItemType: z.string().optional(),
      workspaceId: z.string().uuid().optional(),
      includePublic: z.boolean().default(false),
    }))
    .query(async ({ ctx, input }) => {
      const conditions = [
        or(
          eq(entityTemplates.userId, ctx.user.id),
          input.workspaceId ? eq(entityTemplates.workspaceId, input.workspaceId) : undefined,
          input.includePublic ? eq(entityTemplates.isPublic, true) : undefined
        ),
        input.targetType ? eq(entityTemplates.targetType, input.targetType) : undefined,
        input.entityType ? eq(entityTemplates.entityType, input.entityType) : undefined,
        input.inboxItemType ? eq(entityTemplates.inboxItemType, input.inboxItemType) : undefined,
      ].filter((c): c is any => c !== undefined);

      const templates = await ctx.db.select().from(entityTemplates)
        .where(and(...conditions));
        // .orderBy(desc(entityTemplates.isDefault), desc(entityTemplates.createdAt)); // Need to import desc

      return templates;
    }),

  // Get default template (with resolution: user > workspace > default)
  getDefault: protectedProcedure
    .input(z.object({
      targetType: TemplateTargetTypeSchema,
      entityType: z.string().optional(),
      inboxItemType: z.string().optional(),
      workspaceId: z.string().uuid().optional(),
    }))
    .query(async ({ ctx, input }) => {
      // 1. Try user template
      const userTemplate = await ctx.db.query.entityTemplates.findFirst({
        where: and(
          eq(entityTemplates.userId, ctx.user.id),
          eq(entityTemplates.targetType, input.targetType),
          input.entityType ? eq(entityTemplates.entityType, input.entityType) : undefined,
          input.inboxItemType ? eq(entityTemplates.inboxItemType, input.inboxItemType) : undefined,
          eq(entityTemplates.isDefault, true)
        ),
      });

      if (userTemplate) return userTemplate.config;

      // 2. Try workspace template
      if (input.workspaceId) {
        const workspaceTemplate = await ctx.db.query.entityTemplates.findFirst({
          where: and(
            eq(entityTemplates.workspaceId, input.workspaceId),
            eq(entityTemplates.targetType, input.targetType),
            input.entityType ? eq(entityTemplates.entityType, input.entityType) : undefined,
            input.inboxItemType ? eq(entityTemplates.inboxItemType, input.inboxItemType) : undefined,
            eq(entityTemplates.isDefault, true)
          ),
        });

        if (workspaceTemplate) return workspaceTemplate.config;
      }

      // 3. Return empty config (system default)
      return {};
    }),

  // Create template
  create: protectedProcedure
    .input(z.object({
      name: z.string().min(1),
      description: z.string().optional(),
      targetType: TemplateTargetTypeSchema,
      entityType: z.string().optional(),
      inboxItemType: z.string().optional(),
      config: TemplateConfigSchema,
      isDefault: z.boolean().default(false),
      isPublic: z.boolean().default(false),
      workspaceId: z.string().uuid().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      // If setting as default, unset previous default
      if (input.isDefault) {
        const conditions = [
          input.workspaceId 
            ? eq(entityTemplates.workspaceId, input.workspaceId)
            : eq(entityTemplates.userId, ctx.user.id),
          eq(entityTemplates.targetType, input.targetType),
          input.entityType ? eq(entityTemplates.entityType, input.entityType) : undefined,
          input.inboxItemType ? eq(entityTemplates.inboxItemType, input.inboxItemType) : undefined,
          eq(entityTemplates.isDefault, true),
        ].filter((c): c is any => c !== undefined);

        await ctx.db.update(entityTemplates)
          .set({ isDefault: false })
          .where(and(...conditions));
      }

      const [template] = await ctx.db.insert(entityTemplates).values({
        userId: input.workspaceId ? null : ctx.user.id,
        workspaceId: input.workspaceId || null,
        name: input.name,
        description: input.description || null,
        targetType: input.targetType,
        entityType: input.entityType || null,
        inboxItemType: input.inboxItemType || null,
        config: input.config as any, // Type cast for jsonb
        isDefault: input.isDefault,
        isPublic: input.isPublic,
        version: 1,
      }).returning();

      return template;
    }),

  // Update template
  update: protectedProcedure
    .input(z.object({
      id: z.string().uuid(),
      name: z.string().min(1).optional(),
      description: z.string().optional(),
      config: TemplateConfigSchema.optional(),
      isDefault: z.boolean().optional(),
      isPublic: z.boolean().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const { id, ...updates } = input;

      // Verify ownership
      const existing = await ctx.db.query.entityTemplates.findFirst({
        where: eq(entityTemplates.id, id),
      });

      if (!existing) throw new Error('Template not found');
      // Simple ownership check: if user_id matches, or if workspace matches (assuming user is in workspace for now)
      // TODO: Better workspace permission check
      if (existing.userId && existing.userId !== ctx.user.id) {
        throw new Error('Unauthorized');
      }

      // If setting as default, unset previous default
      if (updates.isDefault) {
        const conditions = [
          existing.workspaceId
            ? eq(entityTemplates.workspaceId, existing.workspaceId)
            : eq(entityTemplates.userId, ctx.user.id),
          eq(entityTemplates.targetType, existing.targetType),
          existing.entityType ? eq(entityTemplates.entityType, existing.entityType) : undefined,
          existing.inboxItemType ? eq(entityTemplates.inboxItemType, existing.inboxItemType) : undefined,
          eq(entityTemplates.isDefault, true),
        ].filter((c): c is any => c !== undefined);

        await ctx.db.update(entityTemplates)
          .set({ isDefault: false })
          .where(and(...conditions));
      }

      const [template] = await ctx.db.update(entityTemplates)
        .set({ ...updates, updatedAt: new Date(), config: updates.config as any })
        .where(eq(entityTemplates.id, id))
        .returning();

      return template;
    }),

  // Delete template
  delete: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db.delete(entityTemplates)
        .where(and(
          eq(entityTemplates.id, input.id),
          or(
            eq(entityTemplates.userId, ctx.user.id),
            // TODO: Check workspace permission
          )
        ));

      return { success: true };
    }),

  // Duplicate template
  duplicate: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const original = await ctx.db.query.entityTemplates.findFirst({
        where: eq(entityTemplates.id, input.id),
      });

      if (!original) throw new Error('Template not found');

      const [template] = await ctx.db.insert(entityTemplates).values({
        userId: ctx.user.id, // Duplicates always owned by user initially? Or same scope? Let's default to user
        workspaceId: null, // Copy to personal space by default? Or same workspace? 
        // Let's copy to same scope strictly if user owns it, but what if user duplicates public template?
        // Safe bet: Copy to current user's personal scope
        name: `${original.name} (Copy)`,
        description: original.description,
        targetType: original.targetType,
        entityType: original.entityType,
        inboxItemType: original.inboxItemType,
        config: original.config,
        isDefault: false,
        isPublic: false,
        version: 1,
      }).returning();

      return template;
    }),

  // Set as default
  setDefault: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const template = await ctx.db.query.entityTemplates.findFirst({
        where: eq(entityTemplates.id, input.id),
      });

      if (!template) throw new Error('Template not found');

      // Unset previous default
      const conditions = [
        template.workspaceId
          ? eq(entityTemplates.workspaceId, template.workspaceId)
          : eq(entityTemplates.userId, ctx.user.id),
        eq(entityTemplates.targetType, template.targetType),
        template.entityType ? eq(entityTemplates.entityType, template.entityType) : undefined,
        template.inboxItemType ? eq(entityTemplates.inboxItemType, template.inboxItemType) : undefined,
        eq(entityTemplates.isDefault, true),
      ].filter((c): c is any => c !== undefined);

      await ctx.db.update(entityTemplates)
        .set({ isDefault: false })
        .where(and(...conditions));

      // Set new default
      await ctx.db.update(entityTemplates)
        .set({ isDefault: true })
        .where(eq(entityTemplates.id, input.id));

      return { success: true };
    }),
});
