/**
 * The facts every status read draws from (status-flow plan W0b): when a thing
 * entered its status (the transition log), what it waits on (owed slots,
 * pending proposals, `blocked_by` edges, holds, open PRs, open sub-sessions:
 * `readWaitingOnFor`), and the read-side category of a
 * playbook run. Shared by the per-object read (`status-read.ts`) and the
 * rollups (`status-rollup.ts`), so the two cannot disagree.
 *
 * Every reader here THROWS on a failed read; the caller says `unavailable`.
 */
import {
  and,
  asc,
  db,
  drizzleSql,
  eq,
  events,
  focusSessions,
  inArray,
  links,
  listHolds,
  or,
  proposals,
  ProposalStatus,
  type HoldSubjectRef,
} from "@synap/database";
import type { PlaybookRunStatus } from "@synap/database/schema";
import type { SQL } from "drizzle-orm";
import {
  parseHoldMovesRef,
  type LifecycleCategory,
  type RecordedHold,
  type TransitionSubjectType,
} from "@synap-core/types/lifecycle";
import {
  deriveWaitingOn,
  HOLD_ON_WAITING_ON,
  waitingOnReasonOf,
  type WaitingOnMark,
  type WaitingOnRef,
  type WaitingOnSource,
} from "@synap-core/types/units";
import {
  parsePullRequestRef,
  type PullRequestRef,
  type PullRequestStateFacts,
} from "@synap-core/types";
import type { OpenBlocker } from "@synap-core/types/connections";
import { resolveSessionTitle } from "@synap-core/types/focus-sessions";
import {
  buildObjectActionTitle,
  resolveWaitingOnReasonLabel,
} from "@synap-core/types/vocabulary";
import type { ExpectedOutput } from "@synap/playbooks";
import {
  sessionReadableWhere,
  type SessionReader,
} from "../../access/session-visibility.js";
import { grantReadPredicate } from "../../access/grant-read.js";
import { OPEN_SESSION_STATUSES } from "../focus-sessions/session-statuses.js";
import type { SessionSubject } from "../focus-sessions/session-subject-where.js";
import { extractProposalName } from "../proposals/fingerprint.js";
import type { ResolvedScope } from "../../utils/scope-filter.js";

/** Counts per lifecycle category; a category with none is left out. */
export type CategoryCounts = Partial<Record<LifecycleCategory, number>>;

/**
 * A playbook run's status, read as the RUN base lifecycle (status-flow plan
 * §3: runs are mapped when read, never moved through a door). Keyed by every
 * stored status, so a new one stops the build until it is classified.
 */
export const RUN_STATUS_DECLARATION = {
  proposed: { category: "open" },
  running: { category: "active" },
  waiting_on_you: { category: "paused" },
  stale: { category: "paused" },
  completed: { category: "done" },
  failed: { category: "lost" },
  cancelled: { category: "lost" },
} as const satisfies Record<PlaybookRunStatus, { category: LifecycleCategory }>;

export function runStatusCategory(status: string): LifecycleCategory | null {
  return Object.hasOwn(RUN_STATUS_DECLARATION, status)
    ? RUN_STATUS_DECLARATION[status as PlaybookRunStatus].category
    : null;
}

export function addCount(
  counts: CategoryCounts,
  category: LifecycleCategory | null,
  n: number
): void {
  if (category && n > 0) counts[category] = (counts[category] ?? 0) + n;
}

/**
 * When each subject last ENTERED its status: its latest transition event
 * (`<subject>.transition.completed`), an entity's own lifecycle only (a role's
 * move is the facet's). A subject with none is absent: the caller falls back
 * to a stored date and says the time was not measured. Goal and session
 * events carry their DELIVERY time (the sweeper, up to ~90 s after the move).
 */
export async function lastTransitionAt(
  refs: ReadonlyArray<{ type: TransitionSubjectType; id: string }>
): Promise<Map<string, Date>> {
  const out = new Map<string, Date>();
  if (refs.length === 0) return out;
  const { TRANSITION_EVENT_TYPES } = await import("@synap/events");
  const rows = await db
    .select({
      subjectType: events.subjectType,
      subjectId: events.subjectId,
      at: drizzleSql<Date | string>`max(${events.timestamp})`,
    })
    .from(events)
    .where(
      and(
        inArray(events.type, Object.values(TRANSITION_EVENT_TYPES)),
        // Both key columns, so the (subject_type, subject_id, timestamp)
        // index answers it: orient must never scan the event log.
        inArray(events.subjectType, [...new Set(refs.map((r) => r.type))]),
        inArray(events.subjectId, [...new Set(refs.map((r) => r.id))]),
        drizzleSql`(${events.subjectType} <> 'entity' OR ${events.data}->>'role' IS NULL)`
      )
    )
    .groupBy(events.subjectType, events.subjectId);
  for (const r of rows) {
    out.set(`${r.subjectType}:${r.subjectId}`, new Date(r.at));
  }
  return out;
}

/**
 * The subjects whose moves a rollup counts: `rows` selects `id` and `key`
 * (the bucket it counts in) of subjects the CALLER can see, built through the
 * read floors. Joined on both event key columns, so the index answers it.
 */
export function movesOf(subjectType: TransitionSubjectType, rows: SQL): SQL {
  return drizzleSql`SELECT ${subjectType}::text AS st, m.id::text AS sid, m.key::text AS k FROM (${rows}) m`;
}

/**
 * Status moves since `since` of the given subjects (`movesOf` rows, UNION
 * ALL'd), per bucket. Counted from the transition log: a move made before the
 * door existed is not counted. THROWS.
 */
export async function countMovesSince(
  since: Date,
  subjects: SQL[]
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (subjects.length === 0) return out;
  const { TRANSITION_EVENT_TYPES } = await import("@synap/events");
  const types = drizzleSql.join(
    Object.values(TRANSITION_EVENT_TYPES).map((t) => drizzleSql`${t}`),
    drizzleSql`, `
  );
  const res = (await db.execute(drizzleSql`
    SELECT s.k AS k, cast(count(*) as integer) AS n
      FROM (${drizzleSql.join(subjects, drizzleSql` UNION ALL `)}) s
      JOIN ${events} e
        ON e.subject_type = s.st AND e.subject_id = s.sid
     WHERE e.type IN (${types})
       AND e.timestamp >= ${since.toISOString()}::timestamptz
     GROUP BY s.k`)) as
    Array<{ k: string; n: number }> | { rows: Array<{ k: string; n: number }> };
  for (const r of Array.isArray(res) ? res : res.rows) {
    out.set(r.k, Number(r.n));
  }
  return out;
}

/** One waiting-on question: the facts that count for one set of things. */
export interface WaitingOnQuestion {
  /**
   * The caller floored this question's session ids at a CONTAINER the reader
   * may count — a goal's open runs, every member's, like its criterion marks:
   * its owed slots, holds and pull requests count for every one of them, and
   * a ref names its thing only when the reader may read that session (else
   * its reason's words, no id). Without it every source keeps the reader's
   * own session floor.
   */
  container?: boolean;
  /** Owed slots: of these sessions, of sessions about these things, or in a scope. */
  owed?:
    | { sessionIds: string[] }
    | { subject: SessionSubject }
    | { scope: ResolvedScope };
  /** Pending proposals filed by these sessions or targeting these things. */
  proposals?: { sessionIds?: string[]; targetIds?: string[] };
  /** Nodes whose open `blocked_by` blockers count. */
  blockedNodes?: Array<{ kind: "session" | "entity" | "track"; id: string }>;
  /** Things whose CURRENT hold counts (a pause, read off the transition log). */
  holds?: HoldSubjectRef[];
  /** Sessions whose open pull request outcomes count, by their recorded state. */
  workUnitsOf?: string[];
  /** Sessions whose OPEN sub-sessions (`spawned_from`) count. */
  childrenOf?: string[];
}

/**
 * THE question a session's waiting-on asks — every source that can hold one
 * session up. statusOf and the continuation packet both ask it, so a session
 * waits on the same things wherever it is read.
 */
export function sessionWaitingOnQuestion(sessionId: string): WaitingOnQuestion {
  return {
    owed: { sessionIds: [sessionId] },
    proposals: { sessionIds: [sessionId] },
    blockedNodes: [{ kind: "session", id: sessionId }],
    holds: [{ subjectType: "focus_session", subjectId: sessionId }],
    workUnitsOf: [sessionId],
    childrenOf: [sessionId],
  };
}

/**
 * Who reads the waiting-on: THE session read rule (`sessionReadableWhere`;
 * `roster` is the door's, `rosterReadFor`, default owner-only).
 */
export type WaitingOnReader = Pick<SessionReader, "userId" | "roster">;

/**
 * What a set of things WAITS ON, in the goal's own vocabulary (R4,
 * `deriveWaitingOn`): one mark list for the whole set.
 * See {@link readWaitingOnFor}.
 */
export async function readWaitingOn(
  input: WaitingOnReader & WaitingOnQuestion
): Promise<WaitingOnMark[]> {
  const { userId, roster, ...question } = input;
  const out = await readWaitingOnFor(
    { userId, roster },
    new Map([["all", question]])
  );
  return out.get("all") ?? [];
}

/**
 * THE waiting-on collector (dev-work plan P0.1, P1.1): what each question's
 * things wait on, for MANY questions in a bounded number of queries. Every
 * status read (statusOf, the goal facts, the rollups) asks it; nothing else
 * collects waiting-on sources. The session-id sources are read once for every
 * question (per floor: the reader's own, and the container's when a question
 * is one); an owed question by subject or scope is its own read (statusOf
 * asks one per thing, at most its 10); the PR states are one more read, and
 * which sessions the reader may read, one after.
 *
 *   · owed slots — THE needs-you lens (`listNeedsYouOwed`), so a draft's
 *     ask-less slots never count here when needs-you leaves them out. Every
 *     slot in the lens counts, whatever its class: a stopped or older ask
 *     still holds the work up, it only leaves the needs-you headline. At most
 *     {@link WAITING_READ_CAP} per session;
 *   · pending proposals, under THE proposal user floor;
 *   · open `blocked_by` blockers (THE dependency read);
 *   · the current hold of a paused thing (`listHolds`, `HOLD_ON_WAITING_ON`);
 *   · open pull request outcomes, by what the pod recorded about them
 *     (`readPullRequestStates`, one read for every PR asked about): checks
 *     not settled wait on CI, green ones on the merge queue;
 *   · open sub-sessions.
 *
 * Each source names what is waited on (`WaitingOnMark.refs`), and only what
 * the reader may read: a session it may not read is counted (a container
 * question, or a hold on it) under its reason's words, never its id, label
 * or the mover's reason. The callers have floored the ids they ask about;
 * every source read is floored again on the reader. THROWS on a failed read.
 */
export async function readWaitingOnFor<K>(
  reader: WaitingOnReader,
  questions: ReadonlyMap<K, WaitingOnQuestion>
): Promise<Map<K, WaitingOnMark[]>> {
  const { userId } = reader;
  const asked = [...questions.entries()];
  const union = (
    pick: (q: WaitingOnQuestion) => readonly string[] | undefined,
    container?: boolean
  ) => [
    ...new Set(
      asked
        .filter(
          ([, q]) => container === undefined || !!q.container === container
        )
        .flatMap(([, q]) => pick(q) ?? [])
    ),
  ];
  const owedIdsOf = (q: WaitingOnQuestion) =>
    q.owed && "sessionIds" in q.owed ? q.owed.sessionIds : undefined;
  const owedSessionIds = union(owedIdsOf, false);
  const owedContainerIds = union(owedIdsOf, true);
  const proposalSessionIds = union((q) => q.proposals?.sessionIds);
  const proposalTargetIds = union((q) => q.proposals?.targetIds);
  const nodes = [
    ...new Map(
      asked
        .flatMap(([, q]) => q.blockedNodes ?? [])
        .map((n) => [`${n.kind}:${n.id}`, n])
    ).values(),
  ];
  const holdSubjects = [
    ...new Map(
      asked.flatMap(([, q]) => q.holds ?? []).map((h) => [holdKey(h), h])
    ).values(),
  ];
  const unitSessionIds = union((q) => q.workUnitsOf, false);
  const unitContainerIds = union((q) => q.workUnitsOf, true);
  const parentIds = union((q) => q.childrenOf);

  // Loaded late: these reach the router layer, the event floor or the packet.
  const [{ readDependencyFacts }, { proposalUserFloor }, { listNeedsYouOwed }] =
    await Promise.all([
      import("../links/dependency-links.js"),
      import("../../routers/proposals/scope-conditions.js"),
      import("../signals/needs-you-owed.js"),
    ]);
  const unscoped: ResolvedScope = {
    workspaceLens: undefined,
    projectLens: undefined,
  };
  // Bounded by the session ids; capped per session below, so one session's
  // many slots never crowd another's out.
  const owedOf = (sessionIds: string[], containerFloored: boolean) =>
    sessionIds.length
      ? listNeedsYouOwed({
          userId,
          scope: unscoped,
          sessionIds,
          ...(containerFloored ? { containerFloored } : {}),
          limit: Number.MAX_SAFE_INTEGER,
        })
      : Promise.resolve([]);
  const [
    owedBySessions,
    owedByContainers,
    owedByQuestion,
    pending,
    deps,
    holds,
    units,
    children,
  ] = await Promise.all([
    owedOf(owedSessionIds, false),
    owedOf(owedContainerIds, true),
    // A subject or a scope is its own question (one read each).
    Promise.all(
      asked.map(([, q]) =>
        q.owed && !("sessionIds" in q.owed)
          ? listNeedsYouOwed({
              userId,
              scope: "scope" in q.owed ? q.owed.scope : unscoped,
              limit: WAITING_READ_CAP,
              ...("subject" in q.owed ? { subject: q.owed.subject } : {}),
            })
          : Promise.resolve(null)
      )
    ),
    proposalSessionIds.length + proposalTargetIds.length > 0
      ? db
          .select({
            id: proposals.id,
            sessionId: proposals.sessionId,
            targetId: proposals.targetId,
            targetType: proposals.targetType,
            proposalType: proposals.proposalType,
            data: proposals.data,
          })
          .from(proposals)
          .where(
            and(
              eq(proposals.status, ProposalStatus.PENDING),
              proposalUserFloor(userId),
              or(
                proposalSessionIds.length
                  ? inArray(proposals.sessionId, proposalSessionIds)
                  : undefined,
                proposalTargetIds.length
                  ? inArray(proposals.targetId, proposalTargetIds)
                  : undefined
              )
            )
          )
      : Promise.resolve([]),
    nodes.length ? readDependencyFacts(nodes, userId) : null,
    holdSubjects.length
      ? listHolds(db, { subjects: holdSubjects })
      : Promise.resolve([]),
    readOpenWorkUnits(reader, unitSessionIds, unitContainerIds),
    readOpenChildren(reader, parentIds),
  ]);

  // Which of the sessions behind a source the reader may READ: only those
  // are named. A hold's `until.moves` session is one too.
  const readable = await readableSessionIds(reader, [
    ...owedContainerIds,
    ...unitSessionIds,
    ...unitContainerIds,
    ...holds.flatMap((h) => {
      const until = h.hold.until;
      const moves =
        until && "moves" in until ? parseHoldMovesRef(until.moves) : null;
      return [
        ...(h.subjectType === "focus_session" ? [h.subjectId] : []),
        ...(moves?.subjectType === "focus_session" ? [moves.subjectId] : []),
      ];
    }),
  ]);

  const holdOf = new Map(holds.map((h) => [holdKey(h), h]));
  const out = new Map<K, WaitingOnMark[]>();
  asked.forEach(([key, q], i) => {
    const sources: WaitingOnSource[] = [];
    const owedIds = new Set(owedIdsOf(q) ?? []);
    const perSession = new Map<string, number>();
    const owed =
      owedByQuestion[i] ??
      (q.container ? owedByContainers : owedBySessions).filter((s) => {
        if (!owedIds.has(s.sessionId)) return false;
        const n = (perSession.get(s.sessionId) ?? 0) + 1;
        perSession.set(s.sessionId, n);
        return n <= WAITING_READ_CAP;
      });
    for (const s of owed) {
      const source: WaitingOnSource = {
        kind: "owed_slot",
        blockedReason: s.blockedReason ?? null,
      };
      sources.push(
        !q.container || readable.has(s.sessionId)
          ? {
              ...source,
              ref: { kind: "slot", id: s.sessionId, label: s.label },
            }
          : unnamed(source)
      );
    }
    const bySession = new Set(q.proposals?.sessionIds ?? []);
    const byTarget = new Set(q.proposals?.targetIds ?? []);
    for (const p of pending) {
      const about =
        (p.sessionId != null && bySession.has(p.sessionId)) ||
        (p.targetId != null && byTarget.has(p.targetId));
      if (!about) continue;
      sources.push({
        kind: "pending_proposal",
        ref: {
          kind: "proposal",
          id: p.id,
          label: buildObjectActionTitle({
            action: p.proposalType,
            objectKind: p.targetType,
            objectName: extractProposalName(p.data) ?? null,
            mood: "imperative",
          }),
        },
      });
    }
    for (const n of q.blockedNodes ?? []) {
      for (const b of deps?.get(`${n.kind}:${n.id}`)?.blockers ?? []) {
        sources.push({ kind: "blocked_by", ref: blockerRef(b) });
      }
    }
    for (const h of q.holds ?? []) {
      const held = holdOf.get(holdKey(h));
      if (!held) continue;
      const source: WaitingOnSource = { kind: "hold", on: held.hold.on };
      sources.push(
        h.subjectType === "focus_session" && !readable.has(h.subjectId)
          ? unnamed(source)
          : { ...source, ref: holdWaitingOnRef(held.hold, readable) }
      );
    }
    for (const sid of q.workUnitsOf ?? []) {
      // Another question's container may have read a session this one may not.
      if (!q.container && !readable.has(sid)) continue;
      for (const u of units.get(sid) ?? []) {
        const source: WaitingOnSource = {
          kind: "work_unit",
          state: u.facts.state,
          ...(u.facts.checks ? { checks: u.facts.checks } : {}),
        };
        sources.push(
          !q.container || readable.has(sid)
            ? {
                ...source,
                ref: { kind: "pull_request", url: u.url, label: u.label },
              }
            : unnamed(source)
        );
      }
    }
    for (const sid of q.childrenOf ?? []) {
      for (const c of children.get(sid) ?? []) {
        sources.push({
          kind: "child_session",
          ref: { kind: "session", id: c.id, label: c.title },
        });
      }
    }
    out.set(key, deriveWaitingOn(sources));
  });
  return out;
}

/** Owed slots read per session (and per subject or scope question): a count past it is a floor. */
export const WAITING_READ_CAP = 100;

const holdKey = (h: HoldSubjectRef) =>
  `${h.subjectType}:${h.subjectId}:${h.facetId ?? ""}`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `person:<uuid>`-style refs a mover writes: the id, never shown as words. */
const TYPED_ID =
  /^[a-z_]+:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/**
 * A source on a session the reader may count but not read: its reason's
 * words, no id, nothing the session's people wrote (as `blockerRef` does for
 * a hidden blocker).
 */
function unnamed(source: WaitingOnSource): WaitingOnSource {
  const reason = waitingOnReasonOf(source);
  return reason
    ? {
        ...source,
        ref: { kind: "thing", label: resolveWaitingOnReasonLabel(reason) },
      }
    : source;
}

/**
 * What a hold names, as a ref: its reason in the mover's words, else its
 * date, else its reason's words. A `<kind>:<uuid>` ref is an id, never shown.
 * With `readable`, a session it resumes on is named only when the reader may
 * read it.
 */
export function holdWaitingOnRef(
  hold: RecordedHold,
  readable?: ReadonlySet<string>
): WaitingOnRef {
  const until = hold.until;
  const parsed =
    until && "moves" in until ? parseHoldMovesRef(until.moves) : null;
  const moves =
    parsed?.subjectType === "focus_session" &&
    readable &&
    !readable.has(parsed.subjectId)
      ? null
      : parsed;
  const typed = hold.ref ? TYPED_ID.exec(hold.ref) : null;
  const kind: WaitingOnRef["kind"] =
    moves?.subjectType === "focus_session"
      ? "session"
      : hold.on === "person"
        ? "person"
        : hold.on === "decision"
          ? "decision"
          : "thing";
  const id = moves?.subjectId ?? typed?.[1];
  const said = hold.reason?.trim() || (!typed && hold.ref?.trim()) || null;
  const reason = HOLD_ON_WAITING_ON[hold.on];
  return {
    kind,
    ...(id ? { id } : {}),
    label:
      said ??
      (until && "date" in until
        ? until.date.slice(0, 10)
        : resolveWaitingOnReasonLabel(reason)),
  };
}

/** Which of `sessionIds` the reader may read (THE session read rule). THROWS. */
async function readableSessionIds(
  reader: WaitingOnReader,
  sessionIds: readonly string[]
): Promise<Set<string>> {
  const ids = [...new Set(sessionIds)].filter((id) => UUID.test(id));
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ id: focusSessions.id })
    .from(focusSessions)
    .where(and(inArray(focusSessions.id, ids), sessionReadableWhere(reader)));
  return new Set(rows.map((r) => r.id));
}

/** A blocker as a ref: named only when the reader may see it. */
function blockerRef(b: OpenBlocker): WaitingOnRef {
  if (b.hidden) {
    return {
      kind: "thing",
      label: resolveWaitingOnReasonLabel("another_work"),
    };
  }
  return {
    kind: b.kind === "session" ? "session" : "thing",
    id: b.id,
    label: b.title?.trim() || resolveWaitingOnReasonLabel("another_work"),
  };
}

/**
 * The OPEN pull request outcomes of these sessions (an outcome not met nor
 * retired, `workUnitsSection`) that the pod recorded a state for, per
 * session: `sessionIds` under the reader's session floor, `containerIds`
 * (a container question's, floored by its caller) under the calling key's
 * grant alone. A PR with no recorded fact is left out (never guessed). One
 * read of the sessions, one of the PR states. THROWS.
 */
async function readOpenWorkUnits(
  reader: WaitingOnReader,
  sessionIds: readonly string[],
  containerIds: readonly string[] = []
): Promise<
  Map<
    string,
    Array<{ url: string; label: string; facts: PullRequestStateFacts }>
  >
> {
  const out = new Map<
    string,
    Array<{ url: string; label: string; facts: PullRequestStateFacts }>
  >();
  if (sessionIds.length + containerIds.length === 0) return out;
  const [{ workUnitsSection }, { readPullRequestStates, pullRequestKey }] =
    await Promise.all([
      import("../focus-sessions/continuation-packet.js"),
      import("../dev-loop/pr-state.js"),
    ]);
  const rows = await db
    .select({
      id: focusSessions.id,
      expectedOutputs: focusSessions.expectedOutputs,
    })
    .from(focusSessions)
    .where(
      or(
        sessionIds.length
          ? and(
              inArray(focusSessions.id, [...sessionIds]),
              sessionReadableWhere(reader)
            )
          : undefined,
        containerIds.length
          ? and(
              inArray(focusSessions.id, [...containerIds]),
              grantReadPredicate(focusSessions)
            )
          : undefined
      )
    );
  const open: Array<{
    sessionId: string;
    url: string;
    label: string;
    ref: PullRequestRef;
  }> = [];
  for (const row of rows) {
    const all = Array.isArray(row.expectedOutputs)
      ? (row.expectedOutputs as ExpectedOutput[]).filter(
          (s) => !!s && typeof s === "object"
        )
      : [];
    const units = workUnitsSection(all, { uncapped: true });
    if (units.status !== "ok") continue;
    for (const u of units.items) {
      if (u.state === "met" || u.state === "retired" || !u.url) continue;
      const ref = parsePullRequestRef(u.url);
      if (ref)
        open.push({ sessionId: row.id, url: u.url, label: u.label, ref });
    }
  }
  if (open.length === 0) return out;
  const states = await readPullRequestStates(
    open.map((o) => o.ref),
    { userId: reader.userId, roster: reader.roster ?? false }
  );
  for (const o of open) {
    const facts = states.get(pullRequestKey(o.ref));
    if (!facts) continue;
    const list = out.get(o.sessionId) ?? [];
    list.push({ url: o.url, label: o.label, facts });
    out.set(o.sessionId, list);
  }
  return out;
}

/** The OPEN sub-sessions (`child --spawned_from--> parent`) of each parent. THROWS. */
async function readOpenChildren(
  reader: WaitingOnReader,
  parentIds: readonly string[]
): Promise<Map<string, Array<{ id: string; title: string }>>> {
  const out = new Map<string, Array<{ id: string; title: string }>>();
  if (parentIds.length === 0) return out;
  const rows = await db
    .select({
      parentId: links.toId,
      id: focusSessions.id,
      title: focusSessions.title,
      goal: focusSessions.goal,
    })
    .from(links)
    .innerJoin(
      focusSessions,
      eq(drizzleSql`${focusSessions.id}::text`, links.fromId)
    )
    .where(
      and(
        eq(links.fromType, "session"),
        eq(links.toType, "session"),
        eq(links.linkType, "spawned_from"),
        inArray(links.toId, [...parentIds]),
        inArray(focusSessions.status, [...OPEN_SESSION_STATUSES]),
        sessionReadableWhere(reader)
      )
    )
    .orderBy(asc(focusSessions.createdAt));
  for (const r of rows) {
    const list = out.get(r.parentId) ?? [];
    list.push({ id: r.id, title: resolveSessionTitle(r) });
    out.set(r.parentId, list);
  }
  return out;
}
