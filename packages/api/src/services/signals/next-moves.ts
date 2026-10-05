/**
 * THE NEXT-HOUR START TIER — the candidates behind relay Home's picker,
 * read where the lens page is read (`signals.list({ lens: "page", picks:
 * true })`) and ranked by THE ranking (`rankNextMoves`,
 * `@synap-core/types/lens` `next-moves.ts`) — the same function the header's
 * next move reads, so the two can never disagree.
 *
 * Candidates (real rows only, nothing estimated):
 *   - TASKS — `task` entities still open (`status` todo / in-progress, or
 *     unset), through the entity access floor under the workspace lens;
 *   - TRACK STEPS — open sessions (work or tracked run) of an ACTIVE track,
 *     through the session read floor and the triage lens (agent drafts are
 *     Proposed, never picks).
 * Each is dropped when it has an OPEN blocker (`readDependencyFacts` → THE
 * dependency rule), when it already sits on the page as Blocking or
 * Happening (`exclude` — a session owing you something is "only you can
 * answer", a session an agent is in is watched, not started), or when the
 * viewer skipped it until a moment still in the future (`nextMoveSkips`).
 *
 * Facts per candidate: open dependents (`unblocks`), since when it waited,
 * its project / track (names through their own visibility floors), and
 * "AI draft ready" — an AGENT-owned slot the agent claims it produced
 * (`claimedDone`) that is not yet done, i.e. an output waiting on the person.
 *
 * SKIPS live in the canonical per-user preference row
 * (`user_preferences.ui_preferences.nextMoveSkips`: `{ [wireKey]: untilIso }`)
 * — one map, pruned on every write. A skip hides a pick until `until` (the
 * viewer's next local midnight, sent by the client), never longer than
 * {@link MAX_SKIP_MS}.
 */

import {
  db,
  and,
  desc,
  eq,
  inArray,
  isNull,
  or,
  drizzleSql,
  entities,
  focusSessions,
  projectTracks,
} from "@synap/database";
import { userPreferences } from "@synap/database/schema";
import {
  NEXT_HOUR_PICKS,
  nextMoveCandidateOfWire,
  nextMoveKeyOfRow,
  rankNextMoves,
  type NextMoveWire,
} from "@synap-core/types/lens";
import { resolveSessionTitle } from "@synap-core/types/focus-sessions";
import { createLogger } from "@synap-core/core";
import { AccessContext, scopedDb } from "../../access/index.js";
import { sessionListConditions } from "../focus-sessions/session-list-conditions.js";
import { sessionKindWhere } from "../focus-sessions/session-kind.js";
import { OPEN_SESSION_STATUSES } from "../focus-sessions/session-statuses.js";
import { readDependencyFacts } from "../links/dependency-links.js";
import type { rosterReadFor } from "../../access/session-visibility.js";

const logger = createLogger({ module: "next-moves" });

/** Rows each candidate half scans, most recently moved first. */
export const NEXT_MOVE_SCAN_LIMIT = 50;
/** Picks the page sends — the picker's cap plus room for skips to refill. */
export const NEXT_MOVE_SEND_LIMIT = NEXT_HOUR_PICKS * 3;
/** A skip never hides a pick longer than this (a day and a half). */
export const MAX_SKIP_MS = 36 * 60 * 60 * 1000;
/** The preference key the skips live under. */
export const NEXT_MOVE_SKIPS_KEY = "nextMoveSkips";

/** `task.status` values that are still open (the closed enum's open half). */
const OPEN_TASK_STATUSES = ["todo", "in-progress"] as const;
/** Session statuses that were never begun — their verb is Start, not Resume. */
const NOT_BEGUN_SESSION_STATUSES = new Set(["forming", "scheduled"]);

export type NextMoveSubRead = "tasks" | "steps" | "dependencies" | "skips";

export interface NextMoveReadCtx {
  userId: string;
  roster: ReturnType<typeof rosterReadFor>;
  /** The caller context the access layer reads (`AccessContext.from`). */
  access: AccessContext;
}

interface Settled<T> {
  value: T;
  failed: NextMoveSubRead | null;
}

async function settle<T>(
  source: NextMoveSubRead,
  empty: T,
  read: () => Promise<T>
): Promise<Settled<T>> {
  try {
    return { value: await read(), failed: null };
  } catch (error) {
    logger.warn({ err: error, source }, "next-move sub-read failed");
    return { value: empty, failed: source };
  }
}

/** The viewer's live skips: wire key → until (ms), expired ones dropped. */
export function liveSkips(raw: unknown, now: number): Map<string, number> {
  const out = new Map<string, number>();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [key, until] of Object.entries(raw as Record<string, unknown>)) {
    const t = typeof until === "string" ? new Date(until).getTime() : NaN;
    if (Number.isFinite(t) && t > now) out.set(key, t);
  }
  return out;
}

async function readSkips(userId: string, now: number) {
  const [row] = await db
    .select({ ui: userPreferences.uiPreferences })
    .from(userPreferences)
    .where(eq(userPreferences.userId, userId))
    .limit(1);
  const ui = (row?.ui ?? {}) as Record<string, unknown>;
  return liveSkips(ui[NEXT_MOVE_SKIPS_KEY], now);
}

/**
 * Hide one pick until `until` (clamped to {@link MAX_SKIP_MS}). Writes ONLY
 * the `nextMoveSkips` key of the preference row (`jsonb_set`), pruning
 * expired entries, so no other preference is touched.
 */
export async function writeNextMoveSkip(input: {
  userId: string;
  key: string;
  until: Date;
  now?: Date;
}): Promise<{ until: string }> {
  const now = (input.now ?? new Date()).getTime();
  const until = new Date(
    Math.min(Math.max(input.until.getTime(), now), now + MAX_SKIP_MS)
  ).toISOString();
  const kept = await readSkips(input.userId, now);
  const next: Record<string, string> = {};
  for (const [k, t] of kept) next[k] = new Date(t).toISOString();
  next[input.key] = until;
  const json = JSON.stringify(next);
  await db
    .insert(userPreferences)
    .values({
      userId: input.userId,
      uiPreferences: drizzleSql`jsonb_build_object(${NEXT_MOVE_SKIPS_KEY}::text, ${json}::jsonb)`,
      updatedAt: new Date(now),
    })
    .onConflictDoUpdate({
      target: userPreferences.userId,
      set: {
        uiPreferences: drizzleSql`jsonb_set(coalesce(${userPreferences.uiPreferences}, '{}'::jsonb), ${`{${NEXT_MOVE_SKIPS_KEY}}`}::text[], ${json}::jsonb)`,
        updatedAt: new Date(now),
      },
    });
  return { until };
}

interface ExpectedOutputLike {
  owner?: string;
  status?: string;
  claimedDone?: boolean;
}

/** An agent-owned slot the agent claims it produced, not yet done. */
export function hasDraftReady(expectedOutputs: unknown): boolean {
  if (!Array.isArray(expectedOutputs)) return false;
  return (expectedOutputs as ExpectedOutputLike[]).some(
    (o) =>
      o != null &&
      typeof o === "object" &&
      (o.owner ?? "agent") === "agent" &&
      o.claimedDone === true &&
      o.status !== "done"
  );
}

const iso = (d: Date | string | null | undefined): string | null => {
  if (!d) return null;
  const t = d instanceof Date ? d : new Date(d);
  return Number.isFinite(t.getTime()) ? t.toISOString() : null;
};

/**
 * The page's `picks` — ranked, skips and excluded rows removed, capped at
 * {@link NEXT_MOVE_SEND_LIMIT}. A failed half is NAMED in `unreadable` and
 * keeps the halves that worked; it is never folded into "nothing to do".
 */
export async function readNextMovePicks(
  ctx: NextMoveReadCtx,
  input: { workspaceId?: string | null },
  opts: {
    /** Sessions already on the page as Blocking or Happening. */
    excludeSessionIds: ReadonlySet<string>;
    projectNames: (ids: string[]) => Promise<Map<string, string>>;
    now?: Date;
  }
): Promise<{ rows: NextMoveWire[]; truncated: boolean; unreadable: string[] }> {
  const now = opts.now ?? new Date();
  const lensed = scopedDb(ctx.access.withLens(input.workspaceId));

  const [skips, tasks, steps] = await Promise.all([
    settle("skips", new Map<string, number>(), () =>
      readSkips(ctx.userId, now.getTime())
    ),
    settle(
      "tasks",
      [] as Array<typeof taskCols>,
      () =>
        db
          .select(taskCols)
          .from(entities)
          .where(
            and(
              lensed.predicate(entities),
              eq(entities.type, "task"),
              isNull(entities.deletedAt),
              or(
                drizzleSql`${entities.properties}->>'status' IS NULL`,
                inArray(drizzleSql<string>`${entities.properties}->>'status'`, [
                  ...OPEN_TASK_STATUSES,
                ])
              )
            )
          )
          .orderBy(desc(entities.updatedAt), desc(entities.id))
          .limit(NEXT_MOVE_SCAN_LIMIT + 1) as unknown as Promise<
          Array<typeof taskCols>
        >
    ),
    settle("steps", [] as StepRow[], () => readSteps(ctx, input)),
  ]);

  const taskRows = (tasks.value as unknown as TaskRow[]).slice(
    0,
    NEXT_MOVE_SCAN_LIMIT
  );
  const stepRows = steps.value
    .slice(0, NEXT_MOVE_SCAN_LIMIT)
    .filter((s) => !opts.excludeSessionIds.has(s.id));

  const nodes = [
    ...taskRows.map((t) => ({ kind: "entity", id: t.id })),
    ...stepRows.map((s) => ({ kind: "session", id: s.id })),
  ];
  const deps = await settle("dependencies", null, () =>
    readDependencyFacts(nodes, ctx.userId)
  );
  const names = await opts
    .projectNames(
      [
        ...taskRows.map((t) => projectIdOf(t.properties)),
        ...stepRows.map((s) => s.projectId),
      ].filter((id): id is string => !!id)
    )
    .catch(() => new Map<string, string>());

  const wires: NextMoveWire[] = [];
  // Without the dependency read nothing can be told free: no picks, NAMED.
  if (deps.value) {
    const facts = deps.value;
    const project = (id: string | null | undefined) =>
      id && names.has(id) ? { id, name: names.get(id)! } : null;
    for (const t of taskRows) {
      const f = facts.get(`entity:${t.id}`);
      if (!f || f.openBlockers > 0) continue;
      const status = statusOf(t.properties);
      wires.push({
        key: `entity:${t.id}`,
        objectKind: "task",
        title: t.title?.trim() || "Untitled task",
        door: { kind: "entity", id: t.id },
        action: status === "in-progress" ? "resume" : "start",
        unblocks: f.unblocks,
        waitingSince: iso(t.createdAt),
        project: project(projectIdOf(t.properties)),
        track: null,
        draftReady: false,
      });
    }
    for (const s of stepRows) {
      const f = facts.get(`session:${s.id}`);
      if (!f || f.openBlockers > 0) continue;
      wires.push({
        key: `session:${s.id}`,
        objectKind: "session",
        title: resolveSessionTitle(s) || "Untitled step",
        door: { kind: "session", id: s.id },
        action: NOT_BEGUN_SESSION_STATUSES.has(s.status) ? "start" : "resume",
        unblocks: f.unblocks,
        waitingSince: iso(s.updatedAt),
        project: project(s.projectId),
        track: { id: s.trackId, name: s.trackName },
        draftReady: hasDraftReady(s.expectedOutputs),
      });
    }
  }

  const byKey = new Map(wires.map((w) => [w.key, w]));
  const ranked = rankNextMoves(wires.map(nextMoveCandidateOfWire), now)
    .map((m) => byKey.get(nextMoveKeyOfRow(m.row) ?? "")!)
    .filter((w) => w && !skips.value.has(w.key));

  const unreadable = [skips, tasks, steps, deps].flatMap((s) =>
    s.failed ? [s.failed] : []
  );
  return {
    rows: ranked.slice(0, NEXT_MOVE_SEND_LIMIT),
    truncated:
      unreadable.length > 0 ||
      ranked.length > NEXT_MOVE_SEND_LIMIT ||
      (tasks.value as unknown[]).length > NEXT_MOVE_SCAN_LIMIT ||
      steps.value.length > NEXT_MOVE_SCAN_LIMIT,
    unreadable,
  };
}

const taskCols = {
  id: entities.id,
  title: entities.title,
  properties: entities.properties,
  createdAt: entities.createdAt,
};

interface TaskRow {
  id: string;
  title: string | null;
  properties: unknown;
  createdAt: Date;
}

function statusOf(properties: unknown): string | null {
  const s = (properties as Record<string, unknown> | null)?.status;
  return typeof s === "string" ? s : null;
}

function projectIdOf(properties: unknown): string | null {
  const p = (properties as Record<string, unknown> | null)?.projectId;
  return typeof p === "string" && p ? p : null;
}

interface StepRow {
  id: string;
  title: string | null;
  goal: string | null;
  status: string;
  expectedOutputs: unknown;
  updatedAt: Date;
  projectId: string | null;
  trackId: string;
  trackName: string;
}

/**
 * Open sessions of ACTIVE tracks the viewer can read — work and tracked runs,
 * drafts excluded (`lens: "default"`, the triage lens), under the workspace
 * lens. The same conditions the Happening read builds its population from.
 */
async function readSteps(
  ctx: NextMoveReadCtx,
  input: { workspaceId?: string | null }
): Promise<StepRow[]> {
  const conditions = sessionListConditions({
    userId: ctx.userId,
    scope: { workspaceLens: input.workspaceId, projectLens: undefined },
    status: "all",
    lens: "default",
    kind: "all",
    roster: ctx.roster,
  });
  conditions.push(or(sessionKindWhere("work"), sessionKindWhere("run"))!);
  const rows = await db
    .select({
      id: focusSessions.id,
      title: focusSessions.title,
      goal: focusSessions.goal,
      status: focusSessions.status,
      expectedOutputs: focusSessions.expectedOutputs,
      updatedAt: focusSessions.updatedAt,
      projectId: focusSessions.projectId,
      trackId: projectTracks.id,
      trackName: projectTracks.name,
    })
    .from(focusSessions)
    .innerJoin(projectTracks, eq(projectTracks.id, focusSessions.trackId))
    .where(
      and(
        ...conditions,
        inArray(focusSessions.status, [...OPEN_SESSION_STATUSES]),
        eq(projectTracks.status, "active")
      )
    )
    .orderBy(desc(focusSessions.updatedAt), desc(focusSessions.id))
    .limit(NEXT_MOVE_SCAN_LIMIT + 1);
  return rows as StepRow[];
}
