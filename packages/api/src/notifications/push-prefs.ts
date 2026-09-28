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
  const row = await db.query.notificationPreferences.findFirst({
    where: and(
      eq(notificationPreferences.userId, userId),
      isNull(notificationPreferences.workspaceId)
    ),
    columns: { pushPrefs: true },
  });
  return normalizePushPrefs(row?.pushPrefs);
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

  const podRow = and(
    eq(notificationPreferences.userId, userId),
    isNull(notificationPreferences.workspaceId)
  );
  const existing = await db.query.notificationPreferences.findFirst({
    where: podRow,
    columns: { id: true },
  });
  if (!existing) {
    await db
      .insert(notificationPreferences)
      .values({ userId, workspaceId: null, pushPrefs: {} });
  }

  const catsJson = JSON.stringify(categories ?? {});
  await db
    .update(notificationPreferences)
    .set({
      pushPrefs: drizzleSql`(coalesce(${notificationPreferences.pushPrefs}, '{}'::jsonb)
        || jsonb_build_object('categories',
             coalesce(${notificationPreferences.pushPrefs}->'categories', '{}'::jsonb)
             || ${catsJson}::jsonb))`,
      updatedAt: new Date(),
    })
    .where(podRow);

  return readPushPrefs(userId);
}
