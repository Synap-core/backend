/**
 * Entity Templates Router
 *
 * Handles management of entity templates used for:
 * - Creating new entities (documents, projects, etc.)
 * - Configuring default properties
 * - Managing template scope (user vs workspace)
 */

import { z } from "zod";
import { router, protectedProcedure } from "../trpc.js";
import {
  TemplateConfigSchema,
  TemplateTargetTypeSchema,
} from "@synap-core/types";
import {
  db,
  eq,
  and,
  desc,
  or,
  type SQL,
  entityTemplates,
  verifyPermission,
} from "@synap/database";
import { TRPCError } from "@trpc/server";
import { emitRequestEvent } from "../utils/emit-event.js";

export const templatesRouter = router({
  // List templates (user's + workspace's)
  list: protectedProcedure
    .input(
      z.object({
        targetType: TemplateTargetTypeSchema.optional(),
        entityType: z.string().optional(),
        inboxItemType: z.string().optional(),
        workspaceId: z.string().uuid().optional(),
        includePublic: z.boolean().default(false),
      })
    )
    .query(async ({ ctx, input }) => {
      // Build conditions for visibility (User's OR Workspace's OR Public)
      const visibilityConditions = [
        eq(entityTemplates.userId, ctx.userId),
        input.workspaceId
          ? eq(entityTemplates.workspaceId, input.workspaceId)
          : undefined,
        input.includePublic ? eq(entityTemplates.isPublic, true) : undefined,
      ].filter((c): c is NonNullable<typeof c> => c !== undefined);

      const conditions = [
        or(...visibilityConditions),
        input.targetType
          ? eq(entityTemplates.targetType, input.targetType as string)
          : undefined,
        input.entityType
          ? eq(entityTemplates.entityType, input.entityType)
          : undefined,
        input.inboxItemType
          ? eq(entityTemplates.inboxItemType, input.inboxItemType)
          : undefined,
      ].filter((c): c is NonNullable<typeof c> => c !== undefined);

      const templates = await db
        .select()
        .from(entityTemplates)
        .where(and(...conditions))
        .orderBy(
          desc(entityTemplates.isDefault),
          desc(entityTemplates.createdAt)
        );

      return templates;
    }),

  // Get default template (with resolution: user > workspace > default)
  getDefault: protectedProcedure
    .input(
      z.object({
        targetType: TemplateTargetTypeSchema,
        entityType: z.string().optional(),
        inboxItemType: z.string().optional(),
        workspaceId: z.string().uuid().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      // 1. Try user template
      const userTemplate = await db.query.entityTemplates.findFirst({
        where: and(
          eq(entityTemplates.userId, ctx.userId),
          eq(entityTemplates.targetType, input.targetType as string),
          input.entityType
            ? eq(entityTemplates.entityType, input.entityType)
            : undefined,
          input.inboxItemType
            ? eq(entityTemplates.inboxItemType, input.inboxItemType)
            : undefined,
          eq(entityTemplates.isDefault, true)
        ),
      });

      if (userTemplate) return userTemplate.config;

      // 2. Try workspace template
      if (input.workspaceId) {
        const workspaceTemplate = await db.query.entityTemplates.findFirst({
          where: and(
            eq(entityTemplates.workspaceId, input.workspaceId),
            eq(entityTemplates.targetType, input.targetType as string),
            input.entityType
              ? eq(entityTemplates.entityType, input.entityType)
              : undefined,
            input.inboxItemType
              ? eq(entityTemplates.inboxItemType, input.inboxItemType)
              : undefined,
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
    .input(
      z
        .object({
          name: z.string(),
          description: z.string().optional(),
          workspaceId: z.string().uuid().optional(),
          isDefault: z.boolean().optional(),
          isPublic: z.boolean().optional(),
          targetType: TemplateTargetTypeSchema,
          entityType: z.string().optional(),
          inboxItemType: z.string().optional(),
          config: TemplateConfigSchema,
        })
        .extend({
          name: z.string().min(1),
          targetType: TemplateTargetTypeSchema,
          config: TemplateConfigSchema,
          isDefault: z.boolean().default(false),
          isPublic: z.boolean().default(false),
        })
    )
    .mutation(async ({ ctx, input }) => {
      const { randomUUID } = await import("crypto");
      const templateId = randomUUID();

      await emitRequestEvent({
        type: "templates.create.requested",
        subjectId: templateId,
        subjectType: "template",
        data: {
          id: templateId,
          userId: input.workspaceId ? null : ctx.userId,
          workspaceId: input.workspaceId || null,
          name: input.name,
          description: input.description || null,
          targetType: input.targetType,
          entityType: input.entityType || null,
          inboxItemType: input.inboxItemType || null,
          config: input.config,
          isDefault: input.isDefault,
          isPublic: input.isPublic,
          version: 1,
          requestingUserId: ctx.userId,
        },
        userId: ctx.userId,
      });

      return { status: "requested", templateId };
    }),

  // Update template
  update: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        name: z.string().min(1).optional(),
        description: z.string().optional(),
        config: TemplateConfigSchema.optional(),
        isDefault: z.boolean().optional(),
        isPublic: z.boolean().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...updates } = input;

      // Verify ownership
      const existing = await db.query.entityTemplates.findFirst({
        where: eq(entityTemplates.id, id as string),
      });

      if (!existing)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Template not found",
        });

      // Check permissions - workspace templates require editor, personal require ownership
      if (existing.workspaceId) {
        const permResult = await verifyPermission({
          db,
          userId: ctx.userId,
          workspace: { id: existing.workspaceId },
          requiredPermission: "write",
        });
        if (!permResult.allowed)
          throw new TRPCError({
            code: "FORBIDDEN",
            message: permResult.reason || "Insufficient permissions",
          });
      } else if (existing.userId) {
        if (existing.userId !== ctx.userId) {
          throw new TRPCError({ code: "FORBIDDEN", message: "Unauthorized" });
        }
      }

      await emitRequestEvent({
        type: "templates.update.requested",
        subjectId: id,
        subjectType: "template",
        data: {
          id,
          ...updates,
          userId: ctx.userId,
        },
        userId: ctx.userId,
      });

      return { status: "requested" };
    }),

  // Delete template
  delete: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      // Check ownership before delete
      const template = await db.query.entityTemplates.findFirst({
        where: eq(entityTemplates.id, input.id as string),
      });

      if (!template)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Template not found",
        });

      // Workspace templates require editor role, personal require ownership
      if (template.workspaceId) {
        const permResult = await verifyPermission({
          db,
          userId: ctx.userId,
          workspace: { id: template.workspaceId },
          requiredPermission: "write",
        });
        if (!permResult.allowed)
          throw new TRPCError({
            code: "FORBIDDEN",
            message: permResult.reason || "Insufficient permissions",
          });
      } else if (template.userId && template.userId !== ctx.userId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Unauthorized" });
      }

      await emitRequestEvent({
        type: "templates.delete.requested",
        subjectId: input.id,
        subjectType: "template",
        data: {
          id: input.id,
          userId: ctx.userId,
        },
        userId: ctx.userId,
      });

      return { status: "requested" };
    }),

  // Duplicate template
  duplicate: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const original = await db.query.entityTemplates.findFirst({
        where: eq(entityTemplates.id, input.id as string),
      });

      if (!original)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Template not found",
        });

      // If user checks public template, they can duplicate it to their own list
      // So no permission check on READ, just explicit duplicate.

      const [template] = await db
        .insert(entityTemplates)
        .values({
          userId: ctx.userId,
          workspaceId: null, // Always duplicate to personal scope initially
          name: `${original.name} (Copy)`,
          description: original.description,
          targetType: original.targetType,
          entityType: original.entityType,
          inboxItemType: original.inboxItemType,
          config: original.config,
          isDefault: false,
          isPublic: false,
          version: 1,
        })
        .returning();

      return template;
    }),

  // Set as default
  setDefault: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const template = await db.query.entityTemplates.findFirst({
        where: eq(entityTemplates.id, input.id as string),
      });

      if (!template)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Template not found",
        });

      // Check permissions
      if (template.workspaceId) {
        const permResult = await verifyPermission({
          db,
          userId: ctx.userId,
          workspace: { id: template.workspaceId },
          requiredPermission: "write",
        });
        if (!permResult.allowed)
          throw new TRPCError({
            code: "FORBIDDEN",
            message: permResult.reason || "Insufficient permissions",
          });
      } else if (template.userId && template.userId !== ctx.userId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Unauthorized" });
      }

      // Unset previous default
      const conditions: (SQL | undefined)[] = [
        template.workspaceId
          ? eq(entityTemplates.workspaceId, template.workspaceId)
          : eq(entityTemplates.userId, ctx.userId),
        eq(entityTemplates.targetType, template.targetType),
        template.entityType
          ? eq(entityTemplates.entityType, template.entityType)
          : undefined,
        template.inboxItemType
          ? eq(entityTemplates.inboxItemType, template.inboxItemType)
          : undefined,
        eq(entityTemplates.isDefault, true),
      ];

      const validConditions = conditions.filter(
        (c): c is SQL => c !== undefined
      );

      await db
        .update(entityTemplates)
        .set({ isDefault: false })
        .where(and(...validConditions));

      // Set new default
      await db
        .update(entityTemplates)
        .set({ isDefault: true })
        .where(eq(entityTemplates.id, input.id as string));

      return { success: true };
    }),
});
