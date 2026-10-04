/**
 * ACTIVITY — what happened, filtered (`activity.list`).
 *
 * One newest-first ledger over four sources the pod already records, merged
 * under ONE ordering and ONE cursor. Contract: `@synap-core/types/activity`.
 *
 *   proposal — every governed act, by whoever FILED it, at `created_at`.
 *              Auto-approved `focus_session` receipts are left out: the
 *              session source already carries that lifecycle, once.
 *   decision — a person's approve / reject / revert / failed approval, by the
 *              REVIEWER, at `reviewed_at`.
 *   run      — automation + playbook runs, at `coalesce(completed_at,
 *              started_at)`. An automation run is a RULE acting (`system`).
 *   session  — one row per session of the project-path population (work +
 *              tracked runs; no receipts, no untracked runs, no appointments,
 *              no session that a playbook run already carries): "started" at its start while it
 *              is live, "closed" at `coalesce(closed_at, updated_at)` once it
 *              settled.
 *
 * ── FILTERING AND PAGING ARE IN SQL ─────────────────────────────────────────
 * Every filter (actor, project, outcome, source, since) and the cursor are
 * pushed into each source's WHERE. Each source reads at most `limit + 1` rows
 * past the cursor in the shared order `(occurred_at DESC, key DESC)`; the
 * merge keeps the first `limit`. Because every source is complete up to its
 * own `limit + 1`, the merged page is exact — no client-side scan, no
 * undercount. The cursor carries the timestamp at MICROSECOND precision (a JS
 * Date would truncate it and silently skip rows that share a millisecond) and
 * the row key `<source>:<uuid>`. Each source compares it as the row value
 * `(at, id) < (cursor.at, cursor.id)` so it can walk an `(at DESC, id DESC)`
 * index (migrations 0288, 0296 for automation runs; the session source's
 * live/settled `CASE` has none — it scans its smaller table); see `window` for
 * why that is the same order JS merges in.
 *
 * A SESSION's `at` is not fixed: it is its start while live and its close once
 * settled. A session that closes between two page reads moves ahead of the
 * cursor and can be listed again on a later page (or, from a later page's
 * point of view, not at all until a refresh). The cursor is stable for every
 * immutable timestamp; the client dedupes rows by `id`.
 *
 * Outcome filters are the INVERSE of the leaf's forward mappers, derived by
 * running each mapper over the column's own enum values — never a second,
 * hand-kept status table.
 *
 * ── VISIBILITY ──────────────────────────────────────────────────────────────
 *   proposals — `proposalUserFloor` (the floor `proposals.list` applies:
 *               member workspaces ∪ what I authored), with the NULL-workspace
 *               branch OWNER-gated: a personal proposal is visible only to the
 *               person it was filed for (`subject_user_id`) or its author.
 *               The access registry still reads a NULL-workspace proposal as
 *               pod-wide (flagged there, D7); a feed of everyone's acts must
 *               not.
 *   runs      — `scopedDb(access).predicate(...)` per table. A NULL-workspace
 *               playbook run is owner-gated the same way (its creator, or its
 *               creator's agent). Its session door is joined only when the
 *               viewer may read that session (decision D1).
 *   sessions  — `scopedDb(access).predicate(focusSessions)` — the one session
 *               read rule (`sessionReadableWhere`, roster for human doors).
 * The workspace lens rides on `access` (absent = the whole floor).
 *
 * ── TWO PROJECTIONS, ONE FILTER ─────────────────────────────────────────────
 * `activity.daily` (`dailyActivity`) counts the SAME rows per calendar day of
 * the viewer's time zone. Each source reader builds its FROM + joins + WHERE
 * once and projects it either as a page (`ORDER BY … LIMIT`) or as day counts
 * (`GROUP BY` the day) — never a second hand-kept visibility predicate. The
 * parity test (`list-activity.pglite.test.ts`) pins that a day's count equals
 * the rows `list` pages through for that day's `[since, until)`.
 */

import { TRPCError } from "@trpc/server";
import type { AnyColumn, SQL } from "drizzle-orm";
import {
  db,
  and,
  or,
  eq,
  ne,
  isNull,
  isNotNull,
  inArray,
  drizzleSql,
  automationRuns,
  automations,
  focusSessions,
  playbookRuns,
  playbooks,
  projects,
  proposals,
  users,
} from "@synap/database";
import {
  ACTIVITY_MAX_LIMIT,
  activityDayRange,
  activityWindow,
  isValidTimeZone,
  todayInTimeZone,
  activityOutcomeForProposal,
  activityOutcomeForRun,
  activityOutcomeForSession,
  resolveActivityVerb,
  type ActivityActor,
  type ActivityDaily,
  type ActivityDay,
  type ActivityOutcome,
  type ActivityPage,
  type ActivityRow,
  type ActivitySource,
  type ParsedActivityActorFilter,
} from "@synap-core/types/activity";
import { resolveSessionTitle } from "@synap-core/types/focus-sessions";
import {
  buildRequestFromProposal,
  type Proposal,
} from "@synap-core/types/proposals";
import { normalizeObjectKind } from "@synap-core/types/vocabulary";
import { scopedDb, type AccessContext } from "../../access/index.js";
import type { Lens } from "../../access/context.js";
import { sessionReadableWhere } from "../../access/session-visibility.js";
import { userVisibleWhere } from "../../utils/user-visible-where.js";
import {
  authoredByUser,
  ownAgentUserFilter,
} from "../agent-identity-service.js";
import { displayNameForUser } from "../../routers/proposals/helper-functions.js";
import { proposalPayloadTargetName } from "../../routers/proposals/display.js";
import { nameRedactedProposals } from "../object-graph/graph-service.js";
import { redactUnreadableSessionTargets } from "../proposals/session-content-redaction.js";
import { proposalChangeCountSql } from "../proposals/object-subject.js";
import { workAndTrackedRunsWhere } from "../focus-sessions/session-list-conditions.js";

export interface ActivityQuery {
  database?: typeof db;
  /** The caller, already narrowed to the workspace lens (`withLens`). */
  access: AccessContext;
  /** `undefined` = the whole floor · `null` = pod-personal · id = narrow. */
  workspaceLens: Lens;
  /** Honour the session roster branch (a HUMAN door: `rosterReadFor(ctx)`). */
  roster: boolean;
  actor: ParsedActivityActorFilter;
  projectId?: string;
  /** Only acts inside this track's sessions (automation runs never are). */
  trackId?: string;
  outcome?: ActivityOutcome;
  source?: ActivitySource;
  since?: string;
  /** Only acts strictly before this instant. */
  until?: string;
  cursor?: string;
  limit: number;
}

// ── Cursor ──────────────────────────────────────────────────────────────────

interface ActivityCursor {
  /** `YYYY-MM-DDTHH:MM:SS.ffffffZ` — microseconds, UTC. */
  at: string;
  key: string;
}

const EXACT_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
/** `<source prefix>:<uuid>` — every source's rows are keyed by a uuid id. */
const KEY_RE =
  /^(proposal|decision|run|session):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function encodeActivityCursor(c: ActivityCursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

function decodeActivityCursor(cursor: string): ActivityCursor {
  try {
    const v = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      v &&
      typeof v.at === "string" &&
      EXACT_AT_RE.test(v.at) &&
      typeof v.key === "string" &&
      KEY_RE.test(v.key)
    ) {
      return { at: v.at, key: v.key };
    }
  } catch {
    /* fall through */
  }
  throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid cursor" });
}

/** The ONE order, in JS: newest first, then the key, byte order (= COLLATE "C"). */
function newerFirst(a: ActivityCursor, b: ActivityCursor): number {
  if (a.at !== b.at) return a.at < b.at ? 1 : -1;
  if (a.key === b.key) return 0;
  return a.key < b.key ? 1 : -1;
}

// ── SQL helpers ─────────────────────────────────────────────────────────────

const exactAt = (at: SQL) =>
  drizzleSql<string>`to_char((${at}) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/**
 * `(at, key) < cursor` in the shared order, plus `[since, until)` — as a ROW-VALUE
 * comparison on `(at, id)` so each source can walk an `(at DESC, id DESC)`
 * index. Sound because a source's key is `<its constant prefix>:<uuid>`: at an
 * equal `at`, a key from ANOTHER source compares by prefix alone (all four
 * prefixes differ in their first letter), and within the SAME source by the
 * uuid, whose byte order equals its lowercase-hex text order. So the SQL
 * boundary here and the JS `newerFirst` merge agree row for row.
 */
function window(
  prefix: ActivitySource | "run",
  at: SQL,
  id: SQL | AnyColumn,
  p: Projection,
  q: Pick<ActivityQuery, "since" | "until">
): SQL[] {
  const out: SQL[] = [];
  const cursor = p.kind === "page" ? p.cursor : null;
  if (q.since) out.push(drizzleSql`(${at}) >= ${q.since}::timestamptz`);
  if (q.until) out.push(drizzleSql`(${at}) < ${q.until}::timestamptz`);
  if (cursor) {
    const cursorPrefix = cursor.key.slice(0, cursor.key.indexOf(":"));
    if (prefix === cursorPrefix) {
      const cursorId = cursor.key.slice(cursorPrefix.length + 1);
      out.push(
        drizzleSql`((${at}), ${id}) < (${cursor.at}::timestamptz, ${cursorId}::uuid)`
      );
    } else if (`${prefix}:` < `${cursorPrefix}:`) {
      // Every row of this source at the cursor's instant sorts after it.
      out.push(drizzleSql`(${at}) <= ${cursor.at}::timestamptz`);
    } else {
      out.push(drizzleSql`(${at}) < ${cursor.at}::timestamptz`);
    }
  }
  return out;
}

/**
 * What a source read projects: one page of candidates past the cursor, or a
 * count per calendar day of `tz`. Same FROM, joins and WHERE either way.
 */
type Projection =
  | { kind: "page"; cursor: ActivityCursor | null; take: number }
  | { kind: "daily"; tz: string };
type Projected<P extends Projection> = P extends { kind: "daily" }
  ? ActivityDay[]
  : Candidate[];

/**
 * The day projection: `GROUP BY 1` (the day), not the expression — the time
 * zone is a bound parameter, and `$1` in the SELECT and `$2` in the GROUP BY
 * would be two different expressions to Postgres.
 */
const dayFields = (at: SQL, tz: string) => ({
  date: drizzleSql<string>`to_char((${at}) at time zone ${tz}, 'YYYY-MM-DD')`,
  count: drizzleSql<number>`count(*)::int`,
});
const byDay = drizzleSql`1`;
const asDays = (rows: Array<{ date: string; count: number }>): ActivityDay[] =>
  rows.map((r) => ({ date: r.date, count: Number(r.count) }));

const order = (at: SQL, id: SQL | AnyColumn) => [
  drizzleSql`(${at}) desc`,
  drizzleSql`${id} desc`,
];

/**
 * The actor filter over an actor-id expression and an is-agent expression.
 * `null` = this source can never match (skip the read).
 */
function actorWhere(
  filter: ParsedActivityActorFilter,
  viewer: string,
  actorId: SQL,
  isAgent: SQL
): SQL | undefined | null {
  switch (filter.kind) {
    case "all":
      return undefined;
    case "agents":
      return drizzleSql`coalesce(${isAgent}, false)`;
    case "me":
      return drizzleSql`(not coalesce(${isAgent}, false) and ${actorId} = ${viewer})`;
    case "agent":
      return drizzleSql`(coalesce(${isAgent}, false) and ${actorId} = ${filter.agentUserId})`;
  }
}

/**
 * The column values whose outcome is `outcome` — the leaf's forward mapper
 * run over the column's own enum. `null` = no filter; `[]` = cannot match.
 */
function statusesFor(
  values: readonly string[],
  map: (status: string) => ActivityOutcome,
  outcome: ActivityOutcome | undefined
): string[] | null {
  if (!outcome) return null;
  return values.filter((v) => map(v) === outcome);
}

// ── Candidates (one per source row, before enrichment) ─────────────────────

interface Candidate extends ActivityCursor {
  source: ActivitySource;
  id: string;
  status: string;
  actorId: string | null;
  actorIsAgent: boolean;
  projectId: string | null;
  sessionId: string | null;
  // proposal / decision
  proposalType?: string;
  changeCount?: number;
  // run
  flowType?: "automation" | "playbook";
  flowId?: string;
  flowName?: string | null;
  error?: string | null;
  // session
  sessionTitle?: string;
  origin?: string | null;
}

/** The decisions a PERSON makes on a proposal (the `reviewed_by` stamp). */
const DECISION_STATUSES = [
  "approved",
  "rejected",
  "reverted",
  "approval_failed",
] as const;

const LIVE_SESSION_STATUSES = ["active", "paused", "forming"] as const;

/** A proposal filed into one of this track's sessions. */
const proposalInTrack = (trackId: string) =>
  drizzleSql`exists (select 1 from ${focusSessions} where ${focusSessions.id} = ${proposals.sessionId} and ${focusSessions.trackId} = ${trackId})`;

/**
 * STRICTER than `proposalUserFloor` (routers/proposals/scope-conditions.ts):
 * a NULL-workspace proposal is visible only to its subject or author, never
 * pod-wide — a feed of everyone's acts must not read personal rows.
 */
function proposalFloor(viewer: string, lens: Lens): SQL {
  const floor = or(
    and(
      isNotNull(proposals.workspaceId),
      userVisibleWhere(proposals.workspaceId, viewer)
    ),
    authoredByUser(viewer),
    eq(proposals.subjectUserId, viewer)
  )!;
  if (lens === undefined) return floor;
  if (lens === null) return and(floor, isNull(proposals.workspaceId))!;
  const ids = Array.isArray(lens) ? lens : [lens];
  return and(floor, inArray(proposals.workspaceId, ids))!;
}

async function readProposalActs<P extends Projection>(
  database: typeof db,
  q: ActivityQuery,
  p: P
): Promise<Projected<P>> {
  const none = [] as unknown as Projected<P>;
  const viewer = q.access.userId;
  const statuses = statusesFor(
    proposals.status.enumValues,
    activityOutcomeForProposal,
    q.outcome
  );
  if (statuses && statuses.length === 0) return none;
  const actorId = drizzleSql<
    string | null
  >`coalesce(${proposals.agentUserId}, ${proposals.proposedByUserId}, ${proposals.createdBy})`;
  const isAgent = drizzleSql<boolean>`(${proposals.agentUserId} is not null or ${users.userType} = 'agent')`;
  const actor = actorWhere(q.actor, viewer, actorId, isAgent);
  if (actor === null) return none;
  const at = drizzleSql`${proposals.createdAt}`;
  const where = and(
    proposalFloor(viewer, q.workspaceLens),
    // The session source carries a session's lifecycle once.
    drizzleSql`not (${proposals.targetType} = 'focus_session' and ${proposals.status} = 'auto_approved')`,
    q.projectId ? eq(proposals.projectId, q.projectId) : undefined,
    q.trackId ? proposalInTrack(q.trackId) : undefined,
    statuses ? inArray(proposals.status, statuses as never[]) : undefined,
    actor,
    ...window("proposal", at, proposals.id, p, q)
  );
  if (p.kind === "daily") {
    // Same FROM, joins and WHERE as the page read below.
    const days = await database
      .select(dayFields(at, p.tz))
      .from(proposals)
      .leftJoin(users, drizzleSql`${users.id} = ${actorId}`)
      .where(where)
      .groupBy(byDay);
    return asDays(days) as Projected<P>;
  }
  const rows = await database
    .select({
      id: proposals.id,
      at: exactAt(at),
      status: proposals.status,
      proposalType: proposals.proposalType,
      actorId,
      isAgent,
      projectId: proposals.projectId,
      sessionId: proposals.sessionId,
      changeCount: proposalChangeCountSql(),
    })
    .from(proposals)
    .leftJoin(users, drizzleSql`${users.id} = ${actorId}`)
    .where(where)
    .orderBy(...order(at, proposals.id))
    .limit(p.take);
  const out: Candidate[] = rows.map((r) => ({
    source: "proposal" as const,
    id: r.id,
    at: r.at,
    key: `proposal:${r.id}`,
    status: r.status,
    proposalType: r.proposalType,
    actorId: r.actorId,
    actorIsAgent: Boolean(r.isAgent),
    projectId: r.projectId,
    sessionId: r.sessionId,
    changeCount: Number(r.changeCount),
  }));
  return out as Projected<P>;
}

async function readDecisions<P extends Projection>(
  database: typeof db,
  q: ActivityQuery,
  p: P
): Promise<Projected<P>> {
  const none = [] as unknown as Projected<P>;
  const viewer = q.access.userId;
  const statuses = statusesFor(
    DECISION_STATUSES,
    activityOutcomeForProposal,
    q.outcome
  ) ?? [...DECISION_STATUSES];
  if (statuses.length === 0) return none;
  const actorId = drizzleSql<string>`${proposals.reviewedBy}`;
  const isAgent = drizzleSql<boolean>`(${users.userType} = 'agent')`;
  const actor = actorWhere(q.actor, viewer, actorId, isAgent);
  if (actor === null) return none;
  const at = drizzleSql`${proposals.reviewedAt}`;
  const where = and(
    proposalFloor(viewer, q.workspaceLens),
    isNotNull(proposals.reviewedBy),
    isNotNull(proposals.reviewedAt),
    inArray(proposals.status, statuses as never[]),
    q.projectId ? eq(proposals.projectId, q.projectId) : undefined,
    q.trackId ? proposalInTrack(q.trackId) : undefined,
    actor,
    ...window("decision", at, proposals.id, p, q)
  );
  if (p.kind === "daily") {
    // Same FROM, joins and WHERE as the page read below.
    const days = await database
      .select(dayFields(at, p.tz))
      .from(proposals)
      .leftJoin(users, eq(users.id, proposals.reviewedBy))
      .where(where)
      .groupBy(byDay);
    return asDays(days) as Projected<P>;
  }
  const rows = await database
    .select({
      id: proposals.id,
      at: exactAt(at),
      status: proposals.status,
      proposalType: proposals.proposalType,
      actorId: proposals.reviewedBy,
      isAgent,
      projectId: proposals.projectId,
      sessionId: proposals.sessionId,
      changeCount: proposalChangeCountSql(),
    })
    .from(proposals)
    .leftJoin(users, eq(users.id, proposals.reviewedBy))
    .where(where)
    .orderBy(...order(at, proposals.id))
    .limit(p.take);
  const out: Candidate[] = rows.map((r) => ({
    source: "decision" as const,
    id: r.id,
    at: r.at,
    key: `decision:${r.id}`,
    status: r.status,
    proposalType: r.proposalType,
    actorId: r.actorId,
    actorIsAgent: Boolean(r.isAgent),
    projectId: r.projectId,
    sessionId: r.sessionId,
    changeCount: Number(r.changeCount),
  }));
  return out as Projected<P>;
}

async function readAutomationRuns<P extends Projection>(
  database: typeof db,
  q: ActivityQuery,
  p: P
): Promise<Projected<P>> {
  const none = [] as unknown as Projected<P>;
  // A rule acts on its own: it is never "an agent" or "me", and it has no
  // project to be filed under.
  if (q.actor.kind !== "all" || q.projectId || q.trackId) return none;
  const statuses = statusesFor(
    automationRuns.status.enumValues,
    activityOutcomeForRun,
    q.outcome
  );
  if (statuses && statuses.length === 0) return none;
  const at = drizzleSql`coalesce(${automationRuns.completedAt}, ${automationRuns.startedAt})`;
  const where = and(
    scopedDb(q.access).predicate(automationRuns),
    statuses ? inArray(automationRuns.status, statuses as never[]) : undefined,
    ...window("run", at, automationRuns.id, p, q)
  );
  if (p.kind === "daily") {
    // Same FROM, joins and WHERE as the page read below.
    const days = await database
      .select(dayFields(at, p.tz))
      .from(automationRuns)
      .innerJoin(automations, eq(automations.id, automationRuns.automationId))
      .where(where)
      .groupBy(byDay);
    return asDays(days) as Projected<P>;
  }
  const rows = await database
    .select({
      id: automationRuns.id,
      at: exactAt(at),
      status: automationRuns.status,
      flowId: automationRuns.automationId,
      flowName: automations.name,
      error: automationRuns.errorMessage,
    })
    .from(automationRuns)
    .innerJoin(automations, eq(automations.id, automationRuns.automationId))
    .where(where)
    .orderBy(...order(at, automationRuns.id))
    .limit(p.take);
  const out: Candidate[] = rows.map((r) => ({
    source: "run" as const,
    id: r.id,
    at: r.at,
    key: `run:${r.id}`,
    status: r.status,
    actorId: null,
    actorIsAgent: false,
    projectId: null,
    sessionId: null,
    flowType: "automation" as const,
    flowId: r.flowId,
    flowName: r.flowName,
    error: r.error ?? null,
  }));
  return out as Projected<P>;
}

/**
 * The playbook runs the viewer may see — ONE predicate for the run source and
 * for the session source's "a run already carries this session" exclusion,
 * so a session is dropped only for a run row the viewer is actually shown.
 */
function playbookRunVisible(q: ActivityQuery): SQL {
  const viewer = q.access.userId;
  return and(
    scopedDb(q.access).predicate(playbookRuns),
    // A personal run is its creator's (or their agent's) — never pod-wide.
    or(
      isNotNull(playbookRuns.workspaceId),
      eq(playbookRuns.createdBy, viewer),
      ownAgentUserFilter(playbookRuns.createdBy, viewer)
    )
  )!;
}

async function readPlaybookRuns<P extends Projection>(
  database: typeof db,
  q: ActivityQuery,
  p: P
): Promise<Projected<P>> {
  const none = [] as unknown as Projected<P>;
  const viewer = q.access.userId;
  const statuses = statusesFor(
    playbookRuns.status.enumValues,
    activityOutcomeForRun,
    q.outcome
  );
  if (statuses && statuses.length === 0) return none;
  const actorId = drizzleSql<string>`${playbookRuns.createdBy}`;
  const isAgent = drizzleSql<boolean>`(${users.userType} = 'agent')`;
  const actor = actorWhere(q.actor, viewer, actorId, isAgent);
  if (actor === null) return none;
  const at = drizzleSql`coalesce(${playbookRuns.completedAt}, ${playbookRuns.startedAt})`;
  const where = and(
    playbookRunVisible(q),
    q.projectId ? eq(focusSessions.projectId, q.projectId) : undefined,
    q.trackId ? eq(focusSessions.trackId, q.trackId) : undefined,
    statuses ? inArray(playbookRuns.status, statuses as never[]) : undefined,
    actor,
    ...window("run", at, playbookRuns.id, p, q)
  );
  if (p.kind === "daily") {
    // Same FROM, joins and WHERE as the page read below.
    const days = await database
      .select(dayFields(at, p.tz))
      .from(playbookRuns)
      .innerJoin(playbooks, eq(playbooks.id, playbookRuns.playbookId))
      .leftJoin(users, eq(users.id, playbookRuns.createdBy))
      .leftJoin(
        focusSessions,
        and(
          eq(focusSessions.id, playbookRuns.sessionId),
          sessionReadableWhere({ userId: viewer, roster: q.roster })
        )
      )
      .where(where)
      .groupBy(byDay);
    return asDays(days) as Projected<P>;
  }
  const rows = await database
    .select({
      id: playbookRuns.id,
      at: exactAt(at),
      status: playbookRuns.status,
      flowId: playbookRuns.playbookId,
      flowName: playbooks.name,
      error: playbookRuns.error,
      actorId: playbookRuns.createdBy,
      isAgent,
      // NULL unless the viewer may read the run's session (decision D1).
      sessionId: focusSessions.id,
      projectId: focusSessions.projectId,
    })
    .from(playbookRuns)
    .innerJoin(playbooks, eq(playbooks.id, playbookRuns.playbookId))
    .leftJoin(users, eq(users.id, playbookRuns.createdBy))
    .leftJoin(
      focusSessions,
      and(
        eq(focusSessions.id, playbookRuns.sessionId),
        sessionReadableWhere({ userId: viewer, roster: q.roster })
      )
    )
    .where(where)
    .orderBy(...order(at, playbookRuns.id))
    .limit(p.take);
  const out: Candidate[] = rows.map((r) => ({
    source: "run" as const,
    id: r.id,
    at: r.at,
    key: `run:${r.id}`,
    status: r.status,
    actorId: r.actorId,
    actorIsAgent: Boolean(r.isAgent),
    projectId: r.projectId ?? null,
    sessionId: r.sessionId ?? null,
    flowType: "playbook" as const,
    flowId: r.flowId,
    flowName: r.flowName,
    error: r.error ?? null,
  }));
  return out as Projected<P>;
}

async function readSessions<P extends Projection>(
  database: typeof db,
  q: ActivityQuery,
  p: P
): Promise<Projected<P>> {
  const none = [] as unknown as Projected<P>;
  const viewer = q.access.userId;
  const values = focusSessions.status.enumValues.filter(
    (s) => s !== "scheduled"
  );
  const statuses = statusesFor(values, activityOutcomeForSession, q.outcome);
  if (statuses && statuses.length === 0) return none;
  const agentId = drizzleSql<
    string | null
  >`(${focusSessions.metadata}->>'agentUserId')`;
  const isAgent = drizzleSql<boolean>`(${agentId} is not null or ${focusSessions.origin} = 'agent')`;
  const actorId = drizzleSql<string>`coalesce(${agentId}, ${focusSessions.userId})`;
  const actor = actorWhere(q.actor, viewer, actorId, isAgent);
  if (actor === null) return none;
  const live = drizzleSql`${focusSessions.status} in ('active', 'paused', 'forming')`;
  const at = drizzleSql`case when ${live} then coalesce(${focusSessions.startedAt}, ${focusSessions.createdAt}) else coalesce(${focusSessions.closedAt}, ${focusSessions.updatedAt}) end`;
  const where = and(
    scopedDb(q.access).predicate(focusSessions),
    // The work population the runs feed's session flow reads.
    // The project path's population: work, plus run sessions filed in a
    // track (a track's stage sessions). A session carried by a playbook
    // run the viewer SEES is left to that run, so nothing is listed
    // twice — and a run hidden from the viewer hides nothing.
    workAndTrackedRunsWhere(),
    ne(focusSessions.status, "scheduled"),
    drizzleSql`not exists (select 1 from ${playbookRuns} where ${playbookRuns.sessionId} = ${focusSessions.id} and ${playbookRunVisible(q)})`,
    q.projectId ? eq(focusSessions.projectId, q.projectId) : undefined,
    q.trackId ? eq(focusSessions.trackId, q.trackId) : undefined,
    statuses ? inArray(focusSessions.status, statuses as never[]) : undefined,
    actor,
    ...window("session", at, focusSessions.id, p, q)
  );
  if (p.kind === "daily") {
    // Same FROM, joins and WHERE as the page read below.
    const days = await database
      .select(dayFields(at, p.tz))
      .from(focusSessions)
      .where(where)
      .groupBy(byDay);
    return asDays(days) as Projected<P>;
  }
  const rows = await database
    .select({
      id: focusSessions.id,
      at: exactAt(at),
      status: focusSessions.status,
      title: focusSessions.title,
      goal: focusSessions.goal,
      origin: focusSessions.origin,
      agentId,
      ownerId: focusSessions.userId,
      isAgent,
      projectId: focusSessions.projectId,
    })
    .from(focusSessions)
    .where(where)
    .orderBy(...order(at, focusSessions.id))
    .limit(p.take);
  const out: Candidate[] = rows.map((r) => ({
    source: "session" as const,
    id: r.id,
    at: r.at,
    key: `session:${r.id}`,
    status: r.status,
    actorId: r.agentId ?? (r.isAgent ? null : r.ownerId),
    actorIsAgent: Boolean(r.isAgent),
    projectId: r.projectId ?? null,
    sessionId: r.id,
    sessionTitle: resolveSessionTitle(r) || "Session",
    origin: r.origin ?? null,
  }));
  return out as Projected<P>;
}

// ── The door ────────────────────────────────────────────────────────────────

/**
 * One page of the ledger. The cursor pages an ordering, not a snapshot: a
 * session whose timestamp changes (started → closed) moves in that ordering
 * and may appear on two pages — clients dedupe by row `id`.
 */
export async function listActivity(q: ActivityQuery): Promise<ActivityPage> {
  const database = q.database ?? db;
  const limit = Math.max(1, Math.min(q.limit, ACTIVITY_MAX_LIMIT));
  const cursor = q.cursor ? decodeActivityCursor(q.cursor) : null;
  assertInstants(q);
  await assertProjectReadable(database, q);

  const p: Projection = { kind: "page", cursor, take: limit + 1 };
  const wants = (s: ActivitySource) => !q.source || q.source === s;
  const reads = await Promise.all([
    wants("proposal") ? readProposalActs(database, q, p) : [],
    wants("decision") ? readDecisions(database, q, p) : [],
    wants("run") ? readAutomationRuns(database, q, p) : [],
    wants("run") ? readPlaybookRuns(database, q, p) : [],
    wants("session") ? readSessions(database, q, p) : [],
  ]);
  const merged = reads.flat().sort(newerFirst);
  const page = merged.slice(0, limit);
  const last = page[page.length - 1];
  const items = await enrich(database, q, page);
  return {
    items,
    nextCursor:
      merged.length > limit && last
        ? encodeActivityCursor({ at: last.at, key: last.key })
        : null,
  };
}

function assertInstants(q: Pick<ActivityQuery, "since" | "until">): void {
  if (q.since && Number.isNaN(Date.parse(q.since))) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid since" });
  }
  if (q.until && Number.isNaN(Date.parse(q.until))) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid until" });
  }
}

async function assertProjectReadable(
  database: typeof db,
  q: ActivityQuery
): Promise<void> {
  if (q.projectId) {
    const [project] = await database
      .select({ id: projects.id })
      .from(projects)
      .where(
        and(
          eq(projects.id, q.projectId),
          scopedDb(q.access.withLens(undefined)).predicate(projects)
        )
      )
      .limit(1);
    if (!project) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Project not found" });
    }
  }
}

/**
 * How many acts per calendar day — `activity.daily`. The SAME five reads as
 * `listActivity`, projected as day counts in the viewer's `tz` over the
 * `days` calendar days ending today there. The window's bounds are the
 * instants `activityDayRange` gives the first and last day, so a cell's count
 * and the list its click opens (`since`/`until` of that day) cover the same
 * rows. Sparse: a day with no act is absent.
 */
export async function dailyActivity(
  q: Omit<ActivityQuery, "cursor" | "limit" | "since" | "until" | "outcome"> & {
    tz: string;
    days: number;
    now?: Date;
  }
): Promise<ActivityDaily> {
  const database = q.database ?? db;
  if (!isValidTimeZone(q.tz)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid tz" });
  }
  const win = activityWindow(todayInTimeZone(q.tz, q.now), q.days);
  const query: ActivityQuery = {
    ...q,
    since: activityDayRange(win.from, q.tz).since,
    until: activityDayRange(win.to, q.tz).until,
    limit: 0,
  };
  await assertProjectReadable(database, query);

  const p: Projection = { kind: "daily", tz: q.tz };
  const wants = (s: ActivitySource) => !q.source || q.source === s;
  const reads = await Promise.all([
    wants("proposal") ? readProposalActs(database, query, p) : [],
    wants("decision") ? readDecisions(database, query, p) : [],
    wants("run") ? readAutomationRuns(database, query, p) : [],
    wants("run") ? readPlaybookRuns(database, query, p) : [],
    wants("session") ? readSessions(database, query, p) : [],
  ]);
  const byDate = new Map<string, number>();
  for (const d of reads.flat()) {
    byDate.set(d.date, (byDate.get(d.date) ?? 0) + d.count);
  }
  return {
    from: win.from,
    to: win.to,
    tz: q.tz,
    days: [...byDate.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([date, count]) => ({ date, count })),
  };
}

// ── Enrichment (names, titles, doors) — a fixed number of reads per page ────

async function enrich(
  database: typeof db,
  q: ActivityQuery,
  page: Candidate[]
): Promise<ActivityRow[]> {
  const viewer = q.access.userId;
  const uniq = (xs: Array<string | null | undefined>) => [
    ...new Set(xs.filter((x): x is string => Boolean(x))),
  ];
  const proposalIds = uniq(
    page
      .filter((c) => c.source === "proposal" || c.source === "decision")
      .map((c) => c.id)
  );
  const userIds = uniq(page.map((c) => c.actorId));
  const projectIds = uniq(page.map((c) => c.projectId));
  const sessionIds = uniq(
    page.filter((c) => c.source !== "session").map((c) => c.sessionId)
  );

  const [proposalRows, userRows, projectRows, sessionRows] = await Promise.all([
    proposalIds.length
      ? database
          .select({
            id: proposals.id,
            proposalType: proposals.proposalType,
            targetType: proposals.targetType,
            targetId: proposals.targetId,
            data: proposals.data,
            workspaceId: proposals.workspaceId,
          })
          .from(proposals)
          .where(inArray(proposals.id, proposalIds))
      : Promise.resolve([]),
    userIds.length
      ? database
          .select({
            id: users.id,
            name: users.name,
            email: users.email,
            userType: users.userType,
            agentMetadata: users.agentMetadata,
          })
          .from(users)
          .where(inArray(users.id, userIds))
      : Promise.resolve([]),
    projectIds.length
      ? database
          .select({ id: projects.id, name: projects.name })
          .from(projects)
          .where(
            and(
              inArray(projects.id, projectIds),
              scopedDb(q.access.withLens(undefined)).predicate(projects)
            )
          )
      : Promise.resolve([]),
    sessionIds.length
      ? database
          .select({
            id: focusSessions.id,
            title: focusSessions.title,
            goal: focusSessions.goal,
          })
          .from(focusSessions)
          .where(
            and(
              inArray(focusSessions.id, sessionIds),
              sessionReadableWhere({ userId: viewer, roster: q.roster })
            )
          )
      : Promise.resolve([]),
  ]);

  // Redact ONCE, and read every proposal field below — the headline AND the
  // object door — from these rows only. A row naming a session the viewer
  // cannot read comes back as a new object; the untouched ones are the same.
  const readable = proposalRows.length
    ? await redactUnreadableSessionTargets(proposalRows, {
        userId: viewer,
        roster: q.roster,
      })
    : proposalRows;
  const redacted = new Set(
    readable.filter((r, i) => r !== proposalRows[i]).map((r) => r.id)
  );
  const titles = nameRedactedProposals(readable);
  const proposalById = new Map(readable.map((p) => [p.id, p]));
  const userById = new Map(userRows.map((u) => [u.id, u]));
  const projectById = new Map(projectRows.map((p) => [p.id, p]));
  const sessionById = new Map(
    sessionRows.map((s) => [s.id, resolveSessionTitle(s) || "Session"])
  );

  const actorOf = (c: Candidate): ActivityActor => {
    const u = c.actorId ? userById.get(c.actorId) : undefined;
    const name = u ? (displayNameForUser(u as never) ?? null) : null;
    if (c.actorIsAgent || u?.userType === "agent") {
      return { kind: "agent", id: c.actorId, name };
    }
    if (!c.actorId) return { kind: "system", id: null, name: null };
    return {
      kind: "human",
      id: c.actorId,
      name,
      isViewer: c.actorId === viewer,
    };
  };

  return page.map((c): ActivityRow => {
    const project = c.projectId
      ? { id: c.projectId, name: projectById.get(c.projectId)?.name ?? null }
      : null;
    const base = {
      id: c.key,
      source: c.source,
      occurredAt: new Date(c.at).toISOString(),
      project,
      error: null as string | null,
    };

    if (c.source === "proposal" || c.source === "decision") {
      const p = proposalById.get(c.id);
      const outcome = activityOutcomeForProposal(c.status);
      const title = titles.get(c.id) ?? "Proposal";
      const session =
        c.sessionId && sessionById.has(c.sessionId)
          ? { id: c.sessionId, title: sessionById.get(c.sessionId)! }
          : null;
      const undo = (reachable: boolean) =>
        reachable
          ? { proposalId: c.id, changeCount: c.changeCount ?? null }
          : null;
      if (c.source === "decision") {
        const action =
          c.status === "rejected"
            ? "reject"
            : c.status === "reverted"
              ? "revert"
              : "approve";
        return {
          ...base,
          actor: actorOf(c),
          action,
          verb: resolveActivityVerb(action),
          title,
          object: { kind: "proposal", id: c.id, name: title },
          proposalId: c.id,
          session,
          outcome,
          // A person approved it: Undo lives on THIS row.
          undo: undo(c.status === "approved"),
        };
      }
      const data = (p?.data ?? null) as Record<string, unknown> | null;
      const composite = Array.isArray(
        (data as { operations?: unknown } | null)?.operations
      );
      const action = c.proposalType ?? "update";
      // An applied, non-composite, non-removing act opens what it made;
      // everything else opens the proposal (its object may not exist). A
      // redacted row opens the proposal too: its target is a session the
      // viewer cannot read.
      const opensTarget =
        p &&
        !redacted.has(c.id) &&
        outcome === "succeeded" &&
        !composite &&
        !/(^|\.)(delete|archive|remove)$/.test(action);
      const request = p
        ? buildRequestFromProposal(p as unknown as Proposal)
        : null;
      const slug =
        (data?.profileSlug as string | undefined) ??
        (typeof data?.type === "string" ? (data.type as string) : undefined);
      const object = opensTarget
        ? {
            kind: normalizeObjectKind(p.targetType),
            id: p.targetId,
            name: (request && proposalPayloadTargetName(request)) ?? null,
            profileSlug: slug ?? null,
          }
        : { kind: "proposal", id: c.id, name: title };
      return {
        ...base,
        actor: actorOf(c),
        action,
        verb: resolveActivityVerb(action),
        title,
        object,
        proposalId: c.id,
        session,
        outcome,
        // A rule approved it: no decision row exists, Undo lives here.
        undo: undo(c.status === "auto_approved"),
      };
    }

    if (c.source === "run") {
      const flowName =
        c.flowName ?? (c.flowType === "automation" ? "Automation" : "Playbook");
      const actor: ActivityActor =
        c.flowType === "automation"
          ? { kind: "system", id: c.flowId ?? null, name: c.flowName ?? null }
          : actorOf(c);
      return {
        ...base,
        actor,
        action: "run",
        verb: resolveActivityVerb("run"),
        title: flowName,
        object: {
          kind: "run",
          id: c.id,
          name: flowName,
          flowType: c.flowType,
        },
        proposalId: null,
        session:
          c.sessionId && sessionById.has(c.sessionId)
            ? { id: c.sessionId, title: sessionById.get(c.sessionId)! }
            : null,
        outcome: activityOutcomeForRun(c.status),
        undo: null,
        error: c.error ?? null,
      };
    }

    // session
    const live = (LIVE_SESSION_STATUSES as readonly string[]).includes(
      c.status
    );
    const action = live ? "start" : "close";
    const title = c.sessionTitle ?? "Session";
    return {
      ...base,
      actor: actorOf(c),
      action,
      verb: resolveActivityVerb(action),
      title,
      object: { kind: "session", id: c.id, name: title },
      proposalId: null,
      session: { id: c.id, title },
      outcome: activityOutcomeForSession(c.status),
      undo: null,
    };
  });
}
