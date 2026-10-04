/**
 * Real dependencies for `createPodUpdatesRouter` and the provision-status
 * `updates` section. Storage follows the `accountRecovery.cloudTrust`
 * precedent: the singleton `pod_settings.settings` blob, key `updates`,
 * written with a single `jsonb_set` so sibling settings are untouched.
 */

import { authMiddleware } from "@synap/auth";
import { refuseGuestSession } from "@synap/api";
import { drizzleSql, eq, getDb } from "@synap/database";
import { podSettings } from "@synap/database/schema";
import { readLastUpdate, type PodUpdateSettings } from "../pod-updates/index.js";
import {
  audit,
  findAccountByIdentity,
  isPodAdmin,
} from "./account-recovery-deps.js";
import type { PodUpdatesDeps } from "./pod-updates.js";

/** Raw `pod_settings.settings.updates` (undefined when never set). Throws on a failed read. */
export async function readPodUpdateSettingsRaw(): Promise<unknown> {
  const db = await getDb();
  const [row] = await db
    .select({ settings: podSettings.settings })
    .from(podSettings)
    .orderBy(podSettings.createdAt)
    .limit(1);
  return (row?.settings as { updates?: unknown } | undefined)?.updates;
}

async function writePodUpdateSettings(next: PodUpdateSettings): Promise<void> {
  const db = await getDb();
  const value = { ...next, updatedAt: new Date().toISOString() };
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
          '{updates}',
          ${JSON.stringify(value)}::jsonb,
          true
        )`,
        updatedAt: new Date(),
      })
      .where(eq(podSettings.id, existing.id));
  } else {
    await db.insert(podSettings).values({ settings: { updates: value } });
  }
}

export const podUpdatesDeps: PodUpdatesDeps = {
  authenticate: [authMiddleware, refuseGuestSession],
  resolveUserId: async (identityId) =>
    (await findAccountByIdentity(identityId))?.userId ?? null,
  isPodAdmin,
  readSettingsRaw: readPodUpdateSettingsRaw,
  writeSettings: writePodUpdateSettings,
  readLastUpdate: () => readLastUpdate(),
  audit,
};
