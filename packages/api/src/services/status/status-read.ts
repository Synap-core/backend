/**
 * WHERE DOES IT STAND — one read for any id (status-flow plan W0b): a thing
 * with a declared lifecycle, a goal, a work session or a playbook run. Each
 * answer carries its status and words, its fixed CATEGORY (open · active ·
 * paused · done · lost), since when (the transition log, else a stored date,
 * said as not measured), whether it is stuck (only where the lifecycle
 * declares `stuckAfterDays`) and what it waits on (`status-facts.ts`).
 *
 * Served by orient's `statusOf` (no tool of its own). An id the caller cannot
 * see reads exactly like one that does not exist: `type: "unknown"`.
 */
import {
  and,
  db,
  entities,
  focusSessions,
  inArray,
  isLifecycleCategory,
  isNull,
  playbookRuns,
  projectTracks,
  ProfileResolutionService,
} from "@synap/database";
import type { ProjectTrack } from "@synap/database/schema";
import {
  findLifecycleOption,
  lifecycleOptionLabel,
  type LifecycleCategory,
} from "@synap-core/types/lifecycle";
import {
  trackStatusCategory,
  type WaitingOnMark,
} from "@synap-core/types/units";
import {
  resolveSessionTitle,
  sessionStatusCategory,
} from "@synap-core/types/focus-sessions";
import {
  resolveStatusLabel,
  resolveTrackStatusLabel,
} from "@synap-core/types/vocabulary";
import { AccessContext, scopedDb } from "../../access/index.js";
import { entityReadVisibleWhere } from "../../access/entity-read-floor.js";
import { sessionReadableWhere } from "../../access/session-visibility.js";
import { openLink } from "../../utils/deep-links.js";
import { stuckAfterDaysOf, stuckForDays } from "../lifecycle/status-groups.js";
import {
  lastTransitionAt,
  readWaitingOn,
  runStatusCategory,
} from "./status-facts.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Ids one orient call may ask about. */
export const STATUS_OF_MAX = 10;

type Unavailable = { status: "unavailable" };

export interface StatusOf {
  id: string;
  type: "entity" | "goal" | "session" | "run";
  name: string | null;
  status: string | null;
  label: string | null;
  category: LifecycleCategory | null;
  /** When it entered this status (ISO), or a stored fallback (below). */
  since: string | null;
  /** False: no move was recorded, so `since` is when it was created or started. */
  sinceMeasured: boolean;
  /** Present only when its step declares a stuck rule and it is past it. */
  stuck?: { afterDays: number; forDays: number };
  waitingOn: WaitingOnMark[] | Unavailable;
  link: string;
}

export type StatusOfAnswer = StatusOf | { id: string; type: "unknown" };

const iso = (d: Date | string | null | undefined) =>
  d ? new Date(d).toISOString() : null;

/** A part of the answer that could not be read is `unavailable`, never empty. */
async function orUnavailable<T>(p: Promise<T>): Promise<T | Unavailable> {
  try {
    return await p;
  } catch {
    return { status: "unavailable" };
  }
}

export async function readStatusOf(
  userId: string,
  rawIds: readonly string[]
): Promise<StatusOfAnswer[]> {
  const asked = [...new Set(rawIds)].slice(0, STATUS_OF_MAX);
  // Every id column is a uuid: anything else is simply not a thing here.
  const ids = asked.filter((id) => UUID.test(id));
  if (ids.length === 0) return asked.map((id) => ({ id, type: "unknown" }));
  const access = scopedDb(AccessContext.from({ userId }));
  const [things, goals, sessions, runs] = await Promise.all([
    db
      .select({
        id: entities.id,
        title: entities.title,
        status: entities.status,
        statusCategory: entities.statusCategory,
        profileId: entities.profileId,
        workspaceId: entities.workspaceId,
        createdAt: entities.createdAt,
      })
      .from(entities)
      .where(
        and(
          inArray(entities.id, ids),
          isNull(entities.deletedAt),
          entityReadVisibleWhere(userId)
        )
      ),
    access.findMany<ProjectTrack>(projectTracks, {
      where: inArray(projectTracks.id, ids),
    }),
    db
      .select({
        id: focusSessions.id,
        title: focusSessions.title,
        goal: focusSessions.goal,
        status: focusSessions.status,
        startedAt: focusSessions.startedAt,
        closedAt: focusSessions.closedAt,
      })
      .from(focusSessions)
      .where(
        and(inArray(focusSessions.id, ids), sessionReadableWhere({ userId }))
      ),
    access.findMany<typeof playbookRuns.$inferSelect>(playbookRuns, {
      where: inArray(playbookRuns.id, ids),
    }),
  ]);

  const moved = await lastTransitionAt([
    ...things.map((t) => ({ type: "entity" as const, id: t.id })),
    ...goals.map((g) => ({ type: "track" as const, id: g.id })),
    ...sessions.map((s) => ({ type: "focus_session" as const, id: s.id })),
  ]);
  const sinceOf = (key: string, fallback: Date | string | null) => {
    const at = moved.get(key);
    return { since: iso(at ?? fallback), sinceMeasured: at !== undefined };
  };

  const answers = new Map<string, Promise<StatusOf>>();
  const resolver = new ProfileResolutionService(db);
  const goalFacts = goals.length
    ? import("../tracks/goal-content.js").then((m) =>
        m.loadTrackGoalFacts(goals, userId)
      )
    : null;
  goalFacts?.catch(() => undefined);

  for (const t of things) {
    answers.set(
      t.id,
      (async (): Promise<StatusOf> => {
        const lifecycle = t.profileId
          ? await resolver.getEffectiveLifecycle(t.profileId, t.workspaceId)
          : null;
        const option = findLifecycleOption(lifecycle, t.status);
        const since = sinceOf(`entity:${t.id}`, t.createdAt);
        const afterDays =
          lifecycle && t.status
            ? stuckAfterDaysOf(lifecycle.options).get(t.status)
            : undefined;
        const forDays =
          since.since && afterDays !== undefined
            ? stuckForDays(since.since, afterDays)
            : null;
        return {
          id: t.id,
          type: "entity",
          name: t.title ?? null,
          status: t.status ?? null,
          label: option
            ? lifecycleOptionLabel(option)
            : t.status
              ? resolveStatusLabel(t.status)
              : null,
          category: isLifecycleCategory(t.statusCategory)
            ? t.statusCategory
            : null,
          ...since,
          ...(forDays !== null && afterDays !== undefined
            ? { stuck: { afterDays, forDays } }
            : {}),
          waitingOn: await orUnavailable(
            readWaitingOn({
              userId,
              owed: { subject: { kind: "entities", entityIds: [t.id] } },
              proposals: { targetIds: [t.id] },
              blockedNodes: [{ kind: "entity", id: t.id }],
            })
          ),
          link: openLink(t.id),
        };
      })()
    );
  }
  for (const g of goals) {
    answers.set(
      g.id,
      (async (): Promise<StatusOf> => ({
        id: g.id,
        type: "goal",
        name: g.name,
        status: g.status,
        label: resolveTrackStatusLabel(g.status),
        category: trackStatusCategory(g.status),
        ...sinceOf(`track:${g.id}`, g.createdAt),
        waitingOn: await orUnavailable(
          goalFacts!.then((f) => f.get(g.id)?.waitingOn ?? [])
        ),
        link: openLink(g.id),
      }))()
    );
  }
  const sessionWaitingOn = (sessionId: string) =>
    orUnavailable(
      readWaitingOn({
        userId,
        owed: { sessionIds: [sessionId] },
        proposals: { sessionIds: [sessionId] },
        blockedNodes: [{ kind: "session", id: sessionId }],
      })
    );
  for (const s of sessions) {
    const done = s.closedAt != null;
    answers.set(
      s.id,
      (async (): Promise<StatusOf> => ({
        id: s.id,
        type: "session",
        name: resolveSessionTitle(s) || null,
        status: s.status,
        label: resolveStatusLabel(s.status),
        category: sessionStatusCategory(s.status),
        ...sinceOf(`focus_session:${s.id}`, done ? s.closedAt : s.startedAt),
        waitingOn: await sessionWaitingOn(s.id),
        link: openLink(s.id),
      }))()
    );
  }
  for (const r of runs) {
    // A run moves through no door, so it has no transition: a settled run's
    // completion time is when it entered its status; a live one's is unknown.
    const settled = r.completedAt != null;
    answers.set(
      r.id,
      (async (): Promise<StatusOf> => ({
        id: r.id,
        type: "run",
        name: null,
        status: r.status,
        label: resolveStatusLabel(r.status),
        category: runStatusCategory(r.status),
        since: iso(r.completedAt ?? r.startedAt),
        sinceMeasured: settled,
        waitingOn: r.sessionId ? await sessionWaitingOn(r.sessionId) : [],
        link: openLink(r.sessionId ?? r.id),
      }))()
    );
  }

  return Promise.all(
    asked.map(
      (id): Promise<StatusOfAnswer> =>
        answers.get(id) ?? Promise.resolve({ id, type: "unknown" })
    )
  );
}
