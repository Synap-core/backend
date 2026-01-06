/**
 * Preferences Router - User preferences management
 */

import { z } from 'zod';
import { router, protectedProcedure } from '../trpc.js';
import { userPreferences } from '@synap/database/schema';
import { eq } from '@synap/database';
import { 
  UpdatePreferencesInputSchema,
  CustomThemeSchema,
} from '@synap-core/types';

export const preferencesRouter = router({
  /**
   * Get user preferences
   */
  get: protectedProcedure.query(async ({ ctx }) => {
    const prefs = await ctx.db.query.userPreferences.findFirst({
      where: eq(userPreferences.userId, ctx.userId),
    });
    
    // Return defaults if not exists
    if (!prefs) {
      return {
        userId: ctx.userId,
        theme: 'system' as const,
        uiPreferences: {},
        graphPreferences: {},
        onboardingCompleted: false,
      };
    }
    
    return prefs;
  }),
  
  /**
   * Update user preferences (partial update)
   */
  update: protectedProcedure
    .input(UpdatePreferencesInputSchema)
    .mutation(async ({ ctx, input }) => {
      await ctx.db
        .insert(userPreferences)
        .values({
          userId: ctx.userId,
          ...input,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: userPreferences.userId,
          set: {
            ...input,
            updatedAt: new Date(),
          },
        });
      
      // Return updated preferences
      const updated = await ctx.db.query.userPreferences.findFirst({
        where: eq(userPreferences.userId, ctx.userId),
      });
      
      return updated;
    }),
  
  /**
   * Update theme settings
   */
  updateTheme: protectedProcedure
    .input(z.object({
      theme: z.enum(['light', 'dark', 'system']).optional(),
      customTheme: CustomThemeSchema,
    }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db
        .insert(userPreferences)
        .values({
          userId: ctx.userId,
          ...input,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: userPreferences.userId,
          set: {
            ...input,
            updatedAt: new Date(),
          },
        });
      
      return { success: true };
    }),
  
  /**
   * Update default template for an entity type
   */
  updateDefaultTemplates: protectedProcedure
    .input(z.object({
      entityType: z.string(),
      templateId: z.string(),
    }))
    .mutation(async ({ ctx, input }) => {
      // Get current preferences
      const current = await ctx.db.query.userPreferences.findFirst({
        where: eq(userPreferences.userId, ctx.userId),
      });
      
      // Merge with new template
      const defaultTemplates = {
        ...(current?.defaultTemplates as Record<string, string> || {}),
        [input.entityType]: input.templateId,
      };
      
      await ctx.db
        .insert(userPreferences)
        .values({
          userId: ctx.userId,
          defaultTemplates,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: userPreferences.userId,
          set: {
            defaultTemplates,
            updatedAt: new Date(),
          },
        });
      
      return { success: true, defaultTemplates };
    }),
  
  /**
   * Update custom entity types
   */
  updateCustomEntityTypes: protectedProcedure
    .input(z.object({
      customEntityTypes: z.array(z.any()),
    }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db
        .insert(userPreferences)
        .values({
          userId: ctx.userId,
          customEntityTypes: input.customEntityTypes,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: userPreferences.userId,
          set: {
            customEntityTypes: input.customEntityTypes,
            updatedAt: new Date(),
          },
        });
      
      return { success: true };
    }),
});
