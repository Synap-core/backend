/**
 * Preferences Router - User preferences management
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure } from "../trpc.js";
import { AccessContext, scopedDb } from "../access/index.js";
import { userPreferences } from "@synap/database/schema";
import { eq } from "@synap/database";
import { UpdatePreferencesInputSchema } from "@synap-core/types";
import {
  assertPinnableSurface,
  RailGoalPinsFullError,
  RailPinsFullError,
  readRailPins,
  writeRailPins,
  type RailPinsOp,
} from "../services/preferences/rail-pins.js";

/**
 * One write door for the rail pins; a full rail — or a week already holding
 * its goals — is a PRECONDITION, not a 500.
 */
async function railPinsWrite(
  userId: string,
  op: RailPinsOp,
  includeGoals: boolean | undefined
) {
  try {
    return { pins: pinsFor(await writeRailPins(userId, op), includeGoals) };
  } catch (err) {
    if (
      err instanceof RailPinsFullError ||
      err instanceof RailGoalPinsFullError
    ) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: err.message,
      });
    }
    throw err;
  }
}

/**
 * GOAL pins ("This week", `trackId`, `profileSlug: null`) leave every
 * response — the read's and the writes' — unless the caller asks for them
 * (`includeGoals: true`, code.md 2026-10-24): a shipped desktop build reads
 * every pin as a surface and lost every rail badge on a pin with no kind.
 */
function pinsFor<P extends { trackId: string | null }>(
  pins: P[],
  includeGoals: boolean | undefined
): P[] {
  return includeGoals ? pins : pins.filter((p) => !p.trackId);
}

/** The flag every rail-pins door takes (absent ⇒ surface pins only). */
const includeGoals = z.boolean().optional();

export const preferencesRouter = router({
  /**
   * The person's RAIL PINS — the intent surfaces on their rail, in order
   * (surfaces W1.7, `services/preferences/rail-pins.ts`). Per user, across
   * spaces; a space's template `sidebarItems` pipeline views are folded in as
   * suggestions until the person first edits their pins.
   *
   * GOAL pins come back only when asked — `{ includeGoals: true }`
   * ({@link pinsFor}); the write doors below take the same flag.
   */
  railPins: protectedProcedure
    .input(z.object({ includeGoals }).optional())
    .query(async ({ ctx, input }) => ({
      pins: pinsFor(await readRailPins(ctx.userId), input?.includeGoals),
    })),

  /**
   * Pin a surface: a kind/role (`profileSlug`), a saved pipeline view of it
   * (`viewId`), or a GOAL (`trackId`, exclusive with `profileSlug` — "This
   * week", D4: at most `RAIL_GOAL_PINS_MAX`, a 4th is PRECONDITION_FAILED).
   * Idempotent — pinning a pinned surface keeps one pin. The surface must
   * exist and be readable (NOT_FOUND / BAD_REQUEST otherwise).
   */
  pinSurface: protectedProcedure
    .input(
      z
        .object({
          profileSlug: z.string().min(1).optional(),
          viewId: z.string().uuid().optional(),
          trackId: z.string().uuid().optional(),
          label: z.string().trim().min(1).max(80).optional(),
          includeGoals,
        })
        .superRefine((v, ctx) => {
          if (Boolean(v.profileSlug) === Boolean(v.trackId)) {
            ctx.addIssue({
              code: "custom",
              message:
                "Pin a kind (profileSlug) or a goal (trackId) — one of the two.",
              path: ["trackId"],
            });
          }
          if (v.trackId && v.viewId) {
            ctx.addIssue({
              code: "custom",
              message:
                "A goal pin names no view — viewId pins a kind's saved board.",
              path: ["viewId"],
            });
          }
        })
    )
    .mutation(async ({ ctx, input }) => {
      const { trackId, profileSlug, viewId, label } = input;
      if (trackId) {
        await assertPinnableSurface(ctx.userId, { trackId });
        return railPinsWrite(
          ctx.userId,
          { op: "pin", trackId, label },
          input.includeGoals
        );
      }
      const surface = { profileSlug: profileSlug!, viewId };
      await assertPinnableSurface(ctx.userId, surface);
      return railPinsWrite(
        ctx.userId,
        { op: "pin", ...surface, label },
        input.includeGoals
      );
    }),

  /** Unpin by key (`view:<id>` / `kind:<slug>` / `track:<id>`). A suggested pin stays gone. */
  unpinSurface: protectedProcedure
    .input(z.object({ key: z.string().min(1).max(200), includeGoals }))
    .mutation(({ ctx, input }) =>
      railPinsWrite(
        ctx.userId,
        { op: "unpin", key: input.key },
        input.includeGoals
      )
    ),

  /**
   * Reorder: the named keys first, in order; pins not named keep their place
   * after them (a stale client never drops a pin).
   */
  reorderRailPins: protectedProcedure
    .input(
      z.object({
        keys: z.array(z.string().min(1).max(200)).max(60),
        includeGoals,
      })
    )
    .mutation(({ ctx, input }) =>
      railPinsWrite(
        ctx.userId,
        { op: "reorder", keys: input.keys },
        input.includeGoals
      )
    ),

  /**
   * Stamp "Home was on screen until now" — call it when Home LEAVES the
   * screen (unmount, window hidden). `lifecycle.home` then returns it as
   * `homeLastSeenAt` on every device, so "while you were away" follows the
   * person. Server time, owner row only (0333). Returns the stamp written.
   */
  markHomeSeen: protectedProcedure.mutation(async ({ ctx }) => {
    const now = new Date();
    await ctx.db
      .insert(userPreferences)
      .values({ userId: ctx.userId, homeLastSeenAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: userPreferences.userId,
        set: { homeLastSeenAt: now, updatedAt: now },
      });
    return { homeLastSeenAt: now.toISOString() };
  }),

  /**
   * Get user preferences
   */
  get: protectedProcedure.query(async ({ ctx }) => {
    // Floored through the access layer: the `user` rule ANDs
    // `eq(userPreferences.userId, ctx.userId)` — the same owner floor this read
    // hand-rolled — so a user can only ever read their own preferences row.
    const prefs = await scopedDb(AccessContext.from(ctx)).findFirst<
      typeof userPreferences.$inferSelect
    >(userPreferences, {});

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

    const uiPrefsRecord = prefs?.uiPreferences as Record<
      string,
      unknown
    > | null;
    const viewModes = (uiPrefsRecord?.viewModes as Record<string, string>) || {
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

      const currentUiPrefs = (current?.uiPreferences || {}) as Record<
        string,
        unknown
      >;
      const currentViewModes = (currentUiPrefs.viewModes || {}) as Record<
        string,
        string
      >;

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
   * Set the USER-level default companion adjunct (agent-system id).
   *
   * Stored inside the existing intelligenceServicePreferences jsonb (no
   * migration). This is a PERSONAL default for the AI entry door / companion —
   * orthogonal to the per-workspace intelligenceServiceId and NOT per-channel
   * routing. Pass `null` to clear and revert to current (workspace-default)
   * behavior.
   */
  setDefaultCompanion: protectedProcedure
    .input(
      z.object({
        agentId: z.string().min(1).nullable(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const current = await ctx.db.query.userPreferences.findFirst({
        where: eq(userPreferences.userId, ctx.userId),
      });

      const currentPrefs = (current?.intelligenceServicePreferences ||
        {}) as Record<string, unknown>;

      const newPrefs = { ...currentPrefs };
      if (input.agentId) {
        newPrefs.defaultCompanionAgentId = input.agentId;
      } else {
        delete newPrefs.defaultCompanionAgentId;
      }

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

  /** Persist how the user opens the Companion across Browser sessions. */
  setCompanionMode: protectedProcedure
    .input(
      z.object({
        mode: z.enum(["builtin", "terminal", "headless"]).nullable(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const current = await ctx.db.query.userPreferences.findFirst({
        where: eq(userPreferences.userId, ctx.userId),
      });
      const currentPrefs = (current?.intelligenceServicePreferences ||
        {}) as Record<string, unknown>;
      const newPrefs = { ...currentPrefs };

      if (input.mode) newPrefs.companionMode = input.mode;
      else delete newPrefs.companionMode;

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

  /**
   * Set intelligence service for a capability
   */
  setIntelligenceService: protectedProcedure
    .input(
      z.object({
        serviceId: z.string().nullable(),
        capability: z.enum(["default", "chat", "analysis"]).default("default"),
      })
    )
    .mutation(async ({ ctx, input }) => {
      if (input.serviceId) {
        const { intelligenceServices, and } = await import("@synap/database");

        // Verify service exists and is active
        const service = await ctx.db.query.intelligenceServices.findFirst({
          where: and(
            eq(intelligenceServices.serviceId, input.serviceId),
            eq(intelligenceServices.status, "active")
          ),
        });

        if (!service) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Intelligence service not found or inactive",
          });
        }
      }

      // Get current preferences
      const current = await ctx.db.query.userPreferences.findFirst({
        where: eq(userPreferences.userId, ctx.userId),
      });

      const currentPrefs = (current?.intelligenceServicePreferences ||
        {}) as Record<string, unknown>;

      // Merge or clear preference
      const newPrefs = { ...currentPrefs };
      if (input.serviceId) {
        newPrefs[input.capability] = input.serviceId;
      } else {
        delete newPrefs[input.capability];
      }

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
