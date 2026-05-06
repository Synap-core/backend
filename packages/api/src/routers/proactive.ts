/**
 * Proactive AI Preferences Router
 *
 * Reads and writes proactive AI preferences stored in workspace.settings.proactiveAi.
 * Uses the existing JSONB merge pattern for workspace settings.
 *
 * Mounted as trpc.proactive.* in root.ts.
 */

import { z } from "zod";
import { router, workspaceProcedure, podAdminProcedure } from "../trpc.js";
import { db, eq, drizzleSql } from "@synap/database";
import { workspaces, podSettings } from "@synap/database/schema";
import type { WorkspaceSettings } from "@synap/database/schema";
import {
  getDefaultProactiveAiPreferences,
  getDefaultPodProactiveDefaults,
} from "@synap/database/schema";

// ── Zod Schemas ──────────────────────────────────────────────────────────────

const morningBriefingSchema = z.object({
  enabled: z.boolean().optional(),
  cronHour: z.number().int().min(0).max(23).optional(),
  cronMinute: z.number().int().min(0).max(59).optional(),
  timezone: z.string().min(1).max(64).optional(),
});

const weeklyDigestSchema = z.object({
  enabled: z.boolean().optional(),
  dayOfWeek: z.number().int().min(0).max(6).optional(),
  cronHour: z.number().int().min(0).max(23).optional(),
  timezone: z.string().min(1).max(64).optional(),
});

const healthCheckSchema = z.object({
  enabled: z.boolean().optional(),
  frequencyDays: z.number().int().min(1).max(90).optional(),
});

const updateProactivePrefsSchema = z.object({
  enabled: z.boolean().optional(),
  morningBriefing: morningBriefingSchema.optional(),
  weeklyDigest: weeklyDigestSchema.optional(),
  healthCheck: healthCheckSchema.optional(),
  nudgeDensity: z.enum(["minimal", "balanced", "proactive"]).optional(),
  mutedUntil: z.string().datetime({ offset: true }).nullable().optional(),
});

// ── Router ───────────────────────────────────────────────────────────────────

export const proactiveRouter = router({
  /**
   * Get proactive AI preferences for the current workspace.
   * Returns defaults if no preferences have been set.
   */
  getPrefs: workspaceProcedure.query(async ({ ctx }) => {
    const ws = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, ctx.workspaceId),
      columns: { settings: true },
    });

    const settings = (ws?.settings ?? {}) as WorkspaceSettings;
    return settings.proactiveAi ?? getDefaultProactiveAiPreferences();
  }),

  /**
   * Update proactive AI preferences for the current workspace.
   * Partial merge: only provided fields are overwritten.
   * Uses the JSONB merge pattern: settings || { proactiveAi: merged }
   */
  updatePrefs: workspaceProcedure
    .input(updateProactivePrefsSchema)
    .mutation(async ({ ctx, input }) => {
      // Read current prefs
      const ws = await db.query.workspaces.findFirst({
        where: eq(workspaces.id, ctx.workspaceId),
        columns: { settings: true },
      });

      const settings = (ws?.settings ?? {}) as WorkspaceSettings;
      const current =
        settings.proactiveAi ?? getDefaultProactiveAiPreferences();

      // Deep merge each sub-object
      const merged = {
        enabled: input.enabled ?? current.enabled,
        morningBriefing: {
          ...current.morningBriefing,
          ...input.morningBriefing,
        },
        weeklyDigest: {
          ...current.weeklyDigest,
          ...input.weeklyDigest,
        },
        healthCheck: {
          ...current.healthCheck,
          ...input.healthCheck,
        },
        nudgeDensity: input.nudgeDensity ?? current.nudgeDensity,
        // null explicitly clears mutedUntil; undefined keeps current value
        mutedUntil:
          input.mutedUntil === null
            ? undefined
            : (input.mutedUntil ?? current.mutedUntil),
      };

      // Merge into workspace settings JSONB
      await db
        .update(workspaces)
        .set({
          settings: drizzleSql`settings || ${JSON.stringify({ proactiveAi: merged })}::jsonb`,
          updatedAt: new Date(),
        })
        .where(eq(workspaces.id, ctx.workspaceId));

      return merged;
    }),

  /**
   * Get pod-wide proactive AI defaults.
   *
   * Workspaces inherit from these via `workspace.settings.proactiveAi`. The
   * pod-level row is a singleton in `pod_settings` (read first row by
   * created_at). Returns the static default (proactive OFF) if no row exists.
   * Pod admins only.
   */
  getPodDefaults: podAdminProcedure.query(async () => {
    const [row] = await db
      .select({ settings: podSettings.settings })
      .from(podSettings)
      .orderBy(podSettings.createdAt)
      .limit(1);
    const blob = (row?.settings ?? {}) as { proactiveDefaults?: unknown };
    const defaults =
      (blob.proactiveDefaults as ReturnType<
        typeof getDefaultPodProactiveDefaults
      > | null) ?? getDefaultPodProactiveDefaults();
    return { defaults };
  }),

  /**
   * Upsert the pod-wide proactive AI defaults.
   *
   * Workspaces still keep their own per-workspace overrides via
   * `workspace.settings.proactiveAi`. Pod admins only.
   */
  setPodDefaults: podAdminProcedure
    .input(
      z.object({
        enabled: z.boolean(),
        nudgeDensity: z.enum(["low", "medium", "high"]),
        schedules: z.object({
          morningBriefing: z.boolean(),
          weeklyDigest: z.boolean(),
          healthCheck: z.boolean(),
        }),
      })
    )
    .mutation(async ({ input }) => {
      const [existing] = await db
        .select({ id: podSettings.id })
        .from(podSettings)
        .orderBy(podSettings.createdAt)
        .limit(1);

      if (existing) {
        await db
          .update(podSettings)
          .set({
            settings: drizzleSql`coalesce(${podSettings.settings}, '{}'::jsonb) || ${JSON.stringify(
              { proactiveDefaults: input }
            )}::jsonb`,
            updatedAt: new Date(),
          })
          .where(eq(podSettings.id, existing.id));
      } else {
        await db.insert(podSettings).values({
          settings: { proactiveDefaults: input },
        });
      }
      return { defaults: input };
    }),
});
