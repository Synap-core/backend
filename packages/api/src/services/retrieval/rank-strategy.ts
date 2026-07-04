/**
 * Rank-strategy resolution — the REVERSIBILITY seam.
 *
 * The active re-rank strategy lives in `pod_settings.settings.memoryStrategy`
 * (a JSONB blob — NO schema migration). When absent / unknown / on ANY read
 * error we fall back to `'baseline'` (the unchanged pre-Horizon ranker), so:
 *   - deploying this code changes NOTHING until a pod admin opts in, and
 *   - reverting is a single JSONB key flip back to 'baseline' (no redeploy).
 *
 * This is read once per retrieval at the composite-rerank seam.
 */
import { db, podSettings } from "@synap/database";

export type RankStrategy = "baseline" | "horizon";

/** Read the active strategy; default `'baseline'` (safe, reversible). */
export async function resolveRankStrategy(): Promise<RankStrategy> {
  try {
    const rows = await db
      .select({ settings: podSettings.settings })
      .from(podSettings)
      .limit(1);
    const s = rows[0]?.settings?.memoryStrategy;
    return s === "horizon" ? "horizon" : "baseline";
  } catch {
    // A settings-read outage must never break recall — degrade to the default.
    return "baseline";
  }
}
