/**
 * PROJECT PATH — a project's work sessions as a DATED LIST, each row carrying
 * what it waits on, what it unblocks, and its one next move.
 *
 * A project spans workspaces (it is a lens, not a container), so this read is
 * floored on the USER and narrowed by the project — never on one workspace.
 * An optional workspace filter narrows further; it can never widen.
 *
 * ── ONE DERIVATION, BATCHED INPUTS ──────────────────────────────────────────
 * `nextMove` is THE packet rule (`deriveNextMove`), called per row. Only its
 * INPUTS are gathered differently: the continuation packet reads them for one
 * session; here the same inputs are read for the whole page in a FIXED number
 * of queries, whatever the page size. Per-session top-N is cut in SQL with a
 * window (`row_number() over (partition by session …)`), with the orderings the
 * packet readers use — oldest pending proposal first, OPEN linked sessions
 * first — because the rule only sees the top items.
 *
 * Outputs: the rule reads only `outputs.total > 0`, so this read asks only for
 * PRESENCE (any artifact row or `produced` edge — every `listSessionOutputs`
 * output comes from one of those two ledgers). The section handed to the rule
 * carries `total: 0 | 1` and no items; it is exposed as `hasOutputs`, never as
 * a count.
 *
 * ── ORDER: `startedAt` desc ─────────────────────────────────────────────────
 * A path is read as a chronology — "what did we start, and when". Last-activity
 * order would reshuffle the path every time an agent touches an old session,
 * so a row would sit somewhere else on each visit. `updatedAt` rides on every
 * row for "last touched"; `id` breaks ties so paging is stable.
 *
 * ── A FAILED READ IS NOT AN EMPTY ONE ───────────────────────────────────────
 * A batched section that fails marks that section `unavailable` on every row
 * (the rule then answers `unknown`), never `[]`. The project, page and
 * workspace-name reads throw: there is no honest partial answer without them.
 */

import {
  db,
  projects,
  focusSessions,
  proposals,
  workspaces,
  and,
  eq,
  desc,
  inArray,
  count,
  ProposalStatus,
  ownerPrivateVisibleWhere,
  userVisibleWhere,
} from "@synap/database";
import { resolveStatusLabel } from "@synap-core/types/vocabulary";
import { resolveSessionTitle } from "@synap-core/types/focus-sessions";
import type {
  ContinuationNextMove,
  PacketChildItem,
  PacketSection,
} from "../focus-sessions/continuation-packet.js";
import {
  owedSlotPrefilter,
  owedSlotWhere,
  projectOwedSlots,
} from "../focus-sessions/owed-outputs.js";
import {
  sessionListConditions,
  type SessionLens,
} from "../focus-sessions/session-list-conditions.js";
import { OPEN_SESSION_STATUSES } from "../focus-sessions/session-statuses.js";
import {
  attachTriage,
  type TriageProjection,
} from "../focus-sessions/triage.js";
import {
  attachSessionKind,
  type SessionKind,
} from "../focus-sessions/session-kind.js";
import {
  attachPathSections,
  settle,
  type PathCount,
  type Settled,
} from "../focus-sessions/session-path-sections.js";
import { buildPaginatedResponse } from "../../utils/pagination.js";

export type { PathCount };

export interface ProjectPathQuery {
  database?: typeof db;
  /** Owner floor. Sessions are owner-private. */
  userId: string;
  projectId: string;
  /** Narrow to these workspaces. Absent / empty ⇒ every workspace. */
  workspaceIds?: string[];
  /** Triage lens (`session-list-conditions.ts`). */
  lens: SessionLens;
  limit: number;
  offset: number;
}

type Unavailable = { status: "unavailable"; reason: string };

export interface ProjectPathRow {
  id: string;
  /** The stored name, `null` when untitled. */
  title: string | null;
  displayTitle: string;
  goal: string;
  status: string;
  statusLabel: string;
  kind: SessionKind;
  triage: TriageProjection;
  /**
   * `null` for a session filed in no workspace. `name` is `null` when the
   * caller cannot see that workspace.
   */
  workspace: { id: string; name: string | null } | null;
  startedAt: string | null;
  updatedAt: string | null;
  closedAt: string | null;
  /** `this --blocked_by--> other`, OPEN ones first. */
  blockedBy: PacketSection<PacketChildItem>;
  /** `other --blocked_by--> this`, OPEN ones first. */
  unblocks: PacketSection<PacketChildItem>;
  parentCount: PathCount;
  childrenCount: PathCount;
  hasOutputs: { status: "ok"; value: boolean } | Unavailable;
  nextMove: ContinuationNextMove;
}

export interface ProjectPathResult {
  project: {
    id: string;
    name: string;
    description: string | null;
    status: string;
    statusLabel: string;
  };
  /** Across the WHOLE path under the same filter, not just this page. */
  summary: {
    openSessions: PathCount;
    /** Owed human slots + pending proposals — what the user must decide. */
    userMustDecide: PathCount;
  };
  items: ProjectPathRow[];
  pagination: { hasMore: boolean; limit: number; offset: number };
}

const iso = (d: Date | string | null | undefined): string | null =>
  d ? new Date(d).toISOString() : null;

/** Returns `null` when the project does not exist or the caller cannot see it. */
export async function getProjectPath(
  query: ProjectPathQuery
): Promise<ProjectPathResult | null> {
  const database = query.database ?? db;
  const { userId, projectId, limit, offset } = query;

  // Same visibility predicate as `projects.get` / `GET /projects/:id`.
  const [project] = await database
    .select({
      id: projects.id,
      name: projects.name,
      description: projects.description,
      status: projects.status,
    })
    .from(projects)
    .where(
      and(
        eq(projects.id, projectId),
        ownerPrivateVisibleWhere(projects.workspaceId, projects.userId, userId)
      )
    )
    .limit(1);
  if (!project) return null;

  // ONE WHERE for every session list door. Kind is `work`: a path is the
  // project's work, never its automation runs or agent write containers.
  const conditions = and(
    ...sessionListConditions({
      userId,
      scope: {
        workspaceLens: query.workspaceIds?.length
          ? query.workspaceIds
          : undefined,
        projectLens: projectId,
      },
      status: "all",
      lens: query.lens,
      kind: "work",
    })
  );

  const pageRows = await database
    .select()
    .from(focusSessions)
    .where(conditions)
    .orderBy(desc(focusSessions.startedAt), desc(focusSessions.id))
    .limit(limit + 1)
    .offset(offset);
  const { items: page, pagination } = buildPaginatedResponse(pageRows, {
    limit,
    offset,
  });
  const wsIds = [
    ...new Set(page.map((r) => r.workspaceId).filter((w): w is string => !!w)),
  ];
  const [sectioned, wsNames, open, owed, pending] = await Promise.all([
    attachPathSections(attachSessionKind(attachTriage(page)), {
      userId,
      database,
      logContext: { projectId },
    }),
    // Names only for workspaces the caller can see — a session's stored id is
    // not permission to learn a workspace's name.
    wsIds.length
      ? database
          .select({ id: workspaces.id, name: workspaces.name })
          .from(workspaces)
          .where(
            and(
              inArray(workspaces.id, wsIds),
              userVisibleWhere(workspaces.id, userId)
            )
          )
          .then((rows) => new Map(rows.map((w) => [w.id, w.name])))
      : Promise.resolve(new Map<string, string>()),
    settle(
      { projectId },
      "openSessions",
      "Open sessions could not be counted.",
      () =>
        database
          .select({ n: count() })
          .from(focusSessions)
          .where(
            and(
              conditions,
              inArray(focusSessions.status, [...OPEN_SESSION_STATUSES])
            )
          )
          .then(([r]) => Number(r?.n ?? 0))
    ),
    settle(
      { projectId },
      "owedSlots",
      "Decisions waiting could not be counted.",
      () =>
        database
          .select({
            id: focusSessions.id,
            goal: focusSessions.goal,
            status: focusSessions.status,
            workspaceId: focusSessions.workspaceId,
            projectId: focusSessions.projectId,
            expectedOutputs: focusSessions.expectedOutputs,
          })
          .from(focusSessions)
          .where(and(conditions, owedSlotPrefilter(), owedSlotWhere()))
          .then((rows) =>
            rows.reduce((n, r) => n + projectOwedSlots(r).length, 0)
          )
    ),
    settle(
      { projectId },
      "pendingTotal",
      "Decisions waiting could not be counted.",
      () =>
        database
          .select({ n: count() })
          .from(proposals)
          .innerJoin(focusSessions, eq(proposals.sessionId, focusSessions.id))
          .where(and(conditions, eq(proposals.status, ProposalStatus.PENDING)))
          .then(([r]) => Number(r?.n ?? 0))
    ),
  ]);

  const toCount = (s: Settled<number>): PathCount =>
    s.status === "ok" ? { status: "ok", total: s.value } : s;
  const userMustDecide: PathCount =
    owed.status !== "ok"
      ? owed
      : pending.status !== "ok"
        ? pending
        : { status: "ok", total: owed.value + pending.value };

  const items = sectioned.map((row): ProjectPathRow => ({
    id: row.id,
    title: row.title ?? null,
    displayTitle: resolveSessionTitle(row),
    goal: row.goal,
    status: row.status,
    statusLabel: resolveStatusLabel(row.status),
    kind: row.kind,
    triage: row.triage,
    workspace: row.workspaceId
      ? { id: row.workspaceId, name: wsNames.get(row.workspaceId) ?? null }
      : null,
    startedAt: iso(row.startedAt),
    updatedAt: iso(row.updatedAt),
    closedAt: iso(row.closedAt),
    blockedBy: row.blockedBy,
    unblocks: row.unblocks,
    parentCount: row.parentCount,
    childrenCount: row.childrenCount,
    hasOutputs: row.hasOutputs,
    nextMove: row.nextMove,
  }));

  return {
    project: {
      id: project.id,
      name: project.name,
      description: project.description ?? null,
      status: project.status,
      statusLabel: resolveStatusLabel(project.status),
    },
    summary: { openSessions: toCount(open), userMustDecide },
    items,
    pagination,
  };
}
