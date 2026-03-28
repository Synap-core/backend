/**
 * Proactive AI Preferences Types
 *
 * Controls the AI's proactive intelligence features: morning briefings,
 * weekly digests, health checks, and nudge density. Stored per workspace.
 *
 * These are re-exported from the workspace schema definition but kept in
 * a dedicated module for discoverability. Safe to import in browser builds
 * (no drizzle/postgres dependency).
 *
 * @see {@link @synap/database/schema workspaces.ts} for the canonical source
 */

export type ProactiveNudgeDensity = "minimal" | "balanced" | "proactive";

export interface ProactiveAiPreferences {
  /** Global kill switch for all proactive AI features. Default: true */
  enabled: boolean;
  morningBriefing: {
    enabled: boolean;
    /** Hour in 24h format (0-23). Default: 8 */
    cronHour: number;
    /** Minute (0-59). Default: 0 */
    cronMinute: number;
    /** IANA timezone. Default: "UTC" */
    timezone: string;
  };
  weeklyDigest: {
    enabled: boolean;
    /** Day of week: 0=Sun..6=Sat. Default: 1 (Monday) */
    dayOfWeek: number;
    /** Hour in 24h format. Default: 9 */
    cronHour: number;
    /** IANA timezone. Default: "UTC" */
    timezone: string;
  };
  healthCheck: {
    enabled: boolean;
    /** How often to run health checks in days. Default: 7 */
    frequencyDays: number;
  };
  /** Controls how many proactive nudges the AI sends. Default: "balanced" */
  nudgeDensity: ProactiveNudgeDensity;
  /** ISO 8601 timestamp — snooze all proactive AI until this time */
  mutedUntil?: string;
}

/** Default proactive AI preferences for new workspaces */
export function getDefaultProactiveAiPreferences(): ProactiveAiPreferences {
  return {
    enabled: true,
    morningBriefing: {
      enabled: true,
      cronHour: 8,
      cronMinute: 0,
      timezone: "UTC",
    },
    weeklyDigest: {
      enabled: true,
      dayOfWeek: 1,
      cronHour: 9,
      timezone: "UTC",
    },
    healthCheck: {
      enabled: true,
      frequencyDays: 7,
    },
    nudgeDensity: "balanced",
  };
}
