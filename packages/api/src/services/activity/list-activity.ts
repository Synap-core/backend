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
 * the row key compared under `COLLATE "C"` — the same byte order JS sorts by.
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
 */

import { TRPCError } from "@trpc/server";
import type { SQL } from "drizzle-orm";
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
  activityOutcomeForProposal,
  activityOutcomeForRun,
  activityOutcomeForSession,
  resolveActivityVerb,
  type ActivityActor,
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
import { proposalNeighborNames } from "../object-graph/graph-service.js";
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
      v.key.length > 0 &&
      v.key.length <= 200
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

const keyOf = (prefix: string, id: unknown) =>
  drizzleSql<string>`(${prefix} || ':' || (${id})::text)`;

/** `(at, key) < cursor` in the shared order, plus `since`. */
function window(
  at: SQL,
  key: SQL,
  cursor: ActivityCursor | null,
  since: string | undefined
): SQL[] {
  const out: SQL[] = [];
  if (since) out.push(drizzleSql`(${at}) >= ${since}::timestamptz`);
  if (cursor) {
    out.push(
      drizzleSql`((${at}) < ${cursor.at}::timestamptz or ((${at}) = ${cursor.at}::timestamptz and ${key} collate "C" < ${cursor.key}))`
    );
  }
  return out;
}

const order = (at: SQL, key: SQL) => [
  drizzleSql`(${at}) desc`,
  drizzleSql`${key} collate "C" desc`,
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

async function readProposalActs(
  database: typeof db,
  q: ActivityQuery,
  cursor: ActivityCursor | null,
  take: number
): Promise<Candidate[]> {
  const viewer = q.access.userId;
  const statuses = statusesFor(
    proposals.status.enumValues,
    activityOutcomeForProposal,
    q.outcome
  );
  if (statuses && statuses.length === 0) return [];
  const actorId = drizzleSql<
    string | null
  >`coalesce(${proposals.agentUserId}, ${proposals.proposedByUserId}, ${proposals.createdBy})`;
  const isAgent = drizzleSql<boolean>`(${proposals.agentUserId} is not null or ${users.userType} = 'agent')`;
  const actor = actorWhere(q.actor, viewer, actorId, isAgent);
  if (actor === null) return [];
  const at = drizzleSql`${proposals.createdAt}`;
  const key = keyOf("proposal", proposals.id);
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
    .where(
      and(
        proposalFloor(viewer, q.workspaceLens),
        // The session source carries a session's lifecycle once.
        drizzleSql`not (${proposals.targetType} = 'focus_session' and ${proposals.status} = 'auto_approved')`,
        q.projectId ? eq(proposals.projectId, q.projectId) : undefined,
        q.trackId ? proposalInTrack(q.trackId) : undefined,
        statuses ? inArray(proposals.status, statuses as never[]) : undefined,
        actor,
        ...window(at, key, cursor, q.since)
      )
    )
    .orderBy(...order(at, key))
    .limit(take);
  return rows.map((r) => ({
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
}

async function readDecisions(
  database: typeof db,
  q: ActivityQuery,
  cursor: ActivityCursor | null,
  take: number
): Promise<Candidate[]> {
  const viewer = q.access.userId;
  const statuses = statusesFor(
    DECISION_STATUSES,
    activityOutcomeForProposal,
    q.outcome
  ) ?? [...DECISION_STATUSES];
  if (statuses.length === 0) return [];
  const actorId = drizzleSql<string>`${proposals.reviewedBy}`;
  const isAgent = drizzleSql<boolean>`(${users.userType} = 'agent')`;
  const actor = actorWhere(q.actor, viewer, actorId, isAgent);
  if (actor === null) return [];
  const at = drizzleSql`${proposals.reviewedAt}`;
  const key = keyOf("decision", proposals.id);
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
    .where(
      and(
        proposalFloor(viewer, q.workspaceLens),
        isNotNull(proposals.reviewedBy),
        isNotNull(proposals.reviewedAt),
        inArray(proposals.status, statuses as never[]),
        q.projectId ? eq(proposals.projectId, q.projectId) : undefined,
        q.trackId ? proposalInTrack(q.trackId) : undefined,
        actor,
        ...window(at, key, cursor, q.since)
      )
    )
    .orderBy(...order(at, key))
    .limit(take);
  return rows.map((r) => ({
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
}

async function readAutomationRuns(
  database: typeof db,
  q: ActivityQuery,
  cursor: ActivityCursor | null,
  take: number
): Promise<Candidate[]> {
  // A rule acts on its own: it is never "an agent" or "me", and it has no
  // project to be filed under.
  if (q.actor.kind !== "all" || q.projectId || q.trackId) return [];
  const statuses = statusesFor(
    automationRuns.status.enumValues,
    activityOutcomeForRun,
    q.outcome
  );
  if (statuses && statuses.length === 0) return [];
  const at = drizzleSql`coalesce(${automationRuns.completedAt}, ${automationRuns.startedAt})`;
  const key = keyOf("run", automationRuns.id);
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
    .where(
      and(
        scopedDb(q.access).predicate(automationRuns),
        statuses
          ? inArray(automationRuns.status, statuses as never[])
          : undefined,
        ...window(at, key, cursor, q.since)
      )
    )
    .orderBy(...order(at, key))
    .limit(take);
  return rows.map((r) => ({
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
}

async function readPlaybookRuns(
  database: typeof db,
  q: ActivityQuery,
  cursor: ActivityCursor | null,
  take: number
): Promise<Candidate[]> {
  const viewer = q.access.userId;
  const statuses = statusesFor(
    playbookRuns.status.enumValues,
    activityOutcomeForRun,
    q.outcome
  );
  if (statuses && statuses.length === 0) return [];
  const actorId = drizzleSql<string>`${playbookRuns.createdBy}`;
  const isAgent = drizzleSql<boolean>`(${users.userType} = 'agent')`;
  const actor = actorWhere(q.actor, viewer, actorId, isAgent);
  if (actor === null) return [];
  const at = drizzleSql`coalesce(${playbookRuns.completedAt}, ${playbookRuns.startedAt})`;
  const key = keyOf("run", playbookRuns.id);
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
    .where(
      and(
        scopedDb(q.access).predicate(playbookRuns),
        // A personal run is its creator's (or their agent's) — never pod-wide.
        or(
          isNotNull(playbookRuns.workspaceId),
          eq(playbookRuns.createdBy, viewer),
          ownAgentUserFilter(playbookRuns.createdBy, viewer)
        ),
        q.projectId ? eq(focusSessions.projectId, q.projectId) : undefined,
        q.trackId ? eq(focusSessions.trackId, q.trackId) : undefined,
        statuses
          ? inArray(playbookRuns.status, statuses as never[])
          : undefined,
        actor,
        ...window(at, key, cursor, q.since)
      )
    )
    .orderBy(...order(at, key))
    .limit(take);
  return rows.map((r) => ({
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
}

async function readSessions(
  database: typeof db,
  q: ActivityQuery,
  cursor: ActivityCursor | null,
  take: number
): Promise<Candidate[]> {
  const viewer = q.access.userId;
  const values = focusSessions.status.enumValues.filter(
    (s) => s !== "scheduled"
  );
  const statuses = statusesFor(values, activityOutcomeForSession, q.outcome);
  if (statuses && statuses.length === 0) return [];
  const agentId = drizzleSql<
    string | null
  >`(${focusSessions.metadata}->>'agentUserId')`;
  const isAgent = drizzleSql<boolean>`(${agentId} is not null or ${focusSessions.origin} = 'agent')`;
  const actorId = drizzleSql<string>`coalesce(${agentId}, ${focusSessions.userId})`;
  const actor = actorWhere(q.actor, viewer, actorId, isAgent);
  if (actor === null) return [];
  const live = drizzleSql`${focusSessions.status} in ('active', 'paused', 'forming')`;
  const at = drizzleSql`case when ${live} then coalesce(${focusSessions.startedAt}, ${focusSessions.createdAt}) else coalesce(${focusSessions.closedAt}, ${focusSessions.updatedAt}) end`;
  const key = keyOf("session", focusSessions.id);
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
    .leftJoin(playbookRuns, eq(playbookRuns.sessionId, focusSessions.id))
    .where(
      and(
        scopedDb(q.access).predicate(focusSessions),
        // The work population the runs feed's session flow reads.
        // The project path's population: work, plus run sessions filed in a
        // track (a track's stage sessions). A run carried by a playbook_runs
        // row is excluded below, so nothing is listed twice.
        workAndTrackedRunsWhere(),
        ne(focusSessions.status, "scheduled"),
        isNull(playbookRuns.id),
        q.projectId ? eq(focusSessions.projectId, q.projectId) : undefined,
        q.trackId ? eq(focusSessions.trackId, q.trackId) : undefined,
        statuses
          ? inArray(focusSessions.status, statuses as never[])
          : undefined,
        actor,
        ...window(at, key, cursor, q.since)
      )
    )
    .orderBy(...order(at, key))
    .limit(take);
  return rows.map((r) => ({
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
}

// ── The door ────────────────────────────────────────────────────────────────

export async function listActivity(q: ActivityQuery): Promise<ActivityPage> {
  const database = q.database ?? db;
  const limit = Math.max(1, Math.min(q.limit, ACTIVITY_MAX_LIMIT));
  const cursor = q.cursor ? decodeActivityCursor(q.cursor) : null;
  if (q.since && Number.isNaN(Date.parse(q.since))) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid since" });
  }
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

  const take = limit + 1;
  const wants = (s: ActivitySource) => !q.source || q.source === s;
  const reads = await Promise.all([
    wants("proposal") ? readProposalActs(database, q, cursor, take) : [],
    wants("decision") ? readDecisions(database, q, cursor, take) : [],
    wants("run") ? readAutomationRuns(database, q, cursor, take) : [],
    wants("run") ? readPlaybookRuns(database, q, cursor, take) : [],
    wants("session") ? readSessions(database, q, cursor, take) : [],
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

  const titles = proposalRows.length
    ? await proposalNeighborNames(proposalRows, viewer, { roster: q.roster })
    : new Map<string, string>();
  const proposalById = new Map(proposalRows.map((p) => [p.id, p]));
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
      // everything else opens the proposal (its object may not exist).
      const opensTarget =
        p &&
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
