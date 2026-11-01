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
  isSessionPushMuted,
  normalizePushPrefs,
  PUSH_MUTED_SESSIONS_MAX,
  type PushCategory,
  type PushPrefs,
} from "@synap-core/types/push";

/** No row ⇒ defaults (`{}`). A FAILED read throws — never read as defaults. */
export async function readPushPrefs(
  userId: string,
  database: typeof db = db
): Promise<PushPrefs> {
  return (await readPodPushSettings(userId, database)).prefs;
}

/**
 * Everything the push decision reads from the person's POD-WIDE row: their
 * categories, and the per-type routing rules that may FORCE a push. A forced
 * push is the person's own statement about their phone, so only the pod-wide
 * row can make it — a workspace override row must never ring a phone the
 * person silenced. A FAILED read throws.
 */
export async function readPodPushSettings(
  userId: string,
  database: typeof db = db
): Promise<{
  prefs: PushPrefs;
  routingRules: Record<string, string>;
}> {
  const row = await database.query.notificationPreferences.findFirst({
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
  const categories = normalizePushPrefs({
    categories: patch.categories,
  }).categories;

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

/**
 * Mute or unmute ONE session's pushes (`push_prefs.mutedSessions`, plan
 * d679e92c C9), IN SQL, so two devices muting two sessions at once both land
 * and a session already muted is not listed twice. Creates the pod-wide row
 * when the person has none. The caller checks the person may read the
 * session. Returns whether it is muted after the write (read back, never
 * assumed). A FAILED write or read throws.
 */
export async function writeSessionMute(
  userId: string,
  sessionId: string,
  muted: boolean
): Promise<boolean> {
  const id = sessionId.toLowerCase();
  const pp = notificationPreferences.pushPrefs;
  // The stored list, or [] when absent or not a list (a malformed value is
  // replaced, never concatenated onto).
  const current = drizzleSql`(CASE WHEN jsonb_typeof(${pp}->'mutedSessions') = 'array'
    THEN ${pp}->'mutedSessions' ELSE '[]'::jsonb END)`;
  // `jsonb - text` drops the id wherever it is; a mute appends it last, so the
  // oldest mute is the one dropped first.
  const appended = muted
    ? drizzleSql`((${current} - ${id}::text) || to_jsonb(${id}::text))`
    : drizzleSql`(${current} - ${id}::text)`;
  // Trimmed to PUSH_MUTED_SESSIONS_MAX in the same write: the stored list is
  // the one the read keeps (`normalizePushPrefs` keeps the newest that many).
  // Left to grow, an unmute would bring an older mute back inside the read's
  // window, muting a session the person stopped seeing as muted long ago.
  const next = drizzleSql`(SELECT coalesce(jsonb_agg(m.e ORDER BY m.o), '[]'::jsonb)
    FROM jsonb_array_elements(${appended}) WITH ORDINALITY AS m(e, o)
    WHERE m.o > jsonb_array_length(${appended}) - ${PUSH_MUTED_SESSIONS_MAX}::int)`;
  await db
    .insert(notificationPreferences)
    .values({
      userId,
      workspaceId: null,
      pushPrefs: muted ? { mutedSessions: [id] } : {},
    })
    .onConflictDoUpdate({
      target: notificationPreferences.userId,
      targetWhere: drizzleSql`workspace_id IS NULL`,
      set: {
        pushPrefs: drizzleSql`(coalesce(${pp}, '{}'::jsonb)
          || jsonb_build_object('mutedSessions', ${next}))`,
        updatedAt: new Date(),
      },
    });
  return isSessionPushMuted(await readPushPrefs(userId), id);
}
