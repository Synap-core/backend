/**
 * Per-connection personalisation — PIN and what the person HEARS about one
 * connection (Connected, founder decision 7).
 *
 * Stored on the person's POD-WIDE `notification_preferences` row, column
 * `connection_prefs` (0316), keyed `<kind>:<id>` with `kind` a membrane
 * `CONNECTION_KINDS` member — the same key the Connected page gives each row
 * (`app:<public_id>`, `account:<provider>`, `model:<providerId>`, …). SPARSE:
 * a key the person never touched reads as {@link CONNECTION_PREF_DEFAULTS}.
 *
 * Why here and not `user_preferences.ui_preferences`: that column's write door
 * replaces the whole blob and strips unknown keys, and the notifier already
 * reads this row. The pin rides along so one connection has ONE record.
 */
import { z } from "zod";
import {
  and,
  db,
  drizzleSql,
  eq,
  isNull,
  notificationPreferences,
} from "@synap/database";
import {
  CONNECTION_KINDS,
  type ConnectionKind,
} from "@synap-core/types/membrane";

/** What the person hears about one connection. */
export const CONNECTION_NOTIFY_LEVELS = [
  "everything",
  "problems",
  "nothing",
] as const;
export type ConnectionNotifyLevel = (typeof CONNECTION_NOTIFY_LEVELS)[number];

export interface ConnectionPref {
  pinned: boolean;
  notify: ConnectionNotifyLevel;
}

/** A key nobody set: not pinned, problems only (the founder's default). */
export const CONNECTION_PREF_DEFAULTS: ConnectionPref = {
  pinned: false,
  notify: "problems",
};

/**
 * Which notices a connection produces. `problem` = it stopped working or needs
 * the person (kept under `problems`); `info` = it worked (only `everything`).
 * Declared per type on the registry (`NotificationDef.connectionNotice`).
 */
export type ConnectionNoticeClass = "problem" | "info";

export interface ConnectionRef {
  kind: ConnectionKind;
  id: string;
}

export const connectionPrefKey = (c: ConnectionRef): string =>
  `${c.kind}:${c.id}`;

const KIND_SET: ReadonlySet<string> = new Set(CONNECTION_KINDS);
const LEVEL_SET: ReadonlySet<string> = new Set(CONNECTION_NOTIFY_LEVELS);

/** A stored key is `<kind>:<id>` with a real kind and a non-empty id. */
function isConnectionKey(key: string): boolean {
  const at = key.indexOf(":");
  return at > 0 && at < key.length - 1 && KIND_SET.has(key.slice(0, at));
}

/**
 * The stored column → the effective pref per stored key. Malformed keys and
 * values are dropped (a value the reader cannot read is never shown as set).
 */
export function normalizeConnectionPrefs(
  raw: unknown
): Record<string, ConnectionPref> {
  const out: Record<string, ConnectionPref> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isConnectionKey(key)) continue;
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const v = value as Record<string, unknown>;
    const pinned = typeof v.pinned === "boolean" ? v.pinned : undefined;
    const notify =
      typeof v.notify === "string" && LEVEL_SET.has(v.notify)
        ? (v.notify as ConnectionNotifyLevel)
        : undefined;
    if (pinned === undefined && notify === undefined) continue;
    out[key] = {
      pinned: pinned ?? CONNECTION_PREF_DEFAULTS.pinned,
      notify: notify ?? CONNECTION_PREF_DEFAULTS.notify,
    };
  }
  return out;
}

/** No row ⇒ `{}`. A FAILED read throws — never answered as "nothing set". */
export async function readConnectionPrefs(
  userId: string
): Promise<Record<string, ConnectionPref>> {
  const row = await db.query.notificationPreferences.findFirst({
    where: and(
      eq(notificationPreferences.userId, userId),
      isNull(notificationPreferences.workspaceId)
    ),
    columns: { connectionPrefs: true },
  });
  return normalizeConnectionPrefs(row?.connectionPrefs);
}

export const connectionPrefPatchSchema = z
  .object({
    kind: z.enum(CONNECTION_KINDS),
    id: z.string().trim().min(1).max(512),
    pinned: z.boolean().optional(),
    notify: z.enum(CONNECTION_NOTIFY_LEVELS).optional(),
  })
  .refine(
    (p) => p.pinned !== undefined || p.notify !== undefined,
    "Nothing to change."
  );
export type ConnectionPrefPatch = z.infer<typeof connectionPrefPatchSchema>;

/**
 * Merge ONE connection's patch into the pod-wide row, IN SQL: other keys, and
 * the field of this key not named, are left as stored — so a pin from the
 * phone and a notify change from the desktop both land. Creates the pod-wide
 * row when the person has none. Returns the key's effective pref.
 */
export async function writeConnectionPref(
  userId: string,
  patch: ConnectionPrefPatch
): Promise<{ key: string; pref: ConnectionPref }> {
  const key = connectionPrefKey(patch);
  const fields: Partial<ConnectionPref> = {};
  if (patch.pinned !== undefined) fields.pinned = patch.pinned;
  if (patch.notify !== undefined) fields.notify = patch.notify;
  const fieldsJson = JSON.stringify(fields);

  // ONE statement on the pod-wide row's partial unique index (0290), so two
  // first writes can never leave two pod-wide rows. The key is a bound
  // parameter, never interpolated into SQL.
  await db
    .insert(notificationPreferences)
    .values({ userId, workspaceId: null, connectionPrefs: { [key]: fields } })
    .onConflictDoUpdate({
      target: notificationPreferences.userId,
      targetWhere: drizzleSql`workspace_id IS NULL`,
      set: {
        connectionPrefs: drizzleSql`(coalesce(${notificationPreferences.connectionPrefs}, '{}'::jsonb)
          || jsonb_build_object(${key}::text,
               coalesce(${notificationPreferences.connectionPrefs}->${key}::text, '{}'::jsonb)
               || ${fieldsJson}::jsonb))`,
        updatedAt: new Date(),
      },
    });

  const stored = await readConnectionPrefs(userId);
  return { key, pref: stored[key] ?? { ...CONNECTION_PREF_DEFAULTS } };
}

/** Does a notice of `noticeClass` reach a person whose level is `level`? Pure. */
export function connectionNoticeDelivered(
  level: ConnectionNotifyLevel,
  noticeClass: ConnectionNoticeClass
): boolean {
  if (level === "nothing") return false;
  if (level === "problems") return noticeClass === "problem";
  return true;
}
