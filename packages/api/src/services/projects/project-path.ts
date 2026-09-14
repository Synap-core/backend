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
  links,
  artifacts,
  workspaces,
  and,
  eq,
  asc,
  desc,
  inArray,
  lte,
  count,
  drizzleSql,
  ProposalStatus,
  ownerPrivateVisibleWhere,
  userVisibleWhere,
} from "@synap/database";
import {
  buildObjectActionTitle,
  resolveStatusLabel,
} from "@synap-core/types/vocabulary";
import { resolveSessionTitle } from "@synap-core/types/focus-sessions";
import type { ExpectedOutput } from "@synap/playbooks";
import { createLogger } from "@synap-core/core";
import {
  deriveNextMove,
  isOpenAgentSlot,
  PACKET_TOP_N,
  type ContinuationNextMove,
  type PacketChildItem,
  type PacketProposalItem,
  type PacketSection,
  type PacketSlotItem,
} from "../focus-sessions/continuation-packet.js";
import {
  owedSlotPrefilter,
  owedSlotWhere,
  projectOwedSlots,
  type OwedSlot,
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
import { extractProposalName } from "../proposals/fingerprint.js";
import { buildPaginatedResponse } from "../../utils/pagination.js";

const logger = createLogger({ module: "project-path" });

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

export type PathCount = { status: "ok"; total: number } | Unavailable;

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

type Settled<T> = { status: "ok"; value: T } | Unavailable;

/** Log the cause; hand consumers only a fixed sentence (never driver text). */
function settle<T>(
  projectId: string,
  part: string,
  reason: string,
  read: () => Promise<T>
): Promise<Settled<T>> {
  return read().then(
    (value) => ({ status: "ok" as const, value }),
    (err: unknown) => {
      logger.warn(
        { err, projectId, section: part },
        "project path: section read failed"
      );
      return { status: "unavailable" as const, reason };
    }
  );
}

const iso = (d: Date | string | null | undefined): string | null =>
  d ? new Date(d).toISOString() : null;

function slotsOf(row: { expectedOutputs: unknown }): ExpectedOutput[] {
  return Array.isArray(row.expectedOutputs)
    ? (row.expectedOutputs as ExpectedOutput[]).filter(
        (s) => !!s && typeof s === "object"
      )
    : [];
}

function section<T>(all: T[]): PacketSection<T> {
  return { status: "ok", total: all.length, items: all.slice(0, PACKET_TOP_N) };
}

const emptySection = <T>(): PacketSection<T> => ({
  status: "ok",
  total: 0,
  items: [],
});

function owedItem(slot: OwedSlot): PacketSlotItem {
  return {
    label: slot.label,
    kind: slot.kind,
    ...(slot.blockedReason !== undefined
      ? { blockedReason: slot.blockedReason }
      : {}),
    ...(slot.why !== undefined ? { why: slot.why } : {}),
    owedSince: slot.owedSince,
  };
}

/** Group window-ranked rows (already cut to PACKET_TOP_N) into sections. */
function groupSections<R extends { total: number }, T>(
  rows: R[],
  keyOf: (r: R) => string,
  itemOf: (r: R) => T
): Map<string, PacketSection<T>> {
  const out = new Map<string, { status: "ok"; total: number; items: T[] }>();
  for (const r of rows) {
    const key = keyOf(r);
    const s = out.get(key) ?? { status: "ok", total: Number(r.total), items: [] };
    s.items.push(itemOf(r));
    out.set(key, s);
  }
  return out;
}

/**
 * Session-to-session edges (`blocked_by`, `spawned_from`) for the whole page in
 * ONE query. `anchor` is the page session, the joined row the OTHER end,
 * owner-floored like the packet's readers. `outbound` reads
 * `anchor --type--> other`; `inbound` reads `other --type--> anchor`.
 */
async function readEdges(
  database: typeof db,
  userId: string,
  ids: string[],
  direction: "outbound" | "inbound"
): Promise<Map<string, PacketSection<PacketChildItem>>> {
  const anchor = direction === "outbound" ? links.fromId : links.toId;
  const other = direction === "outbound" ? links.toId : links.fromId;
  const openFirst = drizzleSql`${inArray(focusSessions.status, [...OPEN_SESSION_STATUSES])} desc, ${focusSessions.createdAt} asc`;
  const ranked = database
    .select({
      anchor: drizzleSql<string>`${anchor}`.as("anchor"),
      linkType: links.linkType,
      id: focusSessions.id,
      title: focusSessions.title,
      goal: focusSessions.goal,
      status: focusSessions.status,
      rn: drizzleSql<number>`row_number() over (partition by ${anchor}, ${links.linkType} order by ${openFirst})`.as(
        "rn"
      ),
      total: drizzleSql<number>`count(*) over (partition by ${anchor}, ${links.linkType})`.as(
        "total"
      ),
    })
    .from(links)
    .innerJoin(focusSessions, eq(drizzleSql`${focusSessions.id}::text`, other))
    .where(
      and(
        eq(links.fromType, "session"),
        eq(links.toType, "session"),
        inArray(links.linkType, ["blocked_by", "spawned_from"]),
        inArray(anchor, ids),
        eq(focusSessions.userId, userId)
      )
    )
    .as("ranked");
  const rows = await database
    .select()
    .from(ranked)
    .where(lte(ranked.rn, PACKET_TOP_N))
    .orderBy(asc(ranked.anchor), asc(ranked.linkType), asc(ranked.rn));
  return groupSections(
    rows,
    (r) => `${r.anchor}|${r.linkType}`,
    (r) => ({
      id: r.id,
      title: resolveSessionTitle(r),
      status: r.status,
      statusLabel: resolveStatusLabel(r.status),
    })
  );
}

/** Pending proposals for the whole page, the oldest PACKET_TOP_N per session. */
async function readPendingProposals(
  database: typeof db,
  ids: string[]
): Promise<Map<string, PacketSection<PacketProposalItem>>> {
  const ranked = database
    .select({
      sessionId: proposals.sessionId,
      id: proposals.id,
      proposalType: proposals.proposalType,
      targetType: proposals.targetType,
      data: proposals.data,
      createdAt: proposals.createdAt,
      rn: drizzleSql<number>`row_number() over (partition by ${proposals.sessionId} order by ${proposals.createdAt} asc)`.as(
        "rn"
      ),
      total: drizzleSql<number>`count(*) over (partition by ${proposals.sessionId})`.as(
        "total"
      ),
    })
    .from(proposals)
    .where(
      and(
        inArray(proposals.sessionId, ids),
        eq(proposals.status, ProposalStatus.PENDING)
      )
    )
    .as("ranked");
  const rows = await database
    .select()
    .from(ranked)
    .where(lte(ranked.rn, PACKET_TOP_N))
    .orderBy(asc(ranked.sessionId), asc(ranked.rn));
  return groupSections(
    rows,
    (r) => String(r.sessionId),
    (r) => ({
      id: r.id,
      title: buildObjectActionTitle({
        action: r.proposalType,
        objectKind: r.targetType,
        objectName: extractProposalName(r.data) ?? null,
        mood: "imperative",
      }),
      proposalType: r.proposalType,
      createdAt: iso(r.createdAt),
    })
  );
}

/** Which page sessions produced anything, from both output ledgers. */
async function readOutputPresence(
  database: typeof db,
  ids: string[]
): Promise<Set<string>> {
  const [artifactRows, producedRows] = await Promise.all([
    database
      .selectDistinct({ sessionId: artifacts.sessionId })
      .from(artifacts)
      .where(inArray(artifacts.sessionId, ids)),
    database
      .selectDistinct({ sessionId: links.fromId })
      .from(links)
      .where(
        and(
          eq(links.fromType, "session"),
          inArray(links.fromId, ids),
          eq(links.linkType, "produced")
        )
      ),
  ]);
  return new Set(
    [...artifactRows, ...producedRows]
      .map((r) => r.sessionId)
      .filter((id): id is string => !!id)
  );
}

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
  const ids = page.map((r) => r.id);
  const wsIds = [
    ...new Set(page.map((r) => r.workspaceId).filter((w): w is string => !!w)),
  ];
  const emptyPage = ids.length === 0;

  const [proposalsBy, outbound, inbound, outputsWith, wsNames, open, owed, pending] =
    await Promise.all([
      settle(projectId, "pendingProposals", "Pending proposals could not be read.", () =>
        emptyPage
          ? Promise.resolve(new Map<string, PacketSection<PacketProposalItem>>())
          : readPendingProposals(database, ids)
      ),
      settle(projectId, "outboundEdges", "The sessions these wait on could not be read.", () =>
        emptyPage
          ? Promise.resolve(new Map<string, PacketSection<PacketChildItem>>())
          : readEdges(database, userId, ids, "outbound")
      ),
      settle(projectId, "inboundEdges", "The sessions these unblock could not be read.", () =>
        emptyPage
          ? Promise.resolve(new Map<string, PacketSection<PacketChildItem>>())
          : readEdges(database, userId, ids, "inbound")
      ),
      settle(projectId, "outputs", "Session outputs could not be read.", () =>
        emptyPage ? Promise.resolve(new Set<string>()) : readOutputPresence(database, ids)
      ),
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
      settle(projectId, "openSessions", "Open sessions could not be counted.", () =>
        database
          .select({ n: count() })
          .from(focusSessions)
          .where(
            and(conditions, inArray(focusSessions.status, [...OPEN_SESSION_STATUSES]))
          )
          .then(([r]) => Number(r?.n ?? 0))
      ),
      settle(projectId, "owedSlots", "Decisions waiting could not be counted.", () =>
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
          .then((rows) => rows.reduce((n, r) => n + projectOwedSlots(r).length, 0))
      ),
      settle(projectId, "pendingTotal", "Decisions waiting could not be counted.", () =>
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

  /** A section from a settled page-wide map, or that read's `unavailable`. */
  const pick = <T>(
    s: Settled<Map<string, PacketSection<T>>>,
    key: string
  ): PacketSection<T> =>
    s.status === "ok" ? (s.value.get(key) ?? emptySection<T>()) : s;
  const countOf = (s: PacketSection<unknown>): PathCount =>
    s.status === "ok" ? { status: "ok", total: s.total } : s;

  const items = attachSessionKind(attachTriage(page)).map(
    (row): ProjectPathRow => {
      const all = slotsOf(row);
      const owedSlots = section(
        projectOwedSlots({
          id: row.id,
          goal: row.goal,
          status: row.status,
          workspaceId: row.workspaceId,
          projectId: row.projectId,
          expectedOutputs: all,
        })
          .sort((a, b) =>
            a.owedSince < b.owedSince ? -1 : a.owedSince > b.owedSince ? 1 : 0
          )
          .map(owedItem)
      );
      const aiCanDo = section(
        all.filter(isOpenAgentSlot).map((s) => ({
          label: s.label,
          kind: s.kind,
          ...(s.delegatedTo ? { delegatedTo: s.delegatedTo } : {}),
        }))
      );
      const pendingProposals = pick(proposalsBy, row.id);
      const blockedBy = pick(outbound, `${row.id}|blocked_by`);
      const parent = pick(outbound, `${row.id}|spawned_from`);
      const unblocks = pick(inbound, `${row.id}|blocked_by`);
      const children = pick(inbound, `${row.id}|spawned_from`);
      const outputs: PacketSection<never> =
        outputsWith.status === "ok"
          ? { status: "ok", total: outputsWith.value.has(row.id) ? 1 : 0, items: [] }
          : outputsWith;

      return {
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
        blockedBy,
        unblocks,
        parentCount: countOf(parent),
        childrenCount: countOf(children),
        hasOutputs:
          outputsWith.status === "ok"
            ? { status: "ok", value: outputsWith.value.has(row.id) }
            : outputsWith,
        nextMove: deriveNextMove({
          status: row.status,
          owedSlots,
          pendingProposals,
          aiCanDo,
          blockedBy,
          expectedOutputs: all,
          outputs,
          children,
        }),
      };
    }
  );

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
