/**
 * WHERE DOES IT STAND — one read for any id (status-flow plan W0b): a thing
 * with a declared lifecycle, a goal, a work session or a playbook run. Each
 * answer carries its status and words, its fixed CATEGORY (open · active ·
 * paused · done · lost), since when (the transition log, else a stored date,
 * said as not measured), whether it is stuck (only where the lifecycle
 * declares `stuckAfterDays`) and what it waits on (`status-facts.ts`). A
 * paused thing also carries its current `hold`; a session carries `live` (the
 * 5-minute working rule, `isSessionWorkingNow`) and its `nextMove` (THE packet
 * rule, read through the list rows' batched sections). A thing with a declared
 * lifecycle and a goal carry theirs too, the same shape from the facts this
 * read already holds (`deriveThingNextMove`, `deriveGoalNextMove`,
 * `next-move.ts`): no further read. Every answer carries
 * its `tone` (THE tone table: the declared option's, else the status word's).
 * A thing carries its `roles` (the role facets it wears, each with its own
 * status, under THE facet visibility rule, `readThingRoles`) and, when it
 * works at one the reader may read (`works_at`), its `account` line.
 *
 * On `include` (`STATUS_OF_INCLUDES`, `@synap-core/types/units`):
 *   moves    a thing's step's moves (`stepsFromLifecycle`, `offPathChoices`);
 *   history  THE timeline (`readTimeline`), kept to its status events;
 *   links    a goal's or a session's `serves` edges, each end the reader sees;
 *   rollup   a goal's tree down `serves` (`readGoalTreeRollups`);
 *   signals  the status signals (`status_signal_raised`) still open;
 *   episodes its wait episodes (`readWaitEpisodes`), newest first.
 * A part that could not be read is `unavailable`, never empty.
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
  desc,
  entities,
  eq,
  focusSessions,
  inArray,
  isLifecycleCategory,
  isNull,
  links,
  listHolds,
  or,
  playbookRuns,
  readWaitEpisodes,
  projectTracks,
  ProfileResolutionService,
  relations,
  statusSignalRaised,
  type CurrentHold,
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
  STATUS_OF_HISTORY_MAX,
  STATUS_OF_INCLUDES,
  isStatusHistoryEvent,
  resolveStatusTone,
  trackStatusCategory,
  type StatusOfAccount,
  type StatusOfHistory,
  type StatusOfInclude,
  type StatusOfLinkEnd,
  type StatusOfLinks,
  type StatusOfRole,
  type StatusOfRollup,
  type StatusOfSignal,
  type UnitTone,
  type WaitEpisode,
  type WaitingOnMark,
} from "@synap-core/types/units";
import { isStatusSignal } from "@synap-core/types/lifecycle";
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
  deriveGoalNextMove,
  deriveThingNextMove,
  type NextMoveHoldFact,
} from "./next-move.js";
import { readThingRoles, type ThingRoleRow } from "./status-roles.js";
import {
  holdWaitingOnRef,
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

export { STATUS_OF_INCLUDES, type StatusOfInclude };

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
  /**
   * THE next move: a session's (`deriveNextMove`), a thing's with a declared
   * lifecycle (`deriveThingNextMove`) and a goal's (`deriveGoalNextMove`).
   */
  nextMove?: ContinuationNextMove;
  /**
   * Things with a declared lifecycle, on `include: ["moves"]` only: the
   * moves its step offers ({@link StatusOfMove}).
   */
  moves?: StatusOfMove[];
  /** Things only: the roles it wears that the reader may see. */
  roles?: StatusOfRole[] | Unavailable;
  /** Things only: the account it works at, when the reader may read it. */
  account?: StatusOfAccount;
  /** On `include: ["history"]` (things, goals, sessions). */
  history?: StatusOfHistory | Unavailable;
  /** On `include: ["links"]` (goals, sessions): its `serves` edges. */
  links?: StatusOfLinks | Unavailable;
  /** On `include: ["rollup"]` (goals): its tree, down `serves`. */
  rollup?: StatusOfRollup | Unavailable;
  /** On `include: ["signals"]` (things, goals, sessions): those still open. */
  signals?: StatusOfSignal[] | Unavailable;
  /**
   * On `include: ["episodes"]` (things, goals, sessions): its wait episodes,
   * newest first, an open one with `closedAt: null`. A thing's include its
   * roles' episodes only for the roles the reader may see.
   */
  episodes?: WaitEpisode[] | Unavailable;
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

/** A paused subject's hold as the next move reads it (with its waiting-on ref). */
function holdFact(
  hold: RecordedHold | Unavailable | undefined
): NextMoveHoldFact {
  if (!hold) return null;
  if (!("on" in hold)) return "unavailable";
  return { hold, ref: holdWaitingOnRef(hold) };
}

/** The open sessions of a goal's tree (not done, not lost). */
function openSessionsOf(rollup: StatusOfRollup): number {
  const c = rollup.byCategory;
  return (c.open ?? 0) + (c.active ?? 0) + (c.paused ?? 0);
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
  const wants = (part: StatusOfInclude) =>
    opts.include?.includes(part) ?? false;
  const withMoves = wants("moves");
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
  // The goals' judges by name, one read: what a goal's next move names. A
  // failed read names nobody ("its judge"), never fails the answer.
  const judgeNames = goalFacts
    ? goalFacts
        .then(async (f) => {
          const { participantDisplayNames } =
            await import("../tracks/track-participant-store.js");
          return participantDisplayNames(
            [...f.values()].flatMap((x) => (x.judgeId ? [x.judgeId] : []))
          );
        })
        .catch((err) => {
          logger.warn(
            { err },
            "statusOf: the goals' judges could not be named"
          );
          return new Map<string, string>();
        })
    : null;

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
          .map((h): [string, CurrentHold] => [
            `${h.subjectType}:${h.subjectId}`,
            h,
          ])
      )
  );
  held.catch(() => undefined);
  const holdOf = async (
    key: string,
    category: LifecycleCategory | null
  ): Promise<{ hold?: RecordedHold | Unavailable }> => {
    if (category !== "paused") return {};
    const hold = await orUnavailable(
      held.then((m) => m.get(key)?.hold ?? null)
    );
    return hold ? { hold } : {};
  };

  // Its status line: the declared option first (the rollups read it too),
  // else the stored projection, so the two can never disagree.
  const lineOf = async (t: {
    profileId: string | null;
    workspaceId: string | null;
    status: string | null;
    statusCategory: string | null;
  }) => {
    const lifecycle = t.profileId
      ? await lifecycleOf(t.profileId, t.workspaceId)
      : null;
    const option = findLifecycleOption(lifecycle, t.status);
    const category =
      option?.category ??
      (isLifecycleCategory(t.statusCategory) ? t.statusCategory : null);
    return {
      lifecycle,
      status: t.status ?? null,
      label: option
        ? lifecycleOptionLabel(option)
        : t.status
          ? resolveStatusLabel(t.status)
          : null,
      category,
      tone: option ? lifecycleOptionTone(option) : toneOf(t.status),
    };
  };
  const roleOf = async (
    r: ThingRoleRow,
    withHold: boolean
  ): Promise<StatusOfRole> => {
    const { lifecycle: _lifecycle, ...line } = await lineOf(r);
    const hold =
      withHold && line.category === "paused"
        ? await roleHeld.then((m) => m.get(`facet:${r.facetId}`)?.hold)
        : undefined;
    return {
      facetId: r.facetId,
      role: r.slug,
      roleName: r.name,
      ...line,
      ...(hold ? { hold } : {}),
    };
  };

  // The account each thing works at (`works_at`, its newest edge the reader
  // may read, to a thing it may read), then every role in ONE read.
  const thingIds = things.map((t) => t.id);
  const accounts = (async () => {
    if (thingIds.length === 0) return new Map<string, AccountRow>();
    const rows = await db
      .select({
        from: relations.sourceEntityId,
        id: entities.id,
        title: entities.title,
        status: entities.status,
        statusCategory: entities.statusCategory,
        profileId: entities.profileId,
        workspaceId: entities.workspaceId,
      })
      .from(relations)
      .innerJoin(entities, eq(entities.id, relations.targetEntityId))
      .where(
        and(
          eq(relations.type, "works_at"),
          inArray(relations.sourceEntityId, thingIds),
          access.predicate(relations),
          isNull(entities.deletedAt),
          entityReadVisibleWhere(userId)
        )
      )
      .orderBy(desc(relations.createdAt));
    const out = new Map<string, AccountRow>();
    for (const r of rows) if (r.from && !out.has(r.from)) out.set(r.from, r);
    return out;
  })();
  accounts.catch(() => undefined);
  const roles = accounts.then((a) =>
    readThingRoles(userId, [
      ...new Set([...thingIds, ...[...a.values()].map((r) => r.id)]),
    ])
  );
  roles.catch(() => undefined);
  // The current hold of each asked thing's roles (a role's hold is its facet's).
  const roleHeld = roles.then(async (m) => {
    const facets = thingIds.flatMap((id) => m.get(id) ?? []);
    const holds = facets.length
      ? await listHolds(db, {
          subjects: facets.map((f) => ({
            subjectType: "entity" as const,
            subjectId: f.entityId,
            facetId: f.facetId,
          })),
        })
      : [];
    return new Map(
      holds.map((h): [string, CurrentHold] => [`facet:${h.facetId}`, h])
    );
  });
  roleHeld.catch(() => undefined);
  const rolesOf = (id: string) =>
    orUnavailable(
      roles.then((m) =>
        Promise.all((m.get(id) ?? []).map((r) => roleOf(r, true)))
      )
    );
  const accountOf = async (
    id: string
  ): Promise<{ account?: StatusOfAccount }> => {
    try {
      const a = (await accounts).get(id);
      if (!a) return {};
      const { lifecycle: _lifecycle, ...line } = await lineOf(a);
      return {
        account: {
          id: a.id,
          name: a.title ?? null,
          ...line,
          roles: await Promise.all(
            ((await roles).get(a.id) ?? []).map((r) => roleOf(r, false))
          ),
          link: openLink(a.id),
        },
      };
    } catch (err) {
      // The account line is a pointer, never a status: unread, it is left out.
      logger.warn({ err }, "statusOf: an account line could not be read");
      return {};
    }
  };

  // ── On request ──────────────────────────────────────────────────────────
  const history = (subject: {
    kind: "entity" | "goal" | "session";
    id: string;
  }) =>
    orUnavailable(
      (async (): Promise<StatusOfHistory | Unavailable> => {
        const { readTimeline } = await import("../timeline/read-timeline.js");
        const t = await readTimeline(subject, { userId });
        if (!t) return UNAVAILABLE;
        const kept = (
          t.events as Array<StatusOfHistory["events"][number]>
        ).filter(isStatusHistoryEvent);
        return {
          events: kept.slice(0, STATUS_OF_HISTORY_MAX),
          truncated: t.truncated || kept.length > STATUS_OF_HISTORY_MAX,
        };
      })()
    );
  const historyOf = async (subject: {
    kind: "entity" | "goal" | "session";
    id: string;
  }): Promise<{ history?: StatusOfHistory | Unavailable }> =>
    wants("history") ? { history: await history(subject) } : {};

  const linkIds = [...goals.map((g) => g.id), ...sessions.map((s) => s.id)];
  const served =
    wants("links") && linkIds.length ? readServes(userId, linkIds) : null;
  served?.catch(() => undefined);
  const linksOf = async (
    id: string
  ): Promise<{ links?: StatusOfLinks | Unavailable }> =>
    served
      ? {
          links: await orUnavailable(
            served.then((m) => m.get(id) ?? { serves: [], servedBy: [] })
          ),
        }
      : {};

  const trees =
    wants("rollup") && goals.length
      ? import("./status-rollup.js").then((m) =>
          m.readGoalTreeRollups(
            userId,
            goals.map((g) => g.id)
          )
        )
      : null;
  trees?.catch(() => undefined);
  const rollupOf = async (
    id: string
  ): Promise<{ rollup?: StatusOfRollup | Unavailable }> =>
    trees
      ? {
          rollup: await orUnavailable(
            trees.then((m) => m.get(id) ?? UNAVAILABLE)
          ),
        }
      : {};

  const raised = wants("signals")
    ? roles.then((r) =>
        readRaisedSignals([
          ...thingIds.map((id) => ({ subjectType: "entity", subjectId: id })),
          ...[...r.values()]
            .flat()
            .filter((f) => thingIds.includes(f.entityId))
            .map((f) => ({ subjectType: "entity", subjectId: f.facetId })),
          ...goals.map((g) => ({ subjectType: "track", subjectId: g.id })),
          ...sessions.map((x) => ({
            subjectType: "focus_session",
            subjectId: x.id,
          })),
        ])
      )
    : null;
  raised?.catch(() => undefined);
  /**
   * The signals still open on one subject: a hold's review signal while that
   * hold stands; any other signal while the subject stands in the step it was
   * raised in (its episode key leads with the step), raised since it entered.
   */
  const signalsOf = async (
    lines: Array<{
      key: string;
      subjectType: string;
      subjectId: string;
      role: string | null;
      status: string | null;
      since: string | null;
    }>
  ): Promise<{ signals?: StatusOfSignal[] | Unavailable }> => {
    if (!raised) return {};
    const read = async (): Promise<StatusOfSignal[]> => {
      const [rows, holds, roleHolds] = await Promise.all([
        raised,
        held,
        roleHeld,
      ]);
      const out: StatusOfSignal[] = [];
      for (const l of lines) {
        const hold = holds.get(l.key) ?? roleHolds.get(l.key);
        for (const r of rows) {
          if (r.subjectType !== l.subjectType || r.subjectId !== l.subjectId)
            continue;
          if (!isStatusSignal(r.signal)) continue;
          const open =
            r.signal === "hold_review_due"
              ? !!hold && r.episodeKey.startsWith(`${hold.transitionId}:`)
              : !!l.status &&
                r.episodeKey.startsWith(`${l.status}:`) &&
                (!l.since || r.raisedAt.getTime() >= Date.parse(l.since));
          if (open) {
            out.push({
              signal: r.signal,
              role: l.role,
              raisedAt: r.raisedAt.toISOString(),
            });
          }
        }
      }
      return out.sort((a, b) => b.raisedAt.localeCompare(a.raisedAt));
    };
    return { signals: await orUnavailable(read()) };
  };

  // Its wait episodes: everything asked about in ONE read through THE reader
  // (`readWaitEpisodes`), each subject already floored on the reader above.
  const waited = wants("episodes")
    ? readWaitEpisodes(db, [
        ...things.map((t) => ({
          subjectType: "entity" as const,
          subjectId: t.id,
        })),
        ...goals.map((g) => ({
          subjectType: "track" as const,
          subjectId: g.id,
        })),
        ...sessions.map((x) => ({
          subjectType: "focus_session" as const,
          subjectId: x.id,
        })),
      ])
    : null;
  waited?.catch(() => undefined);
  /**
   * One subject's episodes, newest first (the reader gives them oldest
   * first). A role's episode is kept only when the reader may see that role
   * (THE facet visibility rule, `roles`); unread roles make it unavailable.
   */
  const episodesOf = async (
    subjectType: "entity" | "track" | "focus_session",
    subjectId: string
  ): Promise<{ episodes?: WaitEpisode[] | Unavailable }> => {
    if (!waited) return {};
    const read = async (): Promise<WaitEpisode[]> => {
      const own = (await waited).filter(
        (e) => e.subjectType === subjectType && e.subjectId === subjectId
      );
      const seen = own.some((e) => e.facetId != null)
        ? new Set(((await roles).get(subjectId) ?? []).map((r) => r.facetId))
        : null;
      return own
        .filter((e) => e.facetId == null || seen?.has(e.facetId))
        .reverse();
    };
    return { episodes: await orUnavailable(read()) };
  };

  for (const t of things) {
    answers.set(
      t.id,
      (async (): Promise<StatusOf> => {
        const { lifecycle, ...line } = await lineOf(t);
        const { category } = line;
        const since = sinceOf(`entity:${t.id}`, t.createdAt);
        const afterDays =
          lifecycle && t.status
            ? stuckAfterDaysOf(lifecycle.options).get(t.status)
            : undefined;
        const forDays =
          since.since && afterDays !== undefined
            ? stuckForDays(since.since, afterDays)
            : null;
        const thingRoles = await rolesOf(t.id);
        const stuck =
          forDays !== null && afterDays !== undefined
            ? { afterDays, forDays }
            : undefined;
        const waitingOn = await waitingOf(t.id);
        const held = await holdOf(`entity:${t.id}`, category);
        return {
          id: t.id,
          type: "entity",
          name: t.title ?? null,
          ...line,
          ...since,
          ...(stuck ? { stuck } : {}),
          waitingOn,
          ...held,
          ...(lifecycle
            ? {
                nextMove: deriveThingNextMove({
                  lifecycle,
                  status: t.status ?? null,
                  category,
                  label: line.label,
                  stuck,
                  waitingOn: "status" in waitingOn ? "unavailable" : waitingOn,
                  hold: holdFact(held.hold),
                }),
              }
            : {}),
          ...(withMoves && lifecycle
            ? { moves: movesFrom(lifecycle, t.status ?? null) }
            : {}),
          roles: thingRoles,
          ...(await accountOf(t.id)),
          ...(await historyOf({ kind: "entity", id: t.id })),
          ...(await signalsOf([
            {
              key: `entity:${t.id}`,
              subjectType: "entity",
              subjectId: t.id,
              role: null,
              status: t.status ?? null,
              since: since.since,
            },
            ...("status" in thingRoles
              ? []
              : thingRoles.map((r) => ({
                  key: `facet:${r.facetId}`,
                  subjectType: "entity",
                  subjectId: r.facetId,
                  role: r.role,
                  status: r.status,
                  since: null,
                }))),
          ])),
          ...(await episodesOf("entity", t.id)),
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
        const since = sinceOf(`track:${g.id}`, g.createdAt);
        const facts = await orUnavailable(
          goalFacts!.then((f) => f.get(g.id) ?? UNAVAILABLE)
        );
        const held = await holdOf(`track:${g.id}`, category);
        const tree = await rollupOf(g.id);
        const label = resolveTrackStatusLabel(g.status);
        return {
          id: g.id,
          type: "goal",
          name: g.name,
          status: g.status,
          label,
          category,
          tone: toneOf(g.status),
          ...since,
          waitingOn: "status" in facts ? UNAVAILABLE : facts.waitingOn,
          ...held,
          nextMove: deriveGoalNextMove({
            category,
            label,
            hold: holdFact(held.hold),
            facts:
              "status" in facts
                ? "unavailable"
                : {
                    ...facts,
                    judge: facts.judgeId
                      ? {
                          id: facts.judgeId,
                          name: (await judgeNames!).get(facts.judgeId) ?? null,
                        }
                      : null,
                  },
            // The tree's open sessions, when the rollup was asked for (it
            // counts those serving it and its sub-goals too).
            ...(tree.rollup && !("status" in tree.rollup)
              ? { treeOpenSessions: openSessionsOf(tree.rollup) }
              : {}),
            readerId: userId,
          }),
          ...(await historyOf({ kind: "goal", id: g.id })),
          ...(await linksOf(g.id)),
          ...tree,
          ...(await signalsOf([
            {
              key: `track:${g.id}`,
              subjectType: "track",
              subjectId: g.id,
              role: null,
              status: g.status,
              since: since.since,
            },
          ])),
          ...(await episodesOf("track", g.id)),
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
        const since = sinceOf(
          `focus_session:${s.id}`,
          done ? s.closedAt : s.startedAt
        );
        return {
          id: s.id,
          type: "session",
          name: resolveSessionTitle(s) || null,
          status: s.status,
          label: resolveStatusLabel(s.status),
          category,
          tone: toneOf(s.status),
          ...since,
          waitingOn: await waitingOf(`session:${s.id}`),
          ...(await holdOf(`focus_session:${s.id}`, category)),
          live: facts.live.get(s.id) ?? UNAVAILABLE,
          ...(facts.nextMove.has(s.id)
            ? { nextMove: facts.nextMove.get(s.id)! }
            : {}),
          ...(await historyOf({ kind: "session", id: s.id })),
          ...(await linksOf(s.id)),
          ...(await signalsOf([
            {
              key: `focus_session:${s.id}`,
              subjectType: "focus_session",
              subjectId: s.id,
              role: null,
              status: s.status,
              since: since.since,
            },
          ])),
          ...(await episodesOf("focus_session", s.id)),
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

type AccountRow = {
  id: string;
  title: string | null;
  status: string | null;
  statusCategory: string | null;
  profileId: string | null;
  workspaceId: string | null;
};

/**
 * The `serves` edges of the asked goals and sessions, both ways, each end
 * the reader may see (a session through THE session read rule, a goal
 * through the goal visibility rule); an end it may not see is left out,
 * never named. THROWS.
 */
async function readServes(
  userId: string,
  ids: readonly string[]
): Promise<Map<string, StatusOfLinks>> {
  // The literal (not the `SERVES_LINK_TYPE` constant) keeps this reader
  // visible to the `links-type-ssot` tripwire's typed-reader scan.
  const edges = await db
    .select({
      fromType: links.fromType,
      fromId: links.fromId,
      toType: links.toType,
      toId: links.toId,
      metadata: links.metadata,
    })
    .from(links)
    .where(
      and(
        eq(links.linkType, "serves"),
        or(
          and(
            inArray(links.fromType, ["session", "track"]),
            inArray(links.fromId, [...ids])
          ),
          and(eq(links.toType, "track"), inArray(links.toId, [...ids]))
        )
      )
    );
  const endIds = (type: string) => [
    ...new Set(
      edges.flatMap((e) => [
        ...(e.fromType === type ? [e.fromId] : []),
        ...(e.toType === type ? [e.toId] : []),
      ])
    ),
  ];
  const sessionIds = endIds("session");
  const trackIds = endIds("track");
  const [sessionRows, goalRows] = await Promise.all([
    sessionIds.length
      ? db
          .select({
            id: focusSessions.id,
            title: focusSessions.title,
            goal: focusSessions.goal,
            status: focusSessions.status,
          })
          .from(focusSessions)
          .where(
            and(
              inArray(focusSessions.id, sessionIds),
              sessionReadableWhere({ userId })
            )
          )
      : Promise.resolve([]),
    trackIds.length
      ? scopedDb(AccessContext.from({ userId })).findMany<ProjectTrack>(
          projectTracks,
          { where: inArray(projectTracks.id, trackIds) }
        )
      : Promise.resolve([] as ProjectTrack[]),
  ]);
  const ends = new Map<string, Omit<StatusOfLinkEnd, "criterionKey">>();
  for (const r of sessionRows) {
    ends.set(`session:${r.id}`, {
      type: "session",
      id: r.id,
      name: resolveSessionTitle(r) || null,
      status: r.status,
      category: sessionStatusCategory(r.status),
      tone: toneOf(r.status),
    });
  }
  for (const g of goalRows) {
    ends.set(`track:${g.id}`, {
      type: "goal",
      id: g.id,
      name: g.name,
      status: g.status,
      category: trackStatusCategory(g.status),
      tone: toneOf(g.status),
    });
  }
  const out = new Map<string, StatusOfLinks>(
    ids.map((id) => [id, { serves: [], servedBy: [] }])
  );
  for (const e of edges) {
    const key = (e.metadata as { criterionKey?: unknown } | null)?.criterionKey;
    const criterion =
      typeof key === "string" && key ? { criterionKey: key } : {};
    const to = ends.get(`${e.toType}:${e.toId}`);
    const from = ends.get(`${e.fromType}:${e.fromId}`);
    if (to) out.get(e.fromId)?.serves.push({ ...to, ...criterion });
    if (from) out.get(e.toId)?.servedBy.push({ ...from, ...criterion });
  }
  return out;
}

/** The claimed signal episodes of these subjects (`status_signal_raised`). */
async function readRaisedSignals(
  subjects: ReadonlyArray<{ subjectType: string; subjectId: string }>
) {
  if (subjects.length === 0) return [];
  return db
    .select({
      subjectType: statusSignalRaised.subjectType,
      subjectId: statusSignalRaised.subjectId,
      signal: statusSignalRaised.signal,
      episodeKey: statusSignalRaised.episodeKey,
      raisedAt: statusSignalRaised.raisedAt,
    })
    .from(statusSignalRaised)
    .where(
      or(
        ...subjects.map((x) =>
          and(
            eq(statusSignalRaised.subjectType, x.subjectType),
            eq(statusSignalRaised.subjectId, x.subjectId)
          )
        )
      )
    );
}
