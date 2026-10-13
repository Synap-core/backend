/**
 * Library KEEP-ALIVE (CAPTURE_LIBRARY_PLAN L5) — the daily pass that keeps a
 * Library from becoming a pile, without ever becoming an inbox.
 *
 * Three things, all QUIET (no counters, no pending approvals — a pending
 * approval is Blocking, and nothing here blocks anyone):
 *
 *   1. AUTO-ARCHIVE. An item nobody has looked at for `archiveAfterDays`
 *      (default 90) — not in any group, never built — gets
 *      `importCuration.archivedAt`. It stays searchable and comes back with
 *      `item.unarchive`; the Library just stops showing it by default. The
 *      clock is `importCuration.seenAt`, else the day it was kept. A grouped
 *      item is the group's, so it is never archived from under it.
 *   2. "BUILD ONE GROUP" — once a week per person, the group that has waited
 *      longest (kept items not built yet) is offered as a `suggestion`
 *      notification (`library.build_suggestion`, its 7-day window does the
 *      weekly cadence while this pass runs daily).
 *   3. RESURFACING — "From your Library, for <project>": kept items whose
 *      title or light-read summary names a project the person worked in this
 *      week (or that were kept into it), at most once a week per project
 *      (`library.resurface`).
 *
 * One pod setting (`pod_settings.settings.libraryKeepAlive`), default ON:
 * `enabled: false` stops 2 and 3; `archiveAfterDays: 0` stops 1.
 *
 * The AI's capture door is untouched; this reads the person's own Library only.
 */

import { db as defaultDb, podSettings, drizzleSql } from "@synap/database";
import { createLogger } from "@synap-core/core";
import { NotificationService } from "../../notifications/NotificationService.js";

const logger = createLogger({ module: "library/keep-alive" });

export const LIBRARY_KEEP_ALIVE_SETTING = "libraryKeepAlive" as const;

export interface LibraryKeepAliveSettings {
  /** Weekly "Build one group" + resurfacing. Default true (quiet: in-app only). */
  enabled: boolean;
  /** Days unseen before an ungrouped, unbuilt item is archived. 0 = never. */
  archiveAfterDays: number;
}

export const LIBRARY_KEEP_ALIVE_DEFAULTS: LibraryKeepAliveSettings = {
  enabled: true,
  archiveAfterDays: 90,
};

/** Never more than this many items archived in one pass (the next pass continues). */
export const ARCHIVE_BATCH_MAX = 2000;
/** A project name shorter than this would match too much text to mean anything. */
const RESURFACE_MIN_NAME = 4;
/** An item resurfaced must have been unseen this long. */
const RESURFACE_UNSEEN_DAYS = 14;
/** "This week": projects with session activity in this window. */
const CURRENT_WORK_DAYS = 7;

/** The setting as stored, with defaults for anything absent or malformed. */
export function readLibraryKeepAlive(
  blob: Record<string, unknown> | null | undefined
): LibraryKeepAliveSettings {
  const raw = blob?.[LIBRARY_KEEP_ALIVE_SETTING];
  const s = (raw && typeof raw === "object" ? raw : {}) as Record<
    string,
    unknown
  >;
  const days = s.archiveAfterDays;
  return {
    enabled:
      typeof s.enabled === "boolean"
        ? s.enabled
        : LIBRARY_KEEP_ALIVE_DEFAULTS.enabled,
    archiveAfterDays:
      typeof days === "number" && Number.isInteger(days) && days >= 0
        ? days
        : LIBRARY_KEEP_ALIVE_DEFAULTS.archiveAfterDays,
  };
}

export async function loadLibraryKeepAlive(
  database: typeof defaultDb = defaultDb
): Promise<LibraryKeepAliveSettings> {
  const [row] = await database
    .select({ settings: podSettings.settings })
    .from(podSettings)
    .orderBy(podSettings.createdAt)
    .limit(1);
  return readLibraryKeepAlive(
    (row?.settings ?? null) as Record<string, unknown> | null
  );
}

type Rows<T> = { rows?: T[] } | T[];
function rowsOf<T>(result: Rows<T>): T[] {
  return Array.isArray(result) ? result : (result.rows ?? []);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** 1 — archive ungrouped, unbuilt items unseen for `days`. Returns how many. */
export async function archiveUnseenLibraryItems(args: {
  database?: typeof defaultDb;
  days: number;
  now?: Date;
}): Promise<number> {
  if (args.days <= 0) return 0;
  const database = args.database ?? defaultDb;
  const now = args.now ?? new Date();
  const cutoff = new Date(now.getTime() - args.days * DAY_MS).toISOString();
  const stamp = JSON.stringify(now.toISOString());
  const result = await database.execute(drizzleSql`
    UPDATE documents SET metadata = jsonb_set(
      metadata, '{importCuration}',
      COALESCE(metadata -> 'importCuration', '{}'::jsonb)
        || jsonb_build_object('archivedAt', ${stamp}::jsonb, 'archivedBy', '"auto"'::jsonb),
      true)
    WHERE id IN (
      SELECT id FROM documents
      WHERE deleted_at IS NULL AND metadata ? 'importItem'
        AND (metadata #>> '{importCuration,archivedAt}') IS NULL
        AND (metadata #>> '{importCuration,builtAt}') IS NULL
        AND jsonb_array_length(COALESCE(metadata -> 'importCuration' -> 'groupIds', '[]'::jsonb)) = 0
        AND COALESCE((metadata #>> '{importCuration,seenAt}')::timestamptz, created_at)
            < ${cutoff}::timestamptz
      ORDER BY created_at
      LIMIT ${ARCHIVE_BATCH_MAX}
    )
    RETURNING id`);
  return rowsOf<{ id: string }>(result as Rows<{ id: string }>).length;
}

export interface WaitingGroup {
  groupId: string;
  userId: string;
  workspaceId: string | null;
  name: string;
  waiting: number;
  oldest: Date;
}

/** Per person, the live group whose kept-but-not-built items have waited longest. */
export async function longestWaitingGroups(
  database: typeof defaultDb = defaultDb
): Promise<WaitingGroup[]> {
  const result = await database.execute(drizzleSql`
    SELECT DISTINCT ON (g.user_id)
      g.id AS "groupId", g.user_id AS "userId", g.workspace_id AS "workspaceId",
      g.name, count(d.id)::int AS waiting, min(d.created_at) AS oldest
    FROM library_groups g
    JOIN documents d
      ON d.user_id = g.user_id AND d.deleted_at IS NULL
     AND d.metadata ? 'importItem'
     AND COALESCE(d.metadata -> 'importCuration' -> 'groupIds', '[]'::jsonb) ? g.id::text
     AND (d.metadata #>> '{importCuration,archivedAt}') IS NULL
     AND (g.built_at IS NULL OR d.created_at > g.built_at)
    WHERE g.archived_at IS NULL AND g.building_at IS NULL
    GROUP BY g.id
    ORDER BY g.user_id, min(d.created_at) ASC`);
  return rowsOf<WaitingGroup & { oldest: Date | string }>(
    result as Rows<WaitingGroup & { oldest: Date | string }>
  ).map((r) => ({ ...r, oldest: new Date(r.oldest) }));
}

export interface ResurfaceCandidate {
  userId: string;
  projectId: string;
  projectName: string;
  workspaceId: string | null;
  count: number;
  titles: string[];
}

/**
 * Per person, the project of this week's work with the most kept items that
 * name it (title / light-read summary) or were kept into it. Unseen ≥ 14 days,
 * not archived, not built.
 */
export async function resurfaceCandidates(args: {
  database?: typeof defaultDb;
  now?: Date;
}): Promise<ResurfaceCandidate[]> {
  const database = args.database ?? defaultDb;
  const now = args.now ?? new Date();
  const since = new Date(now.getTime() - CURRENT_WORK_DAYS * DAY_MS);
  const unseen = new Date(now.getTime() - RESURFACE_UNSEEN_DAYS * DAY_MS);
  const result = await database.execute(drizzleSql`
    WITH current_work AS (
      SELECT DISTINCT fs.user_id, p.id AS project_id, p.name, p.workspace_id
      FROM focus_sessions fs JOIN projects p ON p.id = fs.project_id
      WHERE fs.status = 'active' AND fs.updated_at >= ${since.toISOString()}::timestamptz
        AND NOT (COALESCE(fs.metadata, '{}'::jsonb) ? 'importCuration')
        AND p.status = 'active' AND p.user_id = fs.user_id
        AND length(btrim(p.name)) >= ${RESURFACE_MIN_NAME}
    ),
    matches AS (
      SELECT cw.user_id, cw.project_id, cw.name, cw.workspace_id, d.id, d.title, d.created_at
      FROM current_work cw
      JOIN documents d ON d.user_id = cw.user_id AND d.deleted_at IS NULL
       AND d.metadata ? 'importItem'
       AND (d.metadata #>> '{importCuration,archivedAt}') IS NULL
       AND (d.metadata #>> '{importCuration,builtAt}') IS NULL
       AND COALESCE((d.metadata #>> '{importCuration,seenAt}')::timestamptz, d.created_at)
           < ${unseen.toISOString()}::timestamptz
      LEFT JOIN focus_sessions run ON run.id::text = d.metadata #>> '{intakeSource,sessionId}'
      WHERE run.project_id = cw.project_id
         OR strpos(lower(COALESCE(d.title, '')), lower(btrim(cw.name))) > 0
         OR strpos(lower(COALESCE(d.metadata #>> '{importRead,summary}', '')), lower(btrim(cw.name))) > 0
    )
    SELECT DISTINCT ON (user_id)
      user_id AS "userId", project_id AS "projectId", name AS "projectName",
      workspace_id AS "workspaceId", count(*)::int AS count,
      (array_agg(COALESCE(title, 'Untitled') ORDER BY created_at DESC))[1:3] AS titles
    FROM matches
    GROUP BY user_id, project_id, name, workspace_id
    ORDER BY user_id, count(*) DESC`);
  return rowsOf<ResurfaceCandidate>(result as Rows<ResurfaceCandidate>);
}

export interface LibraryKeepAliveResult {
  settings: LibraryKeepAliveSettings;
  archived: number;
  suggested: number;
  resurfaced: number;
}

type Notify = (
  input: Parameters<typeof NotificationService.create>[0]
) => Promise<string | undefined>;

/** The daily pass (`library-keep-alive` queue). */
export async function runLibraryKeepAlive(args?: {
  database?: typeof defaultDb;
  now?: Date;
  notify?: Notify;
}): Promise<LibraryKeepAliveResult> {
  const database = args?.database ?? defaultDb;
  const now = args?.now ?? new Date();
  const notify: Notify =
    args?.notify ?? ((input) => NotificationService.create(input));
  const settings = await loadLibraryKeepAlive(database);

  const archived = await archiveUnseenLibraryItems({
    database,
    days: settings.archiveAfterDays,
    now,
  });

  let suggested = 0;
  let resurfaced = 0;
  if (settings.enabled) {
    for (const g of await longestWaitingGroups(database)) {
      const waitDays = Math.max(
        0,
        Math.floor((now.getTime() - g.oldest.getTime()) / DAY_MS)
      );
      const id = await notify({
        type: "library.build_suggestion",
        userId: g.userId,
        workspaceId: g.workspaceId,
        sourceType: "system",
        sourceId: g.groupId,
        // One a week per PERSON, whichever group it names.
        groupKey: `library.build_suggestion:${g.userId}`,
        data: {
          groupId: g.groupId,
          groupName: g.name,
          waiting: g.waiting,
          waitDays,
        },
      });
      if (id) suggested++;
    }
    for (const c of await resurfaceCandidates({ database, now })) {
      const id = await notify({
        type: "library.resurface",
        userId: c.userId,
        workspaceId: c.workspaceId,
        sourceType: "system",
        sourceId: c.projectId,
        groupKey: `library.resurface:${c.userId}:${c.projectId}`,
        data: {
          projectId: c.projectId,
          projectName: c.projectName,
          count: c.count,
          titles: c.titles.join(", "),
        },
      });
      if (id) resurfaced++;
    }
  }
  const result = { settings, archived, suggested, resurfaced };
  logger.info(result, "library keep-alive pass");
  return result;
}
