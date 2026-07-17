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

/**
 * Per (source, kind) staleness stamp written by the catalog-sync workers
 * (cp-catalog-sync / capability-template-sync). Lets `/health` answer
 * "template kind empty+stale for N syncs" without a new table — the stamps
 * live under `pod_settings.settings.catalogSyncStamps`, keyed `${source}::${kind}`.
 */
/**
 * `misconfigured` is distinct from `unreachable` on purpose: a 4xx from the
 * catalog source means the pod asked for something the source will NEVER accept
 * (e.g. a retired `category`) — a permanent, operator-fixable fault, not a
 * transient outage. `/health` surfaces it as `catalog:<key>:misconfigured` so a
 * 400 can never masquerade as "source temporarily unavailable".
 */
export type CatalogSyncStatus =
  | "ok"
  | "empty"
  | "unreachable"
  | "misconfigured";
export interface CatalogSyncStamp {
  /** ISO timestamp of the last completed sync attempt (any outcome). */
  lastSyncAt: string;
  lastStatus: CatalogSyncStatus;
  /** Entry count from the last attempt (0 when empty/unreachable). */
  lastCount: number;
}

export interface PodSettingsBlob {
  intelligenceDefaults?: PodIntelligenceDefaults;
  proactiveDefaults?: PodProactiveDefaults;
  catalogSyncStamps?: Record<string, CatalogSyncStamp>;
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
