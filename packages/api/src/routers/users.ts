/**
 * Users Router - Current User API
 *
 * Exposes the authenticated user's identity and profile data.
 */

import { router, protectedProcedure } from "../trpc.js";
import { db, eq } from "@synap/database";
import { users, userPreferences } from "@synap/database/schema";
import { AccessContext, scopedDb } from "../access/index.js";
import { z } from "zod";

const FeedSourceSchema = z.object({
  id: z.string(),
  url: z.string(),
  name: z.string(),
  provider: z.enum(["direct", "custom"]),
  enabled: z.boolean(),
  topics: z.array(z.string()),
  addedAt: z.number(),
  lastFetched: z.number().optional(),
  fetchError: z.string().optional(),
});

const FeedPreferencesSchema = z.object({
  interests: z.array(z.string()),
  dislikedTopics: z.array(z.string()),
  /**
   * The user's OWN word for who they are — deliberately NOT an enum.
   *
   * Synap's promise is the user's own vocabulary; a fixed seven-value enum
   * 400'd every persona outside it ("teacher", "vigneron", "solo-dev") at the
   * API boundary, which is the opposite of agnostic. Bounded + trimmed is the
   * only constraint this value needs: nothing server-side switches on it — the
   * read door below already returns it as a plain string with a "general"
   * fallback, and no backend/relay consumer looks it up in a table. If a label
   * is ever needed, `humanizeToken` from `@synap-core/types/vocabulary` is the
   * one door — never a local label map.
   */
  persona: z.string().trim().min(1).max(64),
  // Relay-local goal for now (not used server-side beyond persistence).
  // Same reasoning as `persona`: a free, bounded string, not a fixed enum.
  goal: z.string().trim().min(1).max(64).optional(),
  frequency: z.enum(["realtime", "hourly", "daily", "weekly"]),
  sources: z.array(FeedSourceSchema),
  relevanceThreshold: z.number(),
  notifications: z.boolean(),
  autoCreateEntities: z.boolean(),
  onboardingCompleted: z.boolean(),
});

export const usersRouter = router({
  /**
   * Get the currently authenticated user's identity.
   * Returns Kratos session data merged with DB fields (name, avatarUrl, timezone, locale).
   */
  me: protectedProcedure.query(async ({ ctx }) => {
    const dbUser = await db.query.users.findFirst({
      where: eq(users.id, ctx.userId),
      columns: {
        id: true,
        email: true,
        name: true,
        avatarUrl: true,
        timezone: true,
        locale: true,
      },
    });

    return {
      id: ctx.userId,
      email: dbUser?.email ?? ctx.user?.email ?? "",
      name: dbUser?.name ?? ctx.user?.name ?? null,
      avatarUrl: dbUser?.avatarUrl ?? null,
      timezone: dbUser?.timezone ?? "UTC",
      locale: dbUser?.locale ?? "en",
    };
  }),

  /**
   * Relay feed preferences (legacy client contract).
   * Stored under user_preferences.ui_preferences.feedPreferences.
   */
  getFeedPreferences: protectedProcedure.query(async ({ ctx }) => {
    // Access-layer floored: the `user` rule ANDs the owner floor
    // (`eq(userPreferences.userId, ctx.userId)`), so only the caller's own row
    // is ever returned.
    const prefs = await scopedDb(AccessContext.from(ctx)).findFirst<
      Pick<typeof userPreferences.$inferSelect, "uiPreferences">
    >(userPreferences, { columns: { uiPreferences: true } });

    const ui = (prefs?.uiPreferences as Record<string, unknown>) ?? {};
    const stored =
      (ui.feedPreferences as Record<string, unknown> | undefined) ?? {};

    return {
      preferences: {
        interests: Array.isArray(stored.interests) ? stored.interests : [],
        dislikedTopics: Array.isArray(stored.dislikedTopics)
          ? stored.dislikedTopics
          : [],
        persona: (stored.persona as string) ?? "general",
        goal: (stored.goal as string | undefined) ?? "trend-monitoring",
        frequency: (stored.frequency as string) ?? "hourly",
        sources: Array.isArray(stored.sources) ? stored.sources : [],
        relevanceThreshold:
          typeof stored.relevanceThreshold === "number"
            ? stored.relevanceThreshold
            : 50,
        notifications:
          typeof stored.notifications === "boolean"
            ? stored.notifications
            : true,
        autoCreateEntities:
          typeof stored.autoCreateEntities === "boolean"
            ? stored.autoCreateEntities
            : false,
        onboardingCompleted:
          typeof stored.onboardingCompleted === "boolean"
            ? stored.onboardingCompleted
            : false,
      },
    };
  }),

  updateFeedPreferences: protectedProcedure
    .input(z.object({ preferences: FeedPreferencesSchema }))
    .mutation(async ({ ctx, input }) => {
      const current = await ctx.db.query.userPreferences.findFirst({
        where: eq(userPreferences.userId, ctx.userId),
        columns: { uiPreferences: true },
      });

      const currentUi =
        (current?.uiPreferences as Record<string, unknown>) ?? {};
      const nextUi = {
        ...currentUi,
        feedPreferences: input.preferences,
      };

      await ctx.db
        .insert(userPreferences)
        .values({
          userId: ctx.userId,
          uiPreferences: nextUi,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: userPreferences.userId,
          set: {
            uiPreferences: nextUi,
            updatedAt: new Date(),
          },
        });

      return { success: true };
    }),
});
