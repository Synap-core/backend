/**
 * Signals Router — ONE door for every attention lens.
 *
 * Mounted as `trpc.signals.*` (NOT to be confused with the pre-existing
 * `trpc.signal.*` router, which is the inbound bridge/webhook door — a
 * different object entirely).
 *
 * WHY THIS EXISTS. "What needs me?" used to be answered by independent reads
 * that counted different things: the decisions tray read pending proposals and
 * the bell read unread notifications, so approving one proposal produced a row
 * in BOTH and the two badges disagreed by construction. This router is the
 * single door every attention surface reads, so there is exactly ONE definition
 * of each attention class and exactly ONE number behind each badge.
 *
 * ── THE LENS PAGE (lens grammar, founder-approved 2026-10-04) ───────────────
 * A lens page is `lens(scope)`, scope ∈ pod | workspace | project | track |
 * session, and every row on it is one of five classes:
 *
 *   Blocking  (`needs-you`) — owed slots, pending decisions (a proposal an
 *             agent is paused on included), sessions awaiting your review,
 *             asking notifications.
 *   Proposed  (`proposed`)  — AI suggestions + agent drafts. Never needs-you.
 *   Happening (`happening`) — sessions an agent is working on right now, and
 *             rules running without a session (one row per rule).
 *   Produced  (`produced`)  — objects work produced (`outputs.landed`).
 *   Happened  (`history`)   — the `activity.list` ledger + data events.
 *
 * System health is none of them: it is ONE deduplicated status banner.
 * `list({ lens: "page" })` returns all five classes + the banner in ONE read;
 * each single lens returns one class through the SAME reader, so a section and
 * its own "Show all" page can never disagree.
 *
 * ── ONE DERIVATION AT EVERY SCOPE ───────────────────────────────────────────
 * Every half narrows by NESTED predicates — workspace, then project, then
 * track, then session — so pod ⊇ project ⊇ track ⊇ session holds by
 * construction (a session in a track carries the track's project). Proposals,
 * owed slots, review sessions, outputs and the ledger narrow in SQL; a
 * notification narrows through the container its subject resolves to
 * (`lens-containers.ts`) — derived, never a stored column — prefiltered in SQL
 * by the door (`notifCenter.list({ container })`) so a narrow scope's limit
 * is spent on its own rows.
 *
 * IT ADDS NO ACCESS LOGIC. It calls the existing doors (`proposals.groups`,
 * `notifCenter.list`, `events.read`) via `createCaller` — the established
 * in-process reuse pattern (`workspaces.ts`, `capture.ts`, `signal.ts`) — and
 * the existing services behind the other doors (`listOwedSlots`,
 * `listActivity`, `listLandedOutputs`, `loadSessionLiveness`), each with its
 * own floor (`userVisibleWhere` / `proposalUserFloor`, the owner floor, the
 * session read floor, `scopedDb`). A signal can never expose a row the caller
 * could not already read.
 *
 * ── FAILED IS NOT EMPTY ─────────────────────────────────────────────────────
 * A single lens THROWS when any half it reads fails (TanStack's `isError`). The
 * page names every failed half per class in `unreadable` and keeps the halves
 * that worked — a class with an unreadable half is a FLOOR, never "empty".
 *
 * The union/dedupe itself is pure and lives in
 * `../services/signals/needs-you-union.ts`, with its own unit tests.
 */

import { z } from "zod";
import { router, protectedProcedure } from "../trpc.js";
import {
  db,
  and,
  desc,
  eq,
  inArray,
  or,
  ne,
  gte,
  drizzleSql,
  focusSessions,
  projects,
  automations,
  automationRuns,
} from "@synap/database";
import { foldRuleRuns } from "../services/signals/rule-runs.js";
import { createLogger } from "@synap-core/core";
import {
  humanizeToken,
  normalizeObjectKind,
} from "@synap-core/types/vocabulary";
import { resolveSessionTitle } from "@synap-core/types/focus-sessions";
import type { ActivityRow } from "@synap-core/types/activity";
import type { LandedObjectRow } from "@synap-core/types/landed";
import {
  isSessionWorkingNow,
  SESSION_WORKING_WINDOW_MS,
} from "@synap-core/types/run-activity";
import { LENS_CAPS, type LensPagePicks } from "@synap-core/types/lens";
import { needsYouRows } from "@synap-core/types/needs-you";
import { parseRecordChange } from "@synap-core/types/events";
import { requireUserId } from "../utils/user-scoped.js";
import { proposalsRouter } from "./proposals.js";
import { notifCenterRouter } from "./notif-center.js";
import { eventsRouter } from "./events.js";
import {
  unionNeedsYou,
  unionSuggestions,
  unionProposed,
  countNeedsYou,
  statusBanner,
  withProjectSource,
  sessionGroupKey,
  sessionSource,
  ageBucketOf,
  type NotificationContainer,
  type NotificationSignalInput,
  type OwedSlotSignalInput,
  type Signal,
  type StatusBanner,
} from "../services/signals/needs-you-union.js";
import { listSessionsAwaitingReview } from "../services/projects/project-needs-you.js";
import { sessionsWithOpenQuestion } from "../services/signals/open-question-sessions.js";
import {
  inContainerLens,
  resolveNotificationContainers,
  sessionsWithOwedSlot,
  type ContainerLens,
} from "../services/signals/lens-containers.js";
import { needsYouRole } from "../notifications/registry.js";
import { listDraftAskSlots } from "../services/focus-sessions/draft-asks.js";
import { listOwedSlots } from "../services/focus-sessions/owed-outputs.js";
import { resolveScope } from "../utils/scope-filter.js";
import { readClusterSessions } from "../services/signals/cluster-sessions.js";
import { rosterReadFor } from "../access/session-visibility.js";
import { AccessContext, scopedDb } from "../access/index.js";
import { listActivity } from "../services/activity/list-activity.js";
import {
  LANDED_OUTPUTS_MAX_LIMIT,
  listLandedOutputs,
} from "../services/outputs/landed-outputs.js";
import { loadSessionLiveness } from "../services/runs/session-liveness.js";
import { sessionListConditions } from "../services/focus-sessions/session-list-conditions.js";
import { sessionKindWhere } from "../services/focus-sessions/session-kind.js";
import { OPEN_SESSION_STATUSES } from "../services/focus-sessions/session-statuses.js";
import {
  readNextMovePicks,
  writeNextMoveSkip,
} from "../services/signals/next-moves.js";

const logger = createLogger({ module: "signals" });

/** How many unread notifications are pulled before dedupe. A page, not a total —
 *  `truncated` reports when the cap was hit rather than hiding it. */
const NOTIFICATION_SCAN_LIMIT = 100;

/** How many owed slots one read pulls before its number is a floor. */
const OWED_SCAN_LIMIT = 100;

/** Most clusters any read pulls (the `proposals.groups` maximum). */
const CLUSTER_PAGE_LIMIT = 100;

/** Open sessions the Happening read measures, most recently moved first. */
const HAPPENING_SCAN_LIMIT = 50;

/**
 * The workspace lens, translated for EVERY half of the union that resolves its
 * scope through `resolveScope` — today `notifCenter.list` and the owed reads.
 *
 * `proposals.groups` treats an ABSENT `workspaceId` as the full user floor,
 * while `resolveScope` falls back to the active-workspace HEADER when the field
 * is absent. Left alone, the halves of one union speak different lenses: one
 * narrows to whatever workspace the client last activated while the others stay
 * pod-wide, and the tray claims "nothing needs you" with work waiting one lens
 * over. An explicit empty array is `resolveScope`'s "widen to the floor" value
 * and suppresses the header default, so absent → `[]` makes every half agree.
 *
 * This has shipped broken twice. Any new half of this union whose door calls
 * `resolveScope` MUST come through here — it is not optional, and it is not
 * per-door.
 */
export function floorLens(
  workspaceId: string | null | undefined
): string | null | string[] {
  return workspaceId === undefined ? [] : workspaceId;
}

const SignalScope = {
  /** Same three-state as `proposals.groups`/`list`: string = that workspace,
   *  null = pod-wide only, undefined = the full user floor. */
  workspaceId: z.string().nullish(),
  /**
   * NARROWING lenses — "what needs me / what happened INSIDE this container".
   * They compose with `workspaceId` and with each other; each only ANDs.
   * `projectId` ⊇ `trackId` ⊇ `sessionId` (a track's sessions carry the
   * track's project).
   */
  sessionId: z.string().uuid().optional(),
  projectId: z.string().uuid().optional(),
  trackId: z.string().uuid().optional(),
  /**
   * An automation's runs. Only the proposal half can follow it (through
   * `automation_step_runs`); every other half is suppressed under it rather
   * than returned unnarrowed.
   */
  automationId: z.string().uuid().optional(),
};

type SignalScopeInput = z.infer<z.ZodObject<typeof SignalScope>>;

/** The object form of the caller context (never the lazy factory). */
type SignalsCtx = Extract<
  Parameters<typeof proposalsRouter.createCaller>[0],
  { userId?: unknown }
>;

/** The container lens (session ⊂ track ⊂ project), or undefined at the floor. */
function containerLensOf(input: SignalScopeInput): ContainerLens | undefined {
  if (!input.sessionId && !input.trackId && !input.projectId) return undefined;
  return {
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.trackId ? { trackId: input.trackId } : {}),
    ...(input.projectId ? { projectId: input.projectId } : {}),
  };
}

/** A half that can only follow an automation through the proposal ledger. */
function followsScope(input: SignalScopeInput): boolean {
  return !input.automationId;
}

// ── Settled sub-reads ───────────────────────────────────────────────────────

/** A sub-read's name — what `unreadable` reports. */
export type SignalSubRead =
  | "proposals"
  | "notifications"
  | "owed"
  | "drafts"
  | "review"
  | "liveness"
  | "outputs"
  | "activity"
  | "events";

interface Settled<T> {
  value: T;
  failed: { source: SignalSubRead; error: unknown } | null;
}

/** Run one sub-read; a throw becomes `failed` + the empty value, NAMED. */
async function settle<T>(
  source: SignalSubRead,
  empty: T,
  read: () => Promise<T>
): Promise<Settled<T>> {
  try {
    return { value: await read(), failed: null };
  } catch (error) {
    logger.warn({ err: error, source }, "signals sub-read failed");
    return { value: empty, failed: { source, error } };
  }
}

function failuresOf(
  ...settled: Array<Settled<unknown>>
): Array<{ source: SignalSubRead; error: unknown }> {
  return settled.flatMap((s) => (s.failed ? [s.failed] : []));
}

/** A single lens throws the first failure — a failed read is never empty. */
function throwIfFailed(
  failures: ReadonlyArray<{ source: SignalSubRead; error: unknown }>
): void {
  if (failures[0]) throw failures[0].error;
}

// ── Blocking + Proposed + status: one read ──────────────────────────────────

/**
 * Everything the needs-you union, the Proposed lane, the status banner and
 * `count` read — ONE function, so the list, the badge and the page answer over
 * the same population by construction.
 */
async function readAttention(
  ctx: SignalsCtx,
  input: SignalScopeInput,
  clusterLimit: number
) {
  const userId = requireUserId(ctx.userId);
  const reader = { userId, roster: rosterReadFor(ctx) };
  const follows = followsScope(input);
  const container = containerLensOf(input);
  const owedScope = {
    userId,
    scope: resolveScope(ctx, {
      workspaceId: floorLens(input.workspaceId),
      ...(input.projectId ? { projectId: input.projectId } : {}),
    }),
    limit: OWED_SCAN_LIMIT,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.trackId ? { trackId: input.trackId } : {}),
  };

  const [groups, notifs, health, owed, drafts, review] = await Promise.all([
    settle(
      "proposals",
      { groups: [], distinct: 0, scanTruncated: false, scanned: 0 },
      () =>
        proposalsRouter.createCaller(ctx).groups({
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          projectId: input.projectId,
          trackId: input.trackId,
          automationId: input.automationId,
          status: "pending",
          limit: clusterLimit,
          excludeDraftSessions: true,
          splitBySession: true,
        })
    ),
    // Under a container lens the door narrows IN SQL, before its limit
    // (`container`); the resolved containers below stay the authority.
    follows
      ? settle(
          "notifications",
          [] as NotificationSignalInput[],
          async () =>
            (
              await notifCenterRouter.createCaller(ctx).list({
                workspaceId: floorLens(input.workspaceId),
                status: "unread",
                limit: NOTIFICATION_SCAN_LIMIT,
                ...(container ? { container } : {}),
              })
            ).notifications as NotificationSignalInput[]
        )
      : settle(
          "notifications",
          [] as NotificationSignalInput[],
          async () => []
        ),
    // System HEALTH is the pod's, never a container's: under a container lens
    // the banner reads its own rows (every status-role type is `system`,
    // pinned in the tests); at the floor it reads the floor read above.
    container
      ? settle(
          "notifications",
          [] as NotificationSignalInput[],
          async () =>
            (
              await notifCenterRouter.createCaller(ctx).list({
                workspaceId: floorLens(input.workspaceId),
                status: "unread",
                category: "system",
                limit: NOTIFICATION_SCAN_LIMIT,
              })
            ).notifications as NotificationSignalInput[]
        )
      : null,
    // The owed read under the SAME lens and owner floor `focusSessions.owed`
    // applies (`listOwedSlots`), plus the session/track lenses that door does
    // not expose. Drafts never count (`excludeDrafts`).
    follows
      ? settle(
          "owed",
          [] as OwedSlotSignalInput[],
          async () =>
            (await listOwedSlots({
              ...owedScope,
              excludeDrafts: true,
            })) as OwedSlotSignalInput[]
        )
      : settle("owed", [] as OwedSlotSignalInput[], async () => []),
    // The DRAFT half — owed slots on undecided agent drafts, folded into one
    // `draft-asks` row per draft. PROPOSED, never needs-you.
    settle(
      "drafts",
      {
        slots: [] as OwedSlotSignalInput[],
        starterNames: new Map<string, string>(),
      },
      async () =>
        follows
          ? await listDraftAskSlots(owedScope)
          : { slots: [], starterNames: new Map<string, string>() }
    ),
    // The REVIEW half — at every scope, the pod included.
    settle("review", { sessions: [], truncated: false }, async () =>
      follows
        ? await listSessionsAwaitingReview({
            userId,
            workspaceId: input.workspaceId,
            projectId: input.projectId,
            trackId: input.trackId,
            sessionId: input.sessionId,
          })
        : { sessions: [], truncated: false }
    ),
  ]);

  const allNotifications = notifs.value;
  // Containers, cluster session names — through the session READ floor.
  const [containers, clusterSessions] = await Promise.all([
    settle("notifications", new Map<string, NotificationContainer>(), () =>
      resolveNotificationContainers(allNotifications, reader)
    ),
    settle("proposals", new Map(), () =>
      readClusterSessions(groups.value.groups, reader)
    ),
  ]);
  const notifications = allNotifications.filter((r) =>
    inContainerLens(containers.value.get(r.id), container ?? {})
  );

  // The live state of the `session.needs_you` pointer rows.
  const pointerIds = notifications.flatMap((r) =>
    needsYouRole(r.type) === "session-pointer" && r.sourceId ? [r.sourceId] : []
  );
  const [openQuestions, owedPointers] = await Promise.all([
    settle("notifications", new Set<string>(), () =>
      sessionsWithOpenQuestion(pointerIds)
    ),
    settle("notifications", new Set<string>(), () =>
      sessionsWithOwedSlot(userId, pointerIds)
    ),
  ]);

  const draftAsks = drafts.value as {
    slots: OwedSlotSignalInput[];
    starterNames: Map<string, string>;
  };
  return {
    groups: groups.value,
    clusterSessions: clusterSessions.value,
    allNotifications,
    statusNotifications: health ? health.value : allNotifications,
    notifications,
    containers: containers.value,
    notificationsTruncated: allNotifications.length >= NOTIFICATION_SCAN_LIMIT,
    owed: owed.value,
    owedTruncated: owed.value.length >= OWED_SCAN_LIMIT,
    draftAsks,
    draftAsksTruncated: draftAsks.slots.length >= OWED_SCAN_LIMIT,
    review: review.value,
    // An unmeasured open-question read stays `undefined` (= unmeasured).
    openQuestionSessionIds: openQuestions.failed
      ? undefined
      : openQuestions.value,
    measuredOwedSessionIds: owedPointers.value,
    failures: {
      // What each class read. Blocking: every half but drafts.
      blocking: failuresOf(
        groups,
        notifs,
        owed,
        review,
        containers,
        clusterSessions,
        openQuestions,
        owedPointers
      ),
      proposed: failuresOf(drafts, notifs, containers),
      status: failuresOf(health ?? notifs),
    },
  };
}

type Attention = Awaited<ReturnType<typeof readAttention>>;

function blockingSignals(a: Attention): Signal[] {
  return unionNeedsYou({
    clusters: a.groups.groups,
    clusterSessions: a.clusterSessions,
    notifications: a.notifications,
    notificationContainers: a.containers,
    owedSlots: a.owed,
    openQuestionSessionIds: a.openQuestionSessionIds,
    measuredOwedSessionIds: a.measuredOwedSessionIds,
    draftAsks: a.draftAsks,
    reviewSessions: a.review.sessions,
  });
}

function proposedSignals(a: Attention): Signal[] {
  return unionProposed({
    draftAsks: a.draftAsks,
    notifications: a.notifications,
    notificationContainers: a.containers,
  });
}

function countOf(a: Attention) {
  return countNeedsYou({
    distinctClusters: a.groups.distinct,
    clustersTruncated: a.groups.scanTruncated,
    clusters: a.groups.groups,
    notifications: a.notifications,
    openQuestionSessionIds: a.openQuestionSessionIds,
    measuredOwedSessionIds: a.measuredOwedSessionIds,
    notificationsTruncated: a.notificationsTruncated,
    owedSlots: a.owed,
    owedTruncated: a.owedTruncated,
    // Counted as ROWS — the very rows `list` emits as `session-review`.
    reviewSessions: a.review.sessions.length,
    reviewTruncated: a.review.truncated,
    draftAsks: a.draftAsks,
    draftAsksTruncated: a.draftAsksTruncated,
  });
}

/**
 * Project names for the provenance door of rows whose OBJECT is a session —
 * through the project visibility predicate, so a project the viewer cannot
 * see is never named (its row simply carries no source).
 */
async function readProjectNames(
  ctx: SignalsCtx,
  ids: ReadonlyArray<string | null | undefined>
): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => !!id))];
  if (unique.length === 0) return new Map();
  const rows = await db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(
      and(
        inArray(projects.id, unique),
        scopedDb(AccessContext.from(ctx)).predicate(projects)
      )
    );
  return new Map(rows.map((r) => [r.id, r.name]));
}

// ── Happening ───────────────────────────────────────────────────────────────

/**
 * Sessions an agent is working on RIGHT NOW — the one rule
 * (`isSessionWorkingNow`, founder decision D1: an IS turn in flight, or any
 * session activity in the last five minutes) over the one batched liveness
 * read (`loadSessionLiveness`, the same facts `focusSessions.list` rows and
 * the session page carry). Candidates are the scope's OPEN sessions an agent
 * can be AT: work AND every run (a playbook run an agent drives — the dev
 * session a coding agent writes into — is untracked `kind: 'run'`, and the
 * work + tracked-runs population hid exactly that live work, dogfood
 * 2026-10-05). Receipts stay out: an agent-write container is not a unit of
 * work, its writes land in Happened. Drafts excluded, session read floor,
 * most recently moved first, capped — past the cap the class is a floor
 * (`truncated`).
 *
 * SESSION-KIND-LENS-EXEMPT: returns `live-session` SIGNAL rows (id, title, goal, project + liveness), never a session row; the population is sessionListConditions (kind + triage lens applied in SQL).
 */
async function readHappening(ctx: SignalsCtx, input: SignalScopeInput) {
  if (!followsScope(input)) return { signals: [], truncated: false };
  const userId = requireUserId(ctx.userId);
  const reader = { userId, roster: rosterReadFor(ctx) };
  const conditions = sessionListConditions({
    userId,
    scope: { workspaceLens: input.workspaceId, projectLens: input.projectId },
    status: "all",
    lens: "default",
    kind: "all",
    roster: reader.roster,
    ...(input.trackId ? { trackId: input.trackId } : {}),
  });
  conditions.push(or(sessionKindWhere("work"), sessionKindWhere("run"))!);
  if (input.sessionId) conditions.push(eq(focusSessions.id, input.sessionId));
  const rows = await db
    .select({
      id: focusSessions.id,
      title: focusSessions.title,
      goal: focusSessions.goal,
      channelId: focusSessions.channelId,
      expectedOutputs: focusSessions.expectedOutputs,
      startedAt: focusSessions.startedAt,
      updatedAt: focusSessions.updatedAt,
      projectId: focusSessions.projectId,
    })
    .from(focusSessions)
    .where(
      and(
        ...conditions,
        inArray(focusSessions.status, [...OPEN_SESSION_STATUSES])
      )
    )
    .orderBy(desc(focusSessions.updatedAt), desc(focusSessions.id))
    .limit(HAPPENING_SCAN_LIMIT + 1);
  const truncated = rows.length > HAPPENING_SCAN_LIMIT;
  const candidates = rows.slice(0, HAPPENING_SCAN_LIMIT);
  const now = new Date();
  // Happening only asks "working NOW": measure activity inside the window
  // (index-backed range scans), never each session's whole history.
  const live = await loadSessionLiveness(reader, candidates, {
    since: new Date(now.getTime() - SESSION_WORKING_WINDOW_MS),
  });
  if (candidates.some((c) => live.get(c.id) === null)) {
    // `null` = the liveness read FAILED — never a quiet session.
    throw new Error("session liveness read failed");
  }
  const working = candidates.filter((c) =>
    isSessionWorkingNow(live.get(c.id), now.getTime())
  );
  const names = await readProjectNames(
    ctx,
    working.map((c) => c.projectId)
  );
  const signals: Signal[] = working.map((c) => {
    const facts = live.get(c.id)!;
    const at = facts.lastAt ?? facts.since ?? c.updatedAt;
    const occurredAt = at instanceof Date ? at : new Date(at);
    const title = resolveSessionTitle(c);
    return withProjectSource(
      {
        id: `live:${c.id}`,
        kind: "live-session",
        title,
        count: 1,
        occurredAt,
        target: { kind: "session", id: c.id },
        category: "ai",
        ...(c.goal ? { sessionGoal: c.goal } : {}),
        ...(title ? { sessionTitle: title } : {}),
        ...(c.projectId ? { sessionProjectId: c.projectId } : {}),
        live: facts,
        groupKey: sessionGroupKey(c.id),
        ageBucket: ageBucketOf(occurredAt, now),
        repeatCount: 1,
      },
      names
    );
  });
  // Rules whose runs opened no session — the second Happening population.
  const rules = await readRuleRuns(ctx, input, now);
  signals.push(...rules.signals);
  signals.sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());
  return { signals, truncated: truncated || rules.truncated };
}

/** Rule runs the Happening read scans inside the window, newest first. */
const RULE_RUN_SCAN_LIMIT = 500;

/**
 * RULE RUNS working now — runs started inside the SAME working window as
 * sessions (`SESSION_WORKING_WINDOW_MS`), or still in flight, of rules whose
 * run opened NO session (a run that did is already its live-session row).
 * Skipped runs (dedup, daily cap, precondition) did no work and are out.
 * Folded one row per rule (`foldRuleRuns`) so a 300-run sync burst is ONE
 * row. Read floor: the `automationRuns` VisibilityRule under the page's
 * workspace lens. Pod/workspace scopes only — a run carries no project,
 * track or session column, so under those it is not guessed into the
 * container (the same rule the Happened data events follow).
 */
async function readRuleRuns(
  ctx: SignalsCtx,
  input: SignalScopeInput,
  now: Date
): Promise<{ signals: Signal[]; truncated: boolean }> {
  if (input.projectId || input.trackId || input.sessionId) {
    return { signals: [], truncated: false };
  }
  const since = new Date(now.getTime() - SESSION_WORKING_WINDOW_MS);
  const rows = await db
    .select({
      automationId: automationRuns.automationId,
      automationName: automations.name,
      status: automationRuns.status,
      startedAt: automationRuns.startedAt,
    })
    .from(automationRuns)
    .innerJoin(automations, eq(automations.id, automationRuns.automationId))
    .where(
      and(
        scopedDb(AccessContext.from(ctx).withLens(input.workspaceId)).predicate(
          automationRuns
        ),
        or(
          gte(automationRuns.startedAt, since),
          eq(automationRuns.status, "running")
        ),
        ne(automationRuns.status, "skipped"),
        drizzleSql`NOT EXISTS (
          SELECT 1 FROM focus_sessions fs
          WHERE fs.metadata->>'automationRunId' = ${automationRuns.id}::text
        )`
      )
    )
    .orderBy(desc(automationRuns.startedAt))
    .limit(RULE_RUN_SCAN_LIMIT + 1);
  return {
    signals: foldRuleRuns(rows.slice(0, RULE_RUN_SCAN_LIMIT), now),
    truncated: rows.length > RULE_RUN_SCAN_LIMIT,
  };
}

// ── Produced ────────────────────────────────────────────────────────────────

function signalFromLanded(row: LandedObjectRow, now: Date): Signal {
  const occurredAt = new Date(row.createdAt);
  return {
    id: `output:${row.id}`,
    kind: "output",
    title: row.title,
    count: 1,
    occurredAt,
    target: { kind: row.ref.kind, id: row.ref.id },
    category: "data",
    sessionTitle: row.session.title,
    ...sessionSource(row.session.id, row.session.title),
    landed: row,
    groupKey: null,
    ageBucket: ageBucketOf(occurredAt, now),
    repeatCount: 1,
  };
}

/**
 * What the scope's work PRODUCED — `outputs.landed` (`listLandedOutputs`, the
 * same scan, provenance and floors as Data › Landed), narrowed by the lens.
 * Pending creations are not produced (they are Blocking decisions). One page
 * at the door's maximum: past it, or past the door's session scan, the class
 * is a floor.
 */
async function readProduced(ctx: SignalsCtx, input: SignalScopeInput) {
  if (!followsScope(input)) return { signals: [], truncated: false };
  const page = await listLandedOutputs({
    access: AccessContext.from(ctx),
    workspaceLens: input.workspaceId,
    projectId: input.projectId,
    trackId: input.trackId,
    sessionId: input.sessionId,
    limit: LANDED_OUTPUTS_MAX_LIMIT,
  });
  // `null` = the project is not visible to the caller: not an empty answer.
  if (!page) throw new Error("project not found");
  const now = new Date();
  return {
    signals: page.items.map((r) => signalFromLanded(r, now)),
    truncated: page.truncated || page.nextCursor !== null,
  };
}

// ── Happened ────────────────────────────────────────────────────────────────

function signalFromActivity(row: ActivityRow, now: Date): Signal {
  const occurredAt = new Date(row.occurredAt);
  const source = row.session
    ? sessionSource(row.session.id, row.session.title)
    : row.project?.name
      ? {
          source: {
            kind: "project" as const,
            id: row.project.id,
            label: row.project.name,
          },
        }
      : {};
  return {
    id: `activity:${row.id}`,
    kind: "activity",
    title: row.title,
    count: 1,
    occurredAt,
    target: { kind: row.object.kind, id: row.object.id },
    category:
      row.source === "proposal" || row.source === "decision"
        ? "governance"
        : "ai",
    ...source,
    activity: row,
    groupKey: null,
    ageBucket: ageBucketOf(occurredAt, now),
    repeatCount: 1,
  };
}

/**
 * The event as a DATA line (`Signal.event`), when it is a record change
 * (`parseRecordChange` — the ONE rule; the governance phases of the same
 * change and connector families are not). The record's kind is its profile
 * slug when the event payload named one, else the normalised subject. The
 * writer is named only when it is not the column default (`api`, a direct
 * write) — "Sync created 101 contacts", never "Api created…".
 */
export function dataEventOf(e: {
  type: string;
  subjectType: string | null;
  source?: string | null;
  data?: unknown;
}): { event: NonNullable<Signal["event"]> } | Record<string, never> {
  const change = parseRecordChange(e.type);
  if (!change) return {};
  const data = (e.data ?? null) as { profileSlug?: unknown } | null;
  const profileSlug =
    data && typeof data.profileSlug === "string" && data.profileSlug
      ? data.profileSlug
      : null;
  const source = e.source?.trim() || null;
  return {
    event: {
      action: change.action,
      objectKind:
        profileSlug ?? normalizeObjectKind(e.subjectType ?? change.subject),
      origin: source && source !== "api" ? source : null,
    },
  };
}

/**
 * What CHANGED — the `activity.list` ledger (governed acts, decisions, runs,
 * session lifecycles; `listActivity`, its own floors) merged with the data
 * `events` stream. Events carry a workspace and a session and nothing else,
 * so they join only where they narrow faithfully (pod, workspace, session);
 * under a project or track the ledger stands alone — a shorter honest feed,
 * never an unnarrowed one under a scoped heading. An event about an object a
 * ledger row on the page already names is the SAME change and is dropped
 * (one item = one row). Neither source can follow an automation.
 */
async function readHappened(
  ctx: SignalsCtx,
  input: SignalScopeInput,
  opts: { limit: number; until?: string; since?: string }
) {
  if (!followsScope(input)) {
    return { signals: [], hasMore: false, failures: [] };
  }
  const eventsNarrow = !input.projectId && !input.trackId;
  const [ledger, events] = await Promise.all([
    settle(
      "activity",
      { items: [] as ActivityRow[], nextCursor: null as string | null },
      () =>
        listActivity({
          access: AccessContext.from(ctx).withLens(input.workspaceId),
          workspaceLens: input.workspaceId,
          roster: rosterReadFor(ctx),
          actor: { kind: "all" },
          projectId: input.projectId,
          trackId: input.trackId,
          sessionId: input.sessionId,
          since: opts.since,
          until: opts.until,
          limit: opts.limit,
        })
    ),
    settle(
      "events",
      [] as Array<{
        id: string;
        timestamp: Date;
        type: string;
        subjectType: string | null;
        subjectId: string | null;
        source?: string | null;
        data?: unknown;
      }>,
      async () =>
        eventsNarrow
          ? await eventsRouter.createCaller(ctx).read({
              limit: opts.limit,
              // Only RECORD CHANGES, in SQL before the limit: a governance
              // phase or a connector family renders no line, so it must
              // never use up the page (it used to, then the client dropped it).
              recordChanges: true,
              // Full rows: a data line names the record's kind (`data.profileSlug`)
              // and its writer (`source`) — both absent from the lean shape.
              lean: false,
              // `read` takes a plain optional string: null and undefined both
              // mean "do not narrow" (events carry no pod-wide sibling).
              ...(typeof input.workspaceId === "string"
                ? { workspaceId: input.workspaceId }
                : {}),
              ...(input.sessionId ? { sessionId: input.sessionId } : {}),
              ...(opts.since ? { since: new Date(opts.since) } : {}),
              ...(opts.until ? { until: new Date(opts.until) } : {}),
            })
          : []
    ),
  ]);
  const now = new Date();
  const named = new Set(
    ledger.value.items.map(
      (r) => `${normalizeObjectKind(r.object.kind)}:${r.object.id}`
    )
  );
  const eventSignals: Signal[] = events.value
    // `parseRecordChange` stays the authority over the SQL prefilter.
    .filter((e) => "event" in dataEventOf(e))
    .filter(
      (e) =>
        !(
          e.subjectType &&
          e.subjectId &&
          named.has(`${normalizeObjectKind(e.subjectType)}:${e.subjectId}`)
        )
    )
    .map((e) => ({
      id: `event:${e.id}`,
      kind: "event" as const,
      // `humanizeToken` is the vocabulary SSOT's fallback for any raw token —
      // an event type is not in any label table, and must never leak verbatim.
      title: humanizeToken(e.type),
      count: 1,
      occurredAt: e.timestamp,
      target:
        e.subjectType && e.subjectId
          ? { kind: e.subjectType, id: e.subjectId }
          : null,
      category: "data",
      ...dataEventOf(e),
      groupKey: null,
      ageBucket: ageBucketOf(e.timestamp, now),
      repeatCount: 1,
    }));
  const merged = [
    ...ledger.value.items.map((r) => signalFromActivity(r, now)),
    ...eventSignals,
  ].sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());
  return {
    signals: merged.slice(0, opts.limit),
    hasMore:
      merged.length > opts.limit ||
      ledger.value.nextCursor !== null ||
      events.value.length >= opts.limit,
    failures: failuresOf(ledger, events),
  };
}

// ── The lens page ───────────────────────────────────────────────────────────

/** One class of the lens page. */
export interface LensClassWire {
  /** The first `cap` rows, in the class's own order. */
  rows: Signal[];
  /** Rows in the class at this scope — the header's count door. */
  total: number;
  /** `total` is a FLOOR: a scan cap was hit or a half is unreadable. */
  truncated: boolean;
  /** More exists than `rows` shows ("Show all"). */
  hasMore: boolean;
  /** Halves that FAILED. Non-empty ⇒ partial, never "empty". */
  unreadable: SignalSubRead[];
}

export interface LensPageWire {
  blocking: LensClassWire;
  proposed: LensClassWire;
  happening: LensClassWire;
  produced: LensClassWire;
  happened: LensClassWire;
  /** System health — ONE deduplicated banner, or null when nothing is wrong. */
  status: StatusBanner | null;
  /** The health read failed: `status: null` then means NOT MEASURED. */
  statusUnreadable: boolean;
  /**
   * The next-hour START tier (`readNextMovePicks`), ranked by THE ranking
   * (`rankNextMoves`) — only when asked (`picks: true`) at pod / workspace
   * scope. Absent = not asked.
   */
  picks?: LensPagePicks;
}

/**
 * The first `cap` ROWS of a Blocking / Proposed list, as signals — a row is
 * what the client draws (`needsYouRows`, the SAME grouping every surface
 * uses): a session owing several things is ONE card, so its items are never
 * split across the cap nor counted as several rows. A plain signal slice let
 * one session owing 3 things eat 3 of 5 slots, and could cut a card's items
 * ("owes 5" when it owes 8) for every client that sends no caps. Server order
 * is kept.
 */
export function capByRow(
  all: readonly Signal[],
  cap: number
): { rows: Signal[]; hiddenRows: number } {
  const grouped = needsYouRows(all);
  const shaped = [...grouped.recent, ...grouped.older];
  const keep = new Set<string>();
  for (const r of shaped.slice(0, cap)) {
    for (const s of r.kind === "session" ? r.items : [r.signal]) keep.add(s.id);
  }
  return {
    rows: all.filter((s) => keep.has(s.id)),
    hiddenRows: Math.max(0, shaped.length - cap),
  };
}

function lensClass(
  all: Signal[],
  cap: number,
  opts: {
    total?: number;
    truncated: boolean;
    hasMore?: boolean;
    /** Cap by drawn ROW (`capByRow`) — Blocking and Proposed. */
    byRow?: boolean;
    failures: ReadonlyArray<{ source: SignalSubRead }>;
  }
): LensClassWire {
  const unreadable = [...new Set(opts.failures.map((f) => f.source))];
  const total = opts.total ?? all.length;
  const truncated = opts.truncated || unreadable.length > 0;
  const cut = opts.byRow
    ? capByRow(all, cap)
    : { rows: all.slice(0, cap), hiddenRows: Math.max(0, all.length - cap) };
  return {
    rows: cut.rows,
    total,
    truncated,
    hasMore:
      cut.hiddenRows > 0 ||
      total > all.length ||
      truncated ||
      (opts.hasMore ?? false),
    unreadable,
  };
}

/**
 * Sessions a page row already stands for — a Blocking row filed under a
 * session (its target or its session group) and a Happening session. A pick
 * never repeats them: a session owing you something is "only you can answer",
 * one an agent is in is watched, not started.
 */
function sessionIdsOnPage(signals: readonly Signal[]): Set<string> {
  const out = new Set<string>();
  for (const s of signals) {
    if (s.target?.kind === "session") out.add(s.target.id);
    const group = s.groupKey;
    if (group && group.startsWith("session:")) out.add(group.slice(8));
  }
  return out;
}

/** The next-hour picks exist where Home reads: pod / workspace scope only. */
function picksAllowed(input: SignalScopeInput): boolean {
  return (
    !input.projectId &&
    !input.trackId &&
    !input.sessionId &&
    !input.automationId
  );
}

async function readLensPage(
  ctx: SignalsCtx,
  input: SignalScopeInput,
  caps: Record<keyof typeof LENS_CAPS, number>,
  since: string | undefined,
  opts: { picks?: boolean } = {}
): Promise<LensPageWire> {
  const [attention, happening, produced, happened] = await Promise.all([
    readAttention(ctx, input, CLUSTER_PAGE_LIMIT),
    settle("liveness", { signals: [] as Signal[], truncated: false }, () =>
      readHappening(ctx, input)
    ),
    settle("outputs", { signals: [] as Signal[], truncated: false }, () =>
      readProduced(ctx, input)
    ),
    readHappened(ctx, input, { limit: 100, since }),
  ]);
  const counts = countOf(attention);
  const blocking = blockingSignals(attention);
  const proposed = proposedSignals(attention);
  const statusFailed = attention.failures.status.length > 0;
  const picks =
    opts.picks && picksAllowed(input)
      ? await readNextMovePicks(
          {
            userId: requireUserId(ctx.userId),
            roster: rosterReadFor(ctx),
            access: AccessContext.from(ctx),
          },
          { workspaceId: input.workspaceId },
          {
            excludeSessionIds: sessionIdsOnPage([
              ...blocking,
              ...happening.value.signals,
            ]),
            projectNames: (ids) => readProjectNames(ctx, ids),
          }
        )
      : undefined;
  return {
    ...(picks ? { picks } : {}),
    blocking: lensClass(blocking, caps.blocking, {
      // THE needs-you number (`countNeedsYou`), the same the badge shows.
      total: counts.needsYou,
      truncated: counts.truncated,
      byRow: true,
      failures: attention.failures.blocking,
    }),
    proposed: lensClass(proposed, caps.proposed, {
      truncated: counts.draftsTruncated || attention.notificationsTruncated,
      byRow: true,
      failures: attention.failures.proposed,
    }),
    happening: lensClass(happening.value.signals, caps.happening, {
      truncated: happening.value.truncated,
      failures: failuresOf(happening),
    }),
    produced: lensClass(produced.value.signals, caps.produced, {
      truncated: produced.value.truncated,
      failures: failuresOf(produced),
    }),
    happened: lensClass(happened.signals, caps.happened, {
      truncated: happened.hasMore,
      hasMore: happened.hasMore,
      failures: happened.failures,
    }),
    status: statusFailed ? null : statusBanner(attention.statusNotifications),
    statusUnreadable: statusFailed,
  };
}

/**
 * The body of `signals.count` — one function so `count` and `countByProject`
 * answer over the SAME population by construction (a rail badge must equal the
 * number its project's own page shows), and the SAME reader `list` uses.
 *
 * THE needs-you rule (`@synap-core/types/units` `needs-you.ts`): owed slots +
 * pending decisions + sessions awaiting your review, summed by `needsYouTotal`
 * inside `countNeedsYou`, plus asking notifications. Items, not sessions.
 * Decisions are distinct (shape, session) clusters.
 *
 * DRAFTS NEVER COUNT (founder decision; since 2026-10-04 they are PROPOSED):
 * the owed half by `excludeDrafts`, the decisions half by
 * `excludeDraftSessions`, the review half by `needsYouReason` — each in SQL,
 * so drafts cannot eat a scan cap. Asking drafts are reported beside the
 * number (`drafts`), never inside it.
 */
async function countSignals(ctx: SignalsCtx, input: SignalScopeInput) {
  const attention = await readAttention(ctx, input, CLUSTER_PAGE_LIMIT);
  throwIfFailed([
    ...attention.failures.blocking,
    ...attention.failures.proposed,
  ]);
  return countOf(attention);
}

const LensCaps = z
  .object({
    blocking: z.number().int().min(1).max(100),
    proposed: z.number().int().min(1).max(100),
    happening: z.number().int().min(1).max(100),
    produced: z.number().int().min(1).max(100),
    happened: z.number().int().min(1).max(100),
  })
  .partial();

export const signalsRouter = router({
  /**
   * The one attention read. A single lens returns `{ signals }` for one class:
   *
   *   `needs-you`   — BLOCKING (the tray, "Needs you").
   *   `proposed`    — PROPOSED: agent drafts + AI suggestions.
   *   `suggestions` — AI suggestions alone (the capped "possibilities" lane).
   *   `happening`   — HAPPENING: sessions an agent is working on now.
   *   `produced`    — PRODUCED: what the scope's work made.
   *   `history`     — HAPPENED: the activity ledger + data events (`cursor`
   *                   pages older; `since` bounds it).
   *
   * `page` returns `{ signals: [], page }` — every class, capped (`caps`), with
   * its total, `hasMore`, truncation and failed halves, plus the status
   * banner. Every row of every class is the SAME `Signal` shape.
   */
  list: protectedProcedure
    .input(
      z.object({
        ...SignalScope,
        lens: z
          .enum([
            "needs-you",
            "proposed",
            "suggestions",
            "happening",
            "produced",
            "history",
            "page",
          ])
          .default("needs-you"),
        limit: z.number().min(1).max(100).default(50),
        /** History lens only: return signals strictly older than this instant. */
        cursor: z.string().datetime().optional(),
        /** History lens and the page's Happened: only at or after this instant. */
        since: z.string().datetime({ offset: true }).optional(),
        /** Page lens only: per-class caps (defaults: `LENS_CAPS`, `@synap-core/types/lens`). */
        caps: LensCaps.optional(),
        /**
         * Page lens only: also send the next-hour START tier (`page.picks`),
         * ranked by THE ranking. Pod / workspace scope only (Home).
         */
        picks: z.boolean().optional(),
      })
    )
    .query(
      async ({
        ctx,
        input,
      }): Promise<{ signals: Signal[]; page?: LensPageWire }> => {
        if (input.lens === "page") {
          return {
            signals: [],
            page: await readLensPage(
              ctx,
              input,
              { ...LENS_CAPS, ...input.caps },
              input.since,
              { picks: input.picks === true }
            ),
          };
        }
        if (input.lens === "happening") {
          return {
            signals: (await readHappening(ctx, input)).signals.slice(
              0,
              input.limit
            ),
          };
        }
        if (input.lens === "produced") {
          return {
            signals: (await readProduced(ctx, input)).signals.slice(
              0,
              input.limit
            ),
          };
        }
        if (input.lens === "history") {
          const happened = await readHappened(ctx, input, {
            limit: input.limit,
            until: input.cursor,
            since: input.since,
          });
          throwIfFailed(happened.failures);
          return { signals: happened.signals };
        }
        // needs-you · proposed · suggestions — one reader.
        const attention = await readAttention(
          ctx,
          input,
          input.lens === "needs-you" ? input.limit : CLUSTER_PAGE_LIMIT
        );
        if (input.lens === "needs-you") {
          throwIfFailed(attention.failures.blocking);
          // A plain cut of the ONE order (`orderNeedsYou`).
          return { signals: blockingSignals(attention).slice(0, input.limit) };
        }
        throwIfFailed(attention.failures.proposed);
        return {
          signals: (input.lens === "proposed"
            ? proposedSignals(attention)
            : unionSuggestions(
                attention.notifications,
                new Date(),
                attention.containers
              )
          ).slice(0, input.limit),
        };
      }
    ),

  /**
   * Skip a next-hour pick until `until` (the viewer's next local midnight) —
   * the picker's Skip. Stored in the caller's OWN preference row
   * (`user_preferences.ui_preferences.nextMoveSkips`, owner floor by key);
   * `until` is clamped to at most 36h ahead. The page read leaves a skipped
   * pick out until then.
   */
  skipNextMove: protectedProcedure
    .input(
      z.object({
        key: z
          .string()
          .regex(/^(entity|session):[0-9a-f-]{36}$/i, "Not a pick key"),
        until: z.string().datetime({ offset: true }),
      })
    )
    .mutation(({ ctx, input }) =>
      writeNextMoveSkip({
        userId: requireUserId(ctx.userId),
        key: input.key,
        until: new Date(input.until),
      })
    ),

  /**
   * ONE number for both badges: distinct pending clusters + unread asking
   * notifications + owed slots + sessions awaiting your review — plus
   * `blocked`, the owed subset. `truncated` is inherited from every capped
   * half; when true, the number is a FLOOR, and a caller must render it as
   * such (e.g. "99+") rather than as an exact total.
   *
   * Takes the SAME scope as `list` and reads through the SAME function, so the
   * badge always equals the Blocking rows under it at that scope.
   *
   * The number ships WITH its parts: `decisions`, `notifications`, `blocked`
   * and `review`, with `needsYou === decisions + notifications + blocked +
   * review`. A client reads the part it needs; it never derives one by
   * subtracting the others. `suggestions` and `drafts` (PROPOSED) ship in the
   * same result and are NOT parts: they are never added into `needsYou`.
   */
  count: protectedProcedure
    .input(z.object(SignalScope).default({}))
    .query(({ ctx, input }) => countSignals(ctx, input)),

  /**
   * `count` for SEVERAL projects in one round-trip — the desktop project rail
   * badges every project it shows at once.
   *
   * Deliberately `count` itself, called once per project: the badge on a rail
   * plate must equal the needs-you number that project's own page shows, and a
   * second, grouped predicate would be a fork of the one this router exists to
   * hold. Projects are few (the rail caps them), so the fan-out is bounded.
   * A project whose count FAILS is reported as such, never as zero.
   */
  countByProject: protectedProcedure
    .input(
      z.object({
        projectIds: z.array(z.string().uuid()).max(50),
      })
    )
    .query(async ({ ctx, input }) => {
      const ids = [...new Set(input.projectIds)];
      const settled = await Promise.allSettled(
        ids.map((projectId) => countSignals(ctx, { projectId }))
      );
      return ids.map((projectId, i) => {
        const r = settled[i]!;
        return r.status === "fulfilled"
          ? { projectId, status: "ok" as const, count: r.value }
          : { projectId, status: "unavailable" as const };
      });
    }),
});
