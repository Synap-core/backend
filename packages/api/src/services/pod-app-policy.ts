/**
 * The pod admin's policy for pod apps (spec 17 PB4) — server-owned, on the
 * singleton `pod_settings.settings.podApps` blob (the `machineDefaults`
 * pattern: no table, one jsonb key merged in place).
 *
 * `allowUnverified` (founder decision F4): a member may connect an app that
 * is not a Synap app (`isSynapApp`), within their own floor. Absent = ON.
 * OFF, the OAuth door refuses such an app at phase 1 of /authorize and on the
 * consent screen (`resolveClientAndRedirect`), before its metadata document
 * is fetched. Connections made before the switch went off are not touched:
 * the admin ends them from the Apps page (`apps.adminRevokeClient`).
 *
 * Written only by a signed-in pod admin through `apps.adminSetPolicy`, which
 * refuses an agent's credential; nothing else writes it.
 */

import { db, eq, and, isNull, drizzleSql } from "@synap/database";
import { apps, podSettings } from "@synap/database/schema";
import { isSynapApp } from "../routers/oauth/config.js";

export interface PodAppPolicy {
  allowUnverified: boolean;
  /** Who last changed it, and when; null while it is the default. */
  changedBy: string | null;
  changedAt: string | null;
}

export async function readPodAppPolicy(): Promise<PodAppPolicy> {
  const [pod] = await db
    .select({ settings: podSettings.settings })
    .from(podSettings)
    .orderBy(podSettings.createdAt)
    .limit(1);
  const stored = pod?.settings?.podApps;
  return {
    allowUnverified: stored?.allowUnverified !== false,
    changedBy: stored?.changedBy ?? null,
    changedAt: stored?.changedAt ?? null,
  };
}

/** May an app with this OAuth `client_id` (a CIMD URL) connect right now? */
export async function podAppMayConnect(clientId: string): Promise<boolean> {
  if (isSynapApp(clientId)) return true;
  return (await readPodAppPolicy()).allowUnverified;
}

/** Set the policy. The caller has checked the pod admin; this only stores. */
export async function setPodAppPolicy(input: {
  allowUnverified: boolean;
  changedBy: string;
}): Promise<PodAppPolicy> {
  const podApps = {
    allowUnverified: input.allowUnverified,
    changedBy: input.changedBy,
    changedAt: new Date().toISOString(),
  };
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
          { podApps }
        )}::jsonb`,
        updatedAt: new Date(),
      })
      .where(eq(podSettings.id, existing.id));
  } else {
    await db.insert(podSettings).values({ settings: { podApps } });
  }
  return readPodAppPolicy();
}

/**
 * How many live connections of apps that are NOT Synap apps this pod holds —
 * what switching `allowUnverified` off leaves running (it gates new
 * connections only).
 */
export async function countLiveUnverifiedConnections(): Promise<number> {
  const rows = await db
    .select({ clientId: apps.oauthClientId })
    .from(apps)
    .where(
      and(
        eq(apps.mode, "oauth"),
        isNull(apps.revokedAt),
        isNull(apps.removedAt)
      )
    );
  return rows.filter((r) => r.clientId && !isSynapApp(r.clientId)).length;
}
