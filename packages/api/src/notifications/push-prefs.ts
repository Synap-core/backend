/**
 * The person's push categories — `notification_preferences.push_prefs` on
 * their POD-WIDE row (0289). Push is about the person's phone, not a
 * workspace, so a workspace override row never holds or shadows it.
 *
 * Shape and defaults: `PushPrefs` in `@synap-core/types/push`. Stored SPARSE —
 * only what the person set — so a category they never touched keeps following
 * its default if the default changes.
 */
import {
  and,
  db,
  drizzleSql,
  eq,
  isNull,
  notificationPreferences,
} from "@synap/database";
import {
  normalizePushPrefs,
  type PushCategory,
  type PushPrefs,
} from "@synap-core/types/push";

/** No row ⇒ defaults (`{}`). A FAILED read throws — never read as defaults. */
export async function readPushPrefs(userId: string): Promise<PushPrefs> {
  return (await readPodPushSettings(userId)).prefs;
}

/**
 * Everything the push decision reads from the person's POD-WIDE row: their
 * categories, and the per-type routing rules that may FORCE a push. A forced
 * push is the person's own statement about their phone, so only the pod-wide
 * row can make it — a workspace override row must never ring a phone the
 * person silenced. A FAILED read throws.
 */
export async function readPodPushSettings(userId: string): Promise<{
  prefs: PushPrefs;
  routingRules: Record<string, string>;
}> {
  const row = await db.query.notificationPreferences.findFirst({
    where: and(
      eq(notificationPreferences.userId, userId),
      isNull(notificationPreferences.workspaceId)
    ),
    columns: { pushPrefs: true, routingRules: true },
  });
  const rules = row?.routingRules;
  return {
    prefs: normalizePushPrefs(row?.pushPrefs),
    routingRules:
      rules && typeof rules === "object" && !Array.isArray(rules)
        ? (rules as Record<string, string>)
        : {},
  };
}

export interface PushPrefsPatch {
  /** Categories to set; others are left as stored. */
  categories?: Partial<Record<PushCategory, boolean>>;
}

/**
 * Merge a patch into the person's pod-wide push prefs, IN SQL, so two devices
 * toggling two categories at once both land. Creates the pod-wide row when the
 * person has none. Returns the stored prefs after the write.
 */
export async function writePushPrefs(
  userId: string,
  patch: PushPrefsPatch
): Promise<PushPrefs> {
  const categories = normalizePushPrefs({ categories: patch.categories })
    .categories;

  const catsJson = JSON.stringify(categories ?? {});
  const initial = { categories: categories ?? {} };
  // ONE statement: insert the pod-wide row, or merge into it. The partial
  // unique index (0290) is the conflict target, so two first writes can
  // never leave two pod-wide rows.
  await db
    .insert(notificationPreferences)
    .values({ userId, workspaceId: null, pushPrefs: initial })
    .onConflictDoUpdate({
      target: notificationPreferences.userId,
      targetWhere: drizzleSql`workspace_id IS NULL`,
      set: {
        pushPrefs: drizzleSql`(coalesce(${notificationPreferences.pushPrefs}, '{}'::jsonb)
          || jsonb_build_object('categories',
               coalesce(${notificationPreferences.pushPrefs}->'categories', '{}'::jsonb)
               || ${catsJson}::jsonb))`,
        updatedAt: new Date(),
      },
    });

  return readPushPrefs(userId);
}
