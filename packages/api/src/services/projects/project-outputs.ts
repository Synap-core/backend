/**
 * PROJECT OUTPUTS — what a project's sessions PRODUCED, newest first
 * (`projects.outputs`, Hub `GET /projects/:projectId/outputs`).
 *
 * ── ONE JOIN, ONE SESSION SET, NOTHING RE-DERIVED ───────────────────────────
 *   - The per-output join is `listOutputsForSessions` — the SAME three-ledger
 *     join (`produced` edges, `artifacts`, declared `expected_outputs`), title
 *     oracle and precedence rule `focusSessions.outputs` runs for one session,
 *     batched over the project's sessions in a fixed number of queries.
 *   - The session SET is `projectPathConditions` — the project path's own
 *     population (work + runs filed in a track, default triage lens), so a
 *     session's outputs appear here exactly when that session appears on the
 *     path.
 *
 * ── VISIBILITY ──────────────────────────────────────────────────────────────
 *   - The PROJECT goes through the `projects` VisibilityRule
 *     (`access/project-visibility.ts`, via `scopedDb(access).predicate`): a
 *     project the caller cannot see answers `null` (404 at the doors).
 *   - The ROWS go through the `focus_sessions` VisibilityRule
 *     (`scopedDb(access).predicate(focusSessions)`). That rule is OWNER-ONLY
 *     today (`workspaceOwned`, `nullWorkspaceMeans: "ownerPrivate"`,
 *     `access/registry.ts`): a workspace lens narrows, it never admits another
 *     member's session. So on a shared project this read returns the CALLER'S
 *     sessions' outputs — the same set the path shows. Widening it to every
 *     member's work is a change to that rule (a founder decision), never a
 *     local exception here.
 *
 * ── SESSION OUTPUTS ONLY ────────────────────────────────────────────────────
 * Entities merely FILED in the project (`belongs_to_project` edges) are not
 * outputs and are not read here — they belong under the project's Context.
 * Declared deliverables with nothing produced behind them (`pendingExpected`)
 * are not outputs either; the owed/expected boards own them.
 */

import { TRPCError } from "@trpc/server";
import { db, focusSessions, projects, and, desc, eq } from "@synap/database";
import { resolveSessionTitle } from "@synap-core/types/focus-sessions";
import { scopedDb, type AccessContext } from "../../access/index.js";
import {
  listOutputsForSessions,
  type SessionOutput,
} from "../focus-sessions/session-outputs.js";
import { projectPathConditions } from "./project-path.js";

export const PROJECT_OUTPUTS_MAX_LIMIT = 100;

/**
 * How many of the project's sessions one read joins outputs for — the most
 * recently ACTIVE first (`updated_at desc`, the session's last write, which a
 * produced output bumps). The three-ledger join cannot be paged in SQL, so the
 * bound is on the sessions scanned; past it the result says `truncated: true`
 * and older sessions' outputs are not in the pages — reported, never silently
 * dropped.
 */
export const PROJECT_OUTPUTS_SESSION_SCAN = 200;

export interface ProjectOutputsQuery {
  database?: typeof db;
  /** The caller — both visibility floors are applied for this identity. */
  access: AccessContext;
  projectId: string;
  /** Only outputs of sessions filed in this track. */
  trackId?: string;
  /**
   * Only outputs of sessions filed at this STAGE of a track
   * (`focus_sessions.track_stage`, 0274). Stage keys are per-method, so pair it
   * with `trackId`; alone it matches that key in any of the project's tracks.
   */
  trackStage?: string;
  /** Narrow to these workspaces (a confined key). Absent / empty ⇒ every one. */
  workspaceIds?: string[];
  /** Opaque, from a previous page's `nextCursor`. */
  cursor?: string;
  limit: number;
}

/** One thing the project's work produced. */
export interface ProjectOutputItem {
  /** `<sessionId>|<kind>:<refId>` — stable across refetches, unique per row. */
  id: string;
  /** Normalized object kind (`document`, `entity`, `view`, `cell`, `url`, …). */
  kind: string;
  title: string;
  /** The DOOR: open this object (`kind` + the underlying object's id). */
  ref: { kind: string; id: string };
  /** The session that produced it. */
  sessionId: string;
  sessionTitle: string;
  /** The track that session was filed in, when it was. */
  trackId: string | null;
  /** The track STAGE that session was filed at (0274), when it was. */
  trackStage: string | null;
  /** When it was produced (ISO). */
  createdAt: string;
  /** Artifact lifecycle, when an artifact row backs this output. */
  state?: SessionOutput["state"];
  producedBy?: SessionOutput["producedBy"];
}

export interface ProjectOutputsResult {
  items: ProjectOutputItem[];
  /** Pass back as `cursor` for the next (older) page; `null` = no more. */
  nextCursor: string | null;
  /**
   * The project has more sessions than {@link PROJECT_OUTPUTS_SESSION_SCAN}:
   * only the most recently active ones were read, so the least recently
   * active sessions' outputs are missing from every page.
   */
  truncated: boolean;
}

type Key = { at: string; id: string };

function encodeCursor(k: Key): string {
  return Buffer.from(JSON.stringify(k), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): Key {
  try {
    const k = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (typeof k?.at === "string" && typeof k?.id === "string") return k;
  } catch {
    // fall through to the refusal — a bad cursor is the caller's error
  }
  throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid cursor" });
}

/** Newest first; `id` breaks ties so paging never repeats or skips a row. */
function newerFirst(a: Key, b: Key): number {
  if (a.at !== b.at) return a.at < b.at ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/** Returns `null` when the project does not exist or the caller cannot see it. */
export async function listProjectOutputs(
  query: ProjectOutputsQuery
): Promise<ProjectOutputsResult | null> {
  const database = query.database ?? db;
  const scoped = scopedDb(query.access);
  const limit = Math.max(1, Math.min(query.limit, PROJECT_OUTPUTS_MAX_LIMIT));
  const after = query.cursor ? decodeCursor(query.cursor) : null;

  const [project] = await database
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, query.projectId), scoped.predicate(projects)))
    .limit(1);
  if (!project) return null;

  // SESSION-KIND-LENS-EXEMPT: returns outputs, never a session row; the session set is projectPathConditions (kind + triage lens applied in SQL).
  const scanned = await database
    .select({
      id: focusSessions.id,
      title: focusSessions.title,
      goal: focusSessions.goal,
      trackId: focusSessions.trackId,
      trackStage: focusSessions.trackStage,
      expectedOutputs: focusSessions.expectedOutputs,
    })
    .from(focusSessions)
    .where(
      and(
        ...projectPathConditions({
          userId: query.access.userId,
          projectId: query.projectId,
          workspaceIds: query.workspaceIds,
          lens: "default",
        }),
        scoped.predicate(focusSessions),
        ...(query.trackId ? [eq(focusSessions.trackId, query.trackId)] : []),
        ...(query.trackStage
          ? [eq(focusSessions.trackStage, query.trackStage)]
          : [])
      )
    )
    .orderBy(desc(focusSessions.updatedAt), desc(focusSessions.id))
    .limit(PROJECT_OUTPUTS_SESSION_SCAN + 1);
  const truncated = scanned.length > PROJECT_OUTPUTS_SESSION_SCAN;
  const sessions = scanned.slice(0, PROJECT_OUTPUTS_SESSION_SCAN);

  const joined = await listOutputsForSessions(database, sessions);
  const all: ProjectOutputItem[] = [];
  for (const s of sessions) {
    const sessionTitle = resolveSessionTitle(s);
    for (const o of joined.get(s.id)?.outputs ?? []) {
      all.push({
        id: `${s.id}|${o.id}`,
        kind: o.kind,
        title: o.title,
        ref: { kind: o.kind, id: o.refId },
        sessionId: s.id,
        sessionTitle,
        trackId: s.trackId ?? null,
        trackStage: s.trackStage ?? null,
        createdAt: new Date(o.producedAt).toISOString(),
        ...(o.state ? { state: o.state } : {}),
        ...(o.producedBy ? { producedBy: o.producedBy } : {}),
      });
    }
  }

  const keyOf = (i: ProjectOutputItem): Key => ({ at: i.createdAt, id: i.id });
  const ordered = all
    .sort((a, b) => newerFirst(keyOf(a), keyOf(b)))
    .filter((i) => !after || newerFirst(after, keyOf(i)) < 0);
  const page = ordered.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page,
    nextCursor:
      ordered.length > limit && last ? encodeCursor(keyOf(last)) : null,
    truncated,
  };
}
