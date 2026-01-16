/**
 * Preferences Router - User preferences management
 */

import { z } from "zod";
import { router, protectedProcedure } from "../trpc.js";
import { userPreferences } from "@synap/database/schema";
import { eq } from "@synap/database";
import { UpdatePreferencesInputSchema } from "@synap-core/types";

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
        theme: "system" as const,
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
    .input(
      z.object({
        theme: z.enum(["light", "dark", "system"]).optional(),
        customTheme: z
          .object({
            colors: z
              .object({
                primary: z.string().optional(),
                accent: z.string().optional(),
                background: z.string().optional(),
                border: z.string().optional(),
                text: z.string().optional(),
              })
              .optional(),
            spacing: z
              .object({
                small: z.string().optional(),
                medium: z.string().optional(),
                large: z.string().optional(),
              })
              .optional(),
            radii: z
              .object({
                small: z.string().optional(),
                medium: z.string().optional(),
                large: z.string().optional(),
              })
              .optional(),
            animations: z
              .object({
                enabled: z.boolean().optional(),
                speed: z.enum(["slow", "normal", "fast"]).optional(),
              })
              .optional(),
          })
          .optional(),
      })
    )
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
    .input(
      z.object({
        entityType: z.string(),
        templateId: z.string(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // Get current preferences
      const current = await ctx.db.query.userPreferences.findFirst({
        where: eq(userPreferences.userId, ctx.userId),
      });

      // Merge with new template
      const defaultTemplates = {
        ...((current?.defaultTemplates as Record<string, string>) || {}),
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
    .input(
      z.object({
        customEntityTypes: z.array(z.any()),
      })
    )
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

  // ============================================================================
  // VIEW MODE PREFERENCES
  // ============================================================================

  /**
   * Get view mode preferences
   */
  getViewModes: protectedProcedure.query(async ({ ctx }) => {
    const prefs = await ctx.db.query.userPreferences.findFirst({
      where: eq(userPreferences.userId, ctx.userId),
    });

    const viewModes = (prefs?.uiPreferences as any)?.viewModes || {
      entities: "grid",
      documents: "grid",
      views: "grid",
    };

    return viewModes;
  }),

  /**
   * Update view mode for specific context
   */
  updateViewMode: protectedProcedure
    .input(
      z.object({
        context: z.enum(["entities", "documents", "views"]),
        mode: z.enum(["grid", "list", "table"]),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // Get current preferences
      const current = await ctx.db.query.userPreferences.findFirst({
        where: eq(userPreferences.userId, ctx.userId),
      });

      const currentUiPrefs = (current?.uiPreferences || {}) as any;
      const currentViewModes = currentUiPrefs.viewModes || {};

      const newUiPrefs = {
        ...currentUiPrefs,
        viewModes: {
          ...currentViewModes,
          [input.context]: input.mode,
        },
      };

      await ctx.db
        .insert(userPreferences)
        .values({
          userId: ctx.userId,
          uiPreferences: newUiPrefs,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: userPreferences.userId,
          set: {
            uiPreferences: newUiPrefs,
            updatedAt: new Date(),
          },
        });

      return { success: true, viewModes: newUiPrefs.viewModes };
    }),

  // ============================================================================
  // INTELLIGENCE SERVICE PREFERENCES
  // ============================================================================

  /**
   * Get intelligence service preferences and available services
   */
  getIntelligenceServices: protectedProcedure.query(async ({ ctx }) => {
    const prefs = await ctx.db.query.userPreferences.findFirst({
      where: eq(userPreferences.userId, ctx.userId),
    });

    const { intelligenceServices } = await import("@synap/database/schema");

    return {
      preferences: prefs?.intelligenceServicePreferences || {},
      available: await ctx.db.query.intelligenceServices.findMany({
        where: eq(intelligenceServices.status, "active"),
        columns: {
          id: true,
          serviceId: true,
          name: true,
          capabilities: true,
          pricing: true,
        },
      }),
    };
  }),

  /**
   * Set intelligence service for a capability
   */
  setIntelligenceService: protectedProcedure
    .input(
      z.object({
        serviceId: z.string(),
        capability: z.enum(["default", "chat", "analysis"]).default("default"),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { intelligenceServices, and } = await import("@synap/database");

      // Verify service exists and is active
      const service = await ctx.db.query.intelligenceServices.findFirst({
        where: and(
          eq(intelligenceServices.serviceId, input.serviceId),
          eq(intelligenceServices.status, "active")
        ),
      });

      if (!service) {
        throw new Error("Intelligence service not found or inactive");
      }

      // Get current preferences
      const current = await ctx.db.query.userPreferences.findFirst({
        where: eq(userPreferences.userId, ctx.userId),
      });

      const currentPrefs = (current?.intelligenceServicePreferences ||
        {}) as any;

      // Merge new preference
      const newPrefs = {
        ...currentPrefs,
        [input.capability]: input.serviceId,
      };

      // Upsert
      await ctx.db
        .insert(userPreferences)
        .values({
          userId: ctx.userId,
          intelligenceServicePreferences: newPrefs,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: userPreferences.userId,
          set: {
            intelligenceServicePreferences: newPrefs,
            updatedAt: new Date(),
          },
        });

      return { success: true, preferences: newPrefs };
    }),
});
