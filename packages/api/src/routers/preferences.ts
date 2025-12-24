/**
 * Preferences Router - User preferences management
 * 
 * Handles:
 * - Get/update user preferences
 * - Default preferences
 */

import { z } from 'zod';
import { router, protectedProcedure } from '../trpc.js';
import { db, eq } from '@synap/database';
import { userPreferences } from '@synap/database/schema';
import { UserPreferencesEvents } from '../lib/event-helpers.js';

const DEFAULT_PREFERENCES = {
  theme: 'system',
  uiPreferences: {
    sidebarCollapsed: false,
    compactMode: false,
    fontSize: 'medium',
  },
  graphPreferences: {
    forceSettings: {
      linkDistance: 150,
      chargeStrength: -300,
      alphaDecay: 0.08,
      velocityDecay: 0.6,
    },
    defaultFilters: {
      entityTypes: [],
      relationTypes: [],
    },
    zoom: 1.0,
    pan: { x: 0, y: 0 },
    showMinimap: true,
  },
  onboardingCompleted: false,
  onboardingStep: null,
};

export const preferencesRouter = router({
  /**
   * Get user preferences
   */
  get: protectedProcedure.query(async ({ ctx }) => {
    const prefs = await db.query.userPreferences.findFirst({
      where: eq(userPreferences.userId, ctx.userId),
    });

    // Return defaults if not found
    return prefs || DEFAULT_PREFERENCES;
  }),

  /**
   * Update user preferences
   */
  update: protectedProcedure
    .input(z.object({
      theme: z.enum(['light', 'dark', 'system']).optional(),
      uiPreferences: z.record(z.any()).optional(),
      graphPreferences: z.record(z.any()).optional(),
      onboardingCompleted: z.boolean().optional(),
      onboardingStep: z.string().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      // Log requested event
      await UserPreferencesEvents.updateRequested(ctx.userId, input);
      
      // Check if preferences exist
      const existing = await db.query.userPreferences.findFirst({
        where: eq(userPreferences.userId, ctx.userId),
      });

      if (existing) {
        // Update existing
        const [updated] = await db.update(userPreferences)
          .set({
            theme: input.theme,
            uiPreferences: input.uiPreferences,
            graphPreferences: input.graphPreferences,
            onboardingCompleted: input.onboardingCompleted,
            updatedAt: new Date(),
          })
          .where(eq(userPreferences.userId, ctx.userId))
          .returning();
          
        // Log validated event
        await UserPreferencesEvents.updateValidated(ctx.userId, input);
        
        return updated;
      } else {
        // Create new
        const [created] = await db.insert(userPreferences).values({
          userId: ctx.userId,
          theme: input.theme || 'system',
          uiPreferences: input.uiPreferences || {},
          graphPreferences: input.graphPreferences || {},
          onboardingCompleted: input.onboardingCompleted || false,
        }).returning();
        
        // Log validated event
        await UserPreferencesEvents.updateValidated(ctx.userId, input);
        
        return created;
      }
    }),

  /**
   * Reset preferences to defaults
   */
  reset: protectedProcedure.mutation(async ({ ctx }) => {
    await db.delete(userPreferences).where(eq(userPreferences.userId, ctx.userId));
    return DEFAULT_PREFERENCES;
  }),
});
