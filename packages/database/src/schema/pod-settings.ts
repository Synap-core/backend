/**
 * Pod Settings — singleton row holding pod-wide defaults.
 *
 * One row per pod (PRIMARY KEY = id, fixed to a sentinel UUID at the row level
 * via the `singletonId` constant below). Workspaces inherit from this row when
 * their own `workspace.settings.*` slot is unset.
 *
 * Currently stores:
 *   - intelligenceDefaults: tier-based model defaults (chat / reasoning /
 *     embedding / vision). null fields fall through to the default IS.
 *   - proactiveDefaults: pod-wide defaults for proactive AI (workspaces can
 *     override via workspace.settings.proactiveAi).
 *
 * Read/write goes through `pod_settings` directly via Drizzle. Use
 * `getPodSettings()` / `setPodSettings()` helpers if added later — for now
 * routers query the row directly with `.findFirst({})` (only one row exists).
 */
import { pgTable, uuid, jsonb, timestamp } from "drizzle-orm/pg-core";

export interface PodIntelligenceDefaults {
  chatModelId: string | null;
  reasoningModelId: string | null;
  embeddingModelId: string | null;
  visionModelId: string | null;
}

export interface PodProactiveDefaults {
  enabled: boolean;
  nudgeDensity: "low" | "medium" | "high";
  schedules: {
    morningBriefing: boolean;
    weeklyDigest: boolean;
    healthCheck: boolean;
  };
}

export interface PodSettingsBlob {
  intelligenceDefaults?: PodIntelligenceDefaults;
  proactiveDefaults?: PodProactiveDefaults;
  [k: string]: unknown;
}

export const podSettings = pgTable("pod_settings", {
  id: uuid("id").primaryKey().defaultRandom(),
  settings: jsonb("settings").$type<PodSettingsBlob>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type PodSettings = typeof podSettings.$inferSelect;
export type PodSettingsInsert = typeof podSettings.$inferInsert;

/**
 * Default intelligence defaults — every tier inherits from the default IS
 * until the pod admin overrides them.
 */
export function getDefaultPodIntelligenceDefaults(): PodIntelligenceDefaults {
  return {
    chatModelId: null,
    reasoningModelId: null,
    embeddingModelId: null,
    visionModelId: null,
  };
}

/**
 * Default proactive defaults — proactive AI is OFF at the pod level until
 * an admin opts in. Individual workspaces can still override.
 */
export function getDefaultPodProactiveDefaults(): PodProactiveDefaults {
  return {
    enabled: false,
    nudgeDensity: "medium",
    schedules: {
      morningBriefing: true,
      weeklyDigest: true,
      healthCheck: true,
    },
  };
}
