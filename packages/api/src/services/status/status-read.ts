/**
 * WHERE DOES IT STAND — one read for any id (status-flow plan W0b): a thing
 * with a declared lifecycle, a goal, a work session or a playbook run. Each
 * answer carries its status and words, its fixed CATEGORY (open · active ·
 * paused · done · lost), since when (the transition log, else a stored date,
 * said as not measured), whether it is stuck (only where the lifecycle
 * declares `stuckAfterDays`) and what it waits on (`status-facts.ts`). A
 * paused thing also carries its current `hold`; a session carries `live` (the
 * 5-minute working rule, `isSessionWorkingNow`) and its `nextMove` (THE packet
 * rule, read through the list rows' batched sections). Every answer carries
 * its `tone` (THE tone table: the declared option's, else the status word's),
 * and with `include: ["moves"]` a thing with a declared lifecycle carries the
 * moves its step offers (`stepsFromLifecycle`, `offPathChoices`).
 *
 * Served by orient's `statusOf` (MCP, Hub REST) and tRPC `lifecycle.statusOf`
 * (the screens' door): one function, three doors. An id the caller cannot see
 * reads exactly like one that does not exist: `type: "unknown"`.
 */
import { z } from "zod";
import { createLogger } from "@synap-core/core";
import {
  and,
  db,
  entities,
  focusSessions,
  inArray,
  isLifecycleCategory,
  isNull,
  listHolds,
  playbookRuns,
  projectTracks,
  ProfileResolutionService,
} from "@synap/database";
import type { ProjectTrack } from "@synap/database/schema";
import {
  findLifecycleOption,
  lifecycleOptionLabel,
  lifecycleOptionTone,
  offPathChoices,
  stepsFromLifecycle,
  type LifecycleCategory,
  type LifecycleOption,
  type RecordedHold,
} from "@synap-core/types/lifecycle";
import { isSessionWorkingNow } from "@synap-core/types/run-activity";
import {
  resolveStatusTone,
  trackStatusCategory,
  type UnitTone,
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
import type { ContinuationNextMove } from "../focus-sessions/continuation-packet.js";
// Static, not loaded late: this pulls the continuation packet in with this
// module, so the waiting-on collector's own late import of the packet never
// meets it half-evaluated (vitest's module runner hands a module caught in an
// import cycle back before it finished).
import {
  attachNextMove,
  type PathSourceRow,
} from "../focus-sessions/session-path-sections.js";
import { loadSessionLiveness } from "../runs/session-liveness.js";
import {
  lastTransitionAt,
  readWaitingOnFor,
  runStatusCategory,
  sessionWaitingOnQuestion,
  type WaitingOnQuestion,
} from "./status-facts.js";

const logger = createLogger({ module: "status-read" });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Ids one orient call may ask about. */
export const STATUS_OF_MAX = 10;

/** `statusOf` as both doors (MCP, REST) accept it: more than 10 is refused. */
export const statusOfInput = z
  .array(z.string().min(1).max(100))
  .max(STATUS_OF_MAX)
  .optional();

/** What an answer may carry beyond its status, on request. */
export const STATUS_OF_INCLUDES = ["moves"] as const;
export type StatusOfInclude = (typeof STATUS_OF_INCLUDES)[number];

/** `include` as the doors accept it: an unknown part is refused. */
export const statusOfIncludeInput = z
  .array(z.enum(STATUS_OF_INCLUDES))
  .max(STATUS_OF_INCLUDES.length)
  .optional();

/**
 * A move a thing's step offers: every declared option but the one it stands
 * on, the main path first (declared order), then the off-path ones. It moves
 * only through `moveStatus`; this is what a surface may offer.
 */
export interface StatusOfMove {
  /** The option key a move targets. */
  to: string;
  label: string;
  /** Only a person may move a thing INTO it. */
  humanOnly: boolean;
  /** It is a pause: the move must say what it waits on (a hold). */
  needsHold: boolean;
}

type Unavailable = { status: "unavailable" };
const UNAVAILABLE: Unavailable = { status: "unavailable" };

export interface StatusOf {
  id: string;
  type: "entity" | "goal" | "session" | "run";
  name: string | null;
  status: string | null;
  label: string | null;
  category: LifecycleCategory | null;
  /**
   * THE tone of its status: the declared option's (`lifecycleOptionTone`),
   * else the status word's (`resolveStatusTone`); null with no status.
   */
  tone: UnitTone | null;
  /** When it entered this status (ISO), or a stored fallback (below). */
  since: string | null;
  /** False: no move was recorded, so `since` is when it was created or started. */
  sinceMeasured: boolean;
  /** Present only when its step declares a stuck rule and it is past it. */
  stuck?: { afterDays: number; forDays: number };
  waitingOn: WaitingOnMark[] | Unavailable;
  /**
   * Its CURRENT hold — what the pause waits on and how it resumes — when it
   * stands in a paused status under one (`listHolds`); absent otherwise.
   */
  hold?: RecordedHold | Unavailable;
  /** Sessions only: is an agent working on it now (the 5-minute rule). */
  live?:
    | { status: "ok"; state: "working" | "idle"; lastActivityAt: string | null }
    | Unavailable;
  /** Sessions only: THE next move (`deriveNextMove`). */
  nextMove?: ContinuationNextMove;
  /**
   * Things with a declared lifecycle, on `include: ["moves"]` only: the
   * moves its step offers ({@link StatusOfMove}).
   */
  moves?: StatusOfMove[];
  link: string;
}

export type StatusOfAnswer = StatusOf | { id: string; type: "unknown" };

const iso = (d: Date | string | null | undefined) =>
  d ? new Date(d).toISOString() : null;

/** The tone of a status with no declared option: the status word's. */
const toneOf = (status: string | null | undefined): UnitTone | null =>
  status ? resolveStatusTone(status) : null;

/** The moves a thing standing on `current` is offered, from the step helpers. */
function movesFrom(
  decl: { readonly options: readonly LifecycleOption[] },
  current: string | null
): StatusOfMove[] {
  const steps = [
    ...stepsFromLifecycle(decl, current).filter(
      (s) => s.position !== "current" && s.position !== "off"
    ),
    ...offPathChoices(decl, current),
  ];
  return steps.map((s) => ({
    to: s.key,
    label: s.label,
    humanOnly: s.humanOnly === true,
    needsHold: s.category === "paused",
  }));
}

/** A part of the answer that could not be read is `unavailable`, never empty. */
async function orUnavailable<T>(p: Promise<T>): Promise<T | Unavailable> {
  try {
    return await p;
  } catch (err) {
    logger.warn({ err }, "statusOf: a part of the answer could not be read");
    return { status: "unavailable" };
  }
}

export async function readStatusOf(
  userId: string,
  rawIds: readonly string[],
  opts: { include?: readonly StatusOfInclude[] } = {}
): Promise<StatusOfAnswer[]> {
  const withMoves = opts.include?.includes("moves") ?? false;
  // The doors cap the list (`statusOfInput`); nothing is dropped here.
  const asked = [...new Set(rawIds)];
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
        // What the next move and liveness read (`sessionFacts`).
        workspaceId: focusSessions.workspaceId,
        projectId: focusSessions.projectId,
        expectedOutputs: focusSessions.expectedOutputs,
        origin: focusSessions.origin,
        metadata: focusSessions.metadata,
        userId: focusSessions.userId,
        criteria: focusSessions.criteria,
        channelId: focusSessions.channelId,
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
  // One lifecycle read per (profile, space) for the whole call.
  const resolver = new ProfileResolutionService(db);
  const lifecycles = new Map<
    string,
    ReturnType<typeof resolver.getEffectiveLifecycle>
  >();
  const lifecycleOf = (profileId: string, workspaceId: string | null) => {
    const key = `${profileId}|${workspaceId ?? ""}`;
    let read = lifecycles.get(key);
    if (!read) {
      read = resolver.getEffectiveLifecycle(profileId, workspaceId);
      lifecycles.set(key, read);
    }
    return read;
  };
  const goalFacts = goals.length
    ? import("../tracks/goal-content.js").then((m) =>
        m.loadTrackGoalFacts(goals, userId)
      )
    : null;
  goalFacts?.catch(() => undefined);

  // ONE waiting-on read for every thing, session and run asked about.
  const questions = new Map<string, WaitingOnQuestion>();
  for (const t of things) {
    questions.set(t.id, {
      owed: { subject: { kind: "entities", entityIds: [t.id] } },
      proposals: { targetIds: [t.id] },
      blockedNodes: [{ kind: "entity", id: t.id }],
      holds: [{ subjectType: "entity", subjectId: t.id }],
      steps: [{ subjectType: "entity", subjectId: t.id }],
    });
  }
  for (const sid of new Set([
    ...sessions.map((s) => s.id),
    ...runs.flatMap((r) => (r.sessionId ? [r.sessionId] : [])),
  ])) {
    questions.set(`session:${sid}`, sessionWaitingOnQuestion(sid));
  }
  const waiting = questions.size
    ? readWaitingOnFor({ userId }, questions)
    : Promise.resolve(new Map<string, WaitingOnMark[]>());
  waiting.catch(() => undefined);
  const waitingOf = (key: string) =>
    orUnavailable(waiting.then((m) => m.get(key) ?? []));

  // The current hold of everything asked about, one read; shown only for a
  // thing in a paused status (a hold is current only while it stands there).
  const held = listHolds(db, {
    subjects: [
      ...things.map((t) => ({
        subjectType: "entity" as const,
        subjectId: t.id,
      })),
      ...goals.map((g) => ({ subjectType: "track" as const, subjectId: g.id })),
      ...sessions.map((s) => ({
        subjectType: "focus_session" as const,
        subjectId: s.id,
      })),
    ],
  }).then(
    (holds) =>
      new Map(
        holds
          .filter((h) => h.facetId == null)
          .map((h) => [`${h.subjectType}:${h.subjectId}`, h.hold])
      )
  );
  held.catch(() => undefined);
  const holdOf = async (
    key: string,
    category: LifecycleCategory | null
  ): Promise<{ hold?: RecordedHold | Unavailable }> => {
    if (category !== "paused") return {};
    const hold = await orUnavailable(held.then((m) => m.get(key) ?? null));
    return hold ? { hold } : {};
  };

  for (const t of things) {
    answers.set(
      t.id,
      (async (): Promise<StatusOf> => {
        const lifecycle = t.profileId
          ? await lifecycleOf(t.profileId, t.workspaceId)
          : null;
        const option = findLifecycleOption(lifecycle, t.status);
        // The declared option first (the rollups read it too), else the
        // stored projection, so the two can never disagree.
        const category =
          option?.category ??
          (isLifecycleCategory(t.statusCategory) ? t.statusCategory : null);
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
          category,
          tone: option ? lifecycleOptionTone(option) : toneOf(t.status),
          ...since,
          ...(forDays !== null && afterDays !== undefined
            ? { stuck: { afterDays, forDays } }
            : {}),
          waitingOn: await waitingOf(t.id),
          ...(await holdOf(`entity:${t.id}`, category)),
          ...(withMoves && lifecycle
            ? { moves: movesFrom(lifecycle, t.status ?? null) }
            : {}),
          link: openLink(t.id),
        };
      })()
    );
  }
  for (const g of goals) {
    answers.set(
      g.id,
      (async (): Promise<StatusOf> => {
        const category = trackStatusCategory(g.status);
        return {
          id: g.id,
          type: "goal",
          name: g.name,
          status: g.status,
          label: resolveTrackStatusLabel(g.status),
          category,
          tone: toneOf(g.status),
          ...sinceOf(`track:${g.id}`, g.createdAt),
          waitingOn: await orUnavailable(
            goalFacts!.then((f) => f.get(g.id)?.waitingOn ?? [])
          ),
          ...(await holdOf(`track:${g.id}`, category)),
          link: openLink(g.id),
        };
      })()
    );
  }
  const sessionLive = sessionFacts(userId, sessions);
  for (const s of sessions) {
    const done = s.closedAt != null;
    const category = sessionStatusCategory(s.status);
    answers.set(
      s.id,
      (async (): Promise<StatusOf> => {
        const facts = await sessionLive;
        return {
          id: s.id,
          type: "session",
          name: resolveSessionTitle(s) || null,
          status: s.status,
          label: resolveStatusLabel(s.status),
          category,
          tone: toneOf(s.status),
          ...sinceOf(`focus_session:${s.id}`, done ? s.closedAt : s.startedAt),
          waitingOn: await waitingOf(`session:${s.id}`),
          ...(await holdOf(`focus_session:${s.id}`, category)),
          live: facts.live.get(s.id) ?? UNAVAILABLE,
          ...(facts.nextMove.has(s.id)
            ? { nextMove: facts.nextMove.get(s.id)! }
            : {}),
          link: openLink(s.id),
        };
      })()
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
        tone: toneOf(r.status),
        since: iso(r.completedAt ?? r.startedAt),
        sinceMeasured: settled,
        waitingOn: r.sessionId ? await waitingOf(`session:${r.sessionId}`) : [],
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

type SessionFactsRow = PathSourceRow & {
  channelId: string | null;
  startedAt: Date | string | null;
};

/**
 * Liveness and THE next move of the asked sessions, each in one batched read
 * — the same readers the list rows and the graph use (`loadSessionLiveness`,
 * `attachNextMove`), so a session reads alike on every surface.
 */
async function sessionFacts(
  userId: string,
  rows: readonly SessionFactsRow[]
): Promise<{
  live: Map<string, NonNullable<StatusOf["live"]>>;
  nextMove: Map<string, ContinuationNextMove>;
}> {
  if (rows.length === 0) return { live: new Map(), nextMove: new Map() };
  const [facts, moved] = await Promise.all([
    loadSessionLiveness({ userId, roster: false }, rows).catch(
      () => new Map<string, null>()
    ),
    attachNextMove(rows, { userId, logContext: { door: "statusOf" } }).catch(
      () => null
    ),
  ]);
  const now = Date.now();
  const live = new Map<string, NonNullable<StatusOf["live"]>>();
  for (const r of rows) {
    const f = facts.get(r.id);
    live.set(
      r.id,
      f
        ? {
            status: "ok",
            state: isSessionWorkingNow(f, now) ? "working" : "idle",
            lastActivityAt: iso(f.lastAt),
          }
        : UNAVAILABLE
    );
  }
  const nextMove = new Map<string, ContinuationNextMove>(
    rows.map((r, i) => [
      r.id,
      moved?.[i]?.nextMove ?? {
        kind: "unknown",
        actor: "none",
        label: "Next move unknown",
        reason: "What this session's next move is could not be read.",
      },
    ])
  );
  return { live, nextMove };
}
