/**
 * Real dependencies for `createPodRateLimitsRouter` and the edge's watcher
 * (`watchPodRateLimits`). Storage follows `pod-updates-deps.ts`: the singleton
 * `pod_settings.settings` blob, key `rateLimits`, written with a single
 * `jsonb_set` so sibling settings are untouched.
 */

import { authMiddleware } from "@synap/auth";
import { refuseGuestSession } from "@synap/api";
import { drizzleSql, eq, getDb } from "@synap/database";
import { podSettings } from "@synap/database/schema";
import type { RateLimitOverrides } from "../middleware/rate-limit-classes.js";
import {
  audit,
  findAccountByIdentity,
  isPodAdmin,
} from "./account-recovery-deps.js";
import type { PodRateLimitsDeps } from "./pod-rate-limits.js";

/** Raw `pod_settings.settings.rateLimits.values` (undefined when never set). Throws on a failed read. */
export async function readPodRateLimitValuesRaw(): Promise<unknown> {
  const db = await getDb();
  const [row] = await db
    .select({ settings: podSettings.settings })
    .from(podSettings)
    .orderBy(podSettings.createdAt)
    .limit(1);
  return (row?.settings as { rateLimits?: { values?: unknown } } | undefined)
    ?.rateLimits?.values;
}

async function writePodRateLimitValues(
  values: RateLimitOverrides,
  changedBy: string
): Promise<void> {
  const db = await getDb();
  const value = { values, changedBy, changedAt: new Date().toISOString() };
  const [existing] = await db
    .select({ id: podSettings.id })
    .from(podSettings)
    .orderBy(podSettings.createdAt)
    .limit(1);
  if (existing) {
    await db
      .update(podSettings)
      .set({
        settings: drizzleSql`jsonb_set(
          coalesce(${podSettings.settings}, '{}'::jsonb),
          '{rateLimits}',
          ${JSON.stringify(value)}::jsonb,
          true
        )`,
        updatedAt: new Date(),
      })
      .where(eq(podSettings.id, existing.id));
  } else {
    await db.insert(podSettings).values({ settings: { rateLimits: value } });
  }
}

export const podRateLimitsDeps: PodRateLimitsDeps = {
  authenticate: [authMiddleware, refuseGuestSession],
  resolveUserId: async (identityId) =>
    (await findAccountByIdentity(identityId))?.userId ?? null,
  isPodAdmin,
  readValuesRaw: readPodRateLimitValuesRaw,
  writeValues: writePodRateLimitValues,
  audit,
};
