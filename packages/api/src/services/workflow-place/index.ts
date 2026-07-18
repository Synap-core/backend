/**
 * Workflow-place read layer — the DERIVED aggregation door (WORKFLOW-AS-PLACE, D1).
 *
 * One workflow (automation OR playbook) → its runs + sessions + channels +
 * produced results + attributed proposals, plus a per-workflow event feed. This
 * is an OBSERVABILITY view, not a lens: every piece derives from keys already on
 * the runtime tables, so there is no new access dimension, no migration.
 *
 * Reuse, not fork:
 *   - `runs` come from the runs substrate's `listRuns({flowType, flowId})` — the
 *     same UnifiedRun the browser Runs view and `synap diagnose` read — enriched
 *     here only with the Wave-1 attribution fields (definitionSnapshot presence,
 *     replayOf) that UnifiedRun does not carry.
 *   - the user floor is `userVisibleWhere` everywhere — the identical predicate
 *     the runs substrate uses; a specific-workflow read never widens it.
 *
 * Security note (the feed): `events` has NO workspace_id. The floor is the
 * user-visible SESSION set — events are queried ONLY for sessions the user can
 * see, and never unfloored.
 */

import {
  db,
  and,
  eq,
  isNull,
  desc,
  inArray,
  drizzleSql,
  automations,
  automationRuns,
  playbooks,
  playbookRuns,
  focusSessions,
  channels,
  proposals,
  links,
  events,
  entities,
} from "@synap/database";
import type { SQL } from "drizzle-orm";
import {
  userVisibleWhere,
  workspaceLensWhere,
} from "../../utils/user-visible-where.js";
import { listRuns } from "../runs/index.js";
import type {
  WorkflowKind,
  WorkflowDefinition,
  WorkflowPlaceRun,
  WorkflowSession,
  WorkflowChannel,
  WorkflowResult,
  WorkflowProposal,
  WorkflowPlace,
  WorkflowFeedItem,
  WorkflowPlaceFeed,
} from "./types.js";

const FOCUS_SESSION_SUBJECT = "focus_session";
/** Bound each sub-derivation so one place read stays a handful of queries. */
const SESSION_CAP = 100;
const RESULT_CAP = 200;
const PROPOSAL_CAP = 100;

// ── Input shapes ─────────────────────────────────────────────────────────────

export interface GetWorkflowPlaceInput {
  kind: WorkflowKind;
  id: string;
  userId: string;
}

export interface GetWorkflowPlaceFeedInput {
  kind: WorkflowKind;
  id: string;
  userId: string;
  cursor?: string;
  limit?: number;
}

// ── Session scope (the derivation floor shared by every sub-query) ───────────

/**
 * The user-floored predicate for "focus sessions of this workflow":
 *   - playbook   → `playbook_id = id`
 *   - automation → `metadata->>'automationId' = id` (the run-session convention
 *     the runs substrate's session adapter uses to exclude automation-origin
 *     sessions from the standalone feed).
 */
function sessionScopeWhere(
  kind: WorkflowKind,
  id: string,
  userId: string
): SQL {
  return and(
    userVisibleWhere(focusSessions.workspaceId, userId),
    kind === "playbook"
      ? eq(focusSessions.playbookId, id)
      : drizzleSql`${focusSessions.metadata}->>'automationId' = ${id}`
  )!;
}

// ── Definition ───────────────────────────────────────────────────────────────

async function loadDefinition(
  kind: WorkflowKind,
  id: string,
  userId: string
): Promise<WorkflowDefinition | null> {
  if (kind === "automation") {
    const [row] = await db
      .select({
        id: automations.id,
        name: automations.name,
        description: automations.description,
        status: automations.status,
        version: automations.version,
        updatedAt: automations.updatedAt,
        triggerType: automations.triggerType,
        flowDefinition: automations.flowDefinition,
      })
      .from(automations)
      .where(
        and(
          eq(automations.id, id),
          userVisibleWhere(automations.workspaceId, userId)
        )
      )
      .limit(1);
    if (!row) return null;
    return {
      id: row.id,
      kind,
      name: row.name,
      description: row.description ?? null,
      status: row.status,
      version: row.version,
      updatedAt: row.updatedAt,
      triggerType: row.triggerType,
      nodeCount: Array.isArray(row.flowDefinition?.nodes)
        ? row.flowDefinition.nodes.length
        : 0,
    };
  }

  const [row] = await db
    .select({
      id: playbooks.id,
      name: playbooks.name,
      description: playbooks.description,
      status: playbooks.status,
      version: playbooks.version,
      updatedAt: playbooks.updatedAt,
      stages: playbooks.stages,
      subjectProfile: playbooks.subjectProfile,
      executor: playbooks.executor,
    })
    .from(playbooks)
    .where(
      and(eq(playbooks.id, id), userVisibleWhere(playbooks.workspaceId, userId))
    )
    .limit(1);
  if (!row) return null;
  const stages = Array.isArray(row.stages)
    ? (row.stages as Array<{ key?: unknown; label?: unknown }>).map((s) => ({
        key: typeof s.key === "string" ? s.key : "",
        label: typeof s.label === "string" ? s.label : "",
      }))
    : [];
  return {
    id: row.id,
    kind,
    name: row.name,
    description: row.description ?? null,
    status: row.status,
    version: row.version,
    updatedAt: row.updatedAt,
    stages,
    subjectProfile: row.subjectProfile ?? null,
    executor: row.executor,
  };
}

// ── Sessions ─────────────────────────────────────────────────────────────────

async function loadSessions(
  kind: WorkflowKind,
  id: string,
  userId: string
): Promise<WorkflowSession[]> {
  const rows = await db
    .select({
      id: focusSessions.id,
      goal: focusSessions.goal,
      status: focusSessions.status,
      startedAt: focusSessions.startedAt,
      closedAt: focusSessions.closedAt,
      channelId: focusSessions.channelId,
      subjectEntityId: focusSessions.subjectEntityId,
      projectId: focusSessions.projectId,
      currentStage: focusSessions.currentStage,
      progress: focusSessions.progress,
    })
    .from(focusSessions)
    .where(sessionScopeWhere(kind, id, userId))
    .orderBy(desc(focusSessions.startedAt))
    .limit(SESSION_CAP);
  return rows.map((r) => ({
    id: r.id,
    goal: r.goal,
    status: r.status,
    startedAt: r.startedAt,
    closedAt: r.closedAt ?? null,
    channelId: r.channelId ?? null,
    subjectEntityId: r.subjectEntityId ?? null,
    projectId: r.projectId ?? null,
    currentStage: r.currentStage ?? null,
    progress: r.progress ?? null,
  }));
}

// ── Runs (reuse listRuns, enrich with the attribution-spine fields) ──────────

async function loadRuns(
  kind: WorkflowKind,
  id: string,
  userId: string
): Promise<WorkflowPlaceRun[]> {
  const runs = await listRuns({ userId, flowType: kind, flowId: id });
  const runIds = runs.map((r) => r.id);
  if (runIds.length === 0) return [];

  const meta =
    kind === "automation"
      ? await db
          .select({
            id: automationRuns.id,
            hasSnapshot: drizzleSql<boolean>`${automationRuns.definitionSnapshot} IS NOT NULL`,
            replayOf: automationRuns.replayOf,
          })
          .from(automationRuns)
          .where(inArray(automationRuns.id, runIds))
      : await db
          .select({
            id: playbookRuns.id,
            hasSnapshot: drizzleSql<boolean>`${playbookRuns.definitionSnapshot} IS NOT NULL`,
            replayOf: playbookRuns.replayOf,
          })
          .from(playbookRuns)
          .where(inArray(playbookRuns.id, runIds));

  const metaById = new Map(meta.map((m) => [m.id, m]));
  return runs.map((r) => {
    const m = metaById.get(r.id);
    return {
      ...r,
      hasDefinitionSnapshot: m?.hasSnapshot ?? false,
      replayOf: m?.replayOf ?? null,
    };
  });
}

// ── Channels ─────────────────────────────────────────────────────────────────

async function loadChannels(
  kind: WorkflowKind,
  id: string,
  userId: string,
  sessions: WorkflowSession[]
): Promise<WorkflowChannel[]> {
  // automation → its ONE durable run channel, bound by context.
  // playbook   → the per-run channels living on its sessions.
  const where =
    kind === "automation"
      ? and(
          eq(channels.contextObjectType, "automation"),
          eq(channels.contextObjectId, id),
          userVisibleWhere(channels.workspaceId, userId)
        )!
      : (() => {
          const channelIds = [
            ...new Set(
              sessions.map((s) => s.channelId).filter((c): c is string => !!c)
            ),
          ];
          if (channelIds.length === 0) return null;
          return and(
            inArray(channels.id, channelIds),
            userVisibleWhere(channels.workspaceId, userId)
          )!;
        })();
  if (!where) return [];

  const rows = await db
    .select({
      id: channels.id,
      title: channels.title,
      channelType: channels.channelType,
      contextObjectType: channels.contextObjectType,
      contextObjectId: channels.contextObjectId,
    })
    .from(channels)
    .where(where);
  return rows.map((r) => ({
    id: r.id,
    title: r.title ?? null,
    channelType: r.channelType,
    contextObjectType: r.contextObjectType ?? null,
    contextObjectId: r.contextObjectId ?? null,
  }));
}

// ── Results (session --produced--> entity) ──────────────────────────────────

async function loadResults(
  sessionIds: string[],
  userId: string
): Promise<WorkflowResult[]> {
  if (sessionIds.length === 0) return [];
  // The produced-provenance edges the capture-back path writes. Floored on the
  // link's own workspace too (defense in depth; the sessions are already floored).
  const edges = await db
    .select({
      fromId: links.fromId,
      toId: links.toId,
      createdAt: links.createdAt,
    })
    .from(links)
    .where(
      and(
        eq(links.fromType, "session"),
        inArray(links.fromId, sessionIds),
        eq(links.toType, "entity"),
        eq(links.linkType, "produced"),
        workspaceLensWhere(links.workspaceId, userId)
      )
    )
    .orderBy(desc(links.createdAt))
    .limit(RESULT_CAP);
  if (edges.length === 0) return [];

  const entityIds = [...new Set(edges.map((e) => e.toId))];
  const rows = await db
    .select({
      id: entities.id,
      title: entities.title,
      type: entities.type,
    })
    .from(entities)
    .where(
      and(
        inArray(entities.id, entityIds),
        isNull(entities.deletedAt),
        userVisibleWhere(entities.workspaceId, userId)
      )
    );
  const byId = new Map(rows.map((r) => [r.id, r]));

  // Only surface edges whose entity still resolves (visible + not deleted).
  const results: WorkflowResult[] = [];
  for (const e of edges) {
    const ent = byId.get(e.toId);
    if (!ent) continue;
    results.push({
      entityId: ent.id,
      sessionId: e.fromId,
      title: ent.title ?? null,
      type: ent.type,
      producedAt: e.createdAt,
    });
  }
  return results;
}

// ── Proposals (attributed via the workflow's sessions) ──────────────────────

async function loadProposals(
  sessionIds: string[],
  userId: string
): Promise<WorkflowProposal[]> {
  if (sessionIds.length === 0) return [];
  const rows = await db
    .select({
      id: proposals.id,
      proposalType: proposals.proposalType,
      status: proposals.status,
      targetType: proposals.targetType,
      targetId: proposals.targetId,
      sessionId: proposals.sessionId,
      stepRunId: proposals.stepRunId,
      nodeId: proposals.nodeId,
      createdAt: proposals.createdAt,
      reviewedAt: proposals.reviewedAt,
      rejectionReason: proposals.rejectionReason,
      revisionHistory: proposals.revisionHistory,
    })
    .from(proposals)
    .where(
      and(
        inArray(proposals.sessionId, sessionIds),
        userVisibleWhere(proposals.workspaceId, userId)
      )
    )
    .orderBy(desc(proposals.createdAt))
    .limit(PROPOSAL_CAP);
  return rows.map((r) => ({
    id: r.id,
    proposalType: r.proposalType,
    status: r.status,
    targetType: r.targetType,
    targetId: r.targetId,
    sessionId: r.sessionId ?? null,
    stepRunId: r.stepRunId ?? null,
    nodeId: r.nodeId ?? null,
    createdAt: r.createdAt,
    reviewedAt: r.reviewedAt ?? null,
    rejectionReason: r.rejectionReason ?? null,
    revisionHistory: Array.isArray(r.revisionHistory) ? r.revisionHistory : [],
  }));
}

// ── Public: the workflow place aggregate ─────────────────────────────────────

/**
 * One workflow's place — definition + runs + sessions + channels + produced
 * results + attributed proposals. USER-floored throughout. Returns null when the
 * workflow does not exist or the user cannot see it (get-by-id user floor).
 */
export async function getWorkflowPlace(
  input: GetWorkflowPlaceInput
): Promise<WorkflowPlace | null> {
  const { kind, id, userId } = input;

  const definition = await loadDefinition(kind, id, userId);
  if (!definition) return null;

  const sessions = await loadSessions(kind, id, userId);
  const sessionIds = sessions.map((s) => s.id);

  const [runs, channelRefs, results, proposalRefs] = await Promise.all([
    loadRuns(kind, id, userId),
    loadChannels(kind, id, userId, sessions),
    loadResults(sessionIds, userId),
    loadProposals(sessionIds, userId),
  ]);

  return {
    definition,
    runs,
    sessions,
    channels: channelRefs,
    results,
    proposals: proposalRefs,
  };
}

// ── Public: the per-workflow event feed ──────────────────────────────────────

interface FeedCursor {
  ts: Date;
  id: string;
}

function encodeCursor(c: FeedCursor): string {
  return Buffer.from(`${c.ts.getTime()}:${c.id}`, "utf8").toString("base64url");
}

function decodeCursor(raw: string | undefined): FeedCursor | null {
  if (!raw) return null;
  try {
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    const sep = decoded.indexOf(":");
    if (sep < 0) return null;
    const ms = Number(decoded.slice(0, sep));
    const id = decoded.slice(sep + 1);
    if (!Number.isFinite(ms) || !id) return null;
    return { ts: new Date(ms), id };
  } catch {
    return null;
  }
}

/**
 * The workflow's per-workflow event feed — focus-session lifecycle events for
 * the workflow's (user-visible) sessions, newest-first, cursor-paginated.
 *
 * The session set IS the security floor: `events` has no workspace column, so we
 * derive user-visible session ids first and query events ONLY for them — never
 * unfloored. An empty session set returns an empty feed (no event query at all).
 */
export async function getWorkflowPlaceFeed(
  input: GetWorkflowPlaceFeedInput
): Promise<WorkflowPlaceFeed> {
  const { kind, id, userId } = input;
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);

  const sessionRows = await db
    .select({ id: focusSessions.id })
    .from(focusSessions)
    .where(sessionScopeWhere(kind, id, userId));
  const sessionIds = sessionRows.map((r) => r.id);
  if (sessionIds.length === 0) return { items: [], nextCursor: null };

  const cursor = decodeCursor(input.cursor);
  const rows = await db
    .select({
      id: events.id,
      at: events.timestamp,
      type: events.type,
      subjectId: events.subjectId,
      data: events.data,
      correlationId: events.correlationId,
    })
    .from(events)
    .where(
      and(
        eq(events.subjectType, FOCUS_SESSION_SUBJECT),
        inArray(events.subjectId, sessionIds),
        // Keyset pagination: strictly-older than the cursor, id as tiebreak.
        cursor
          ? drizzleSql`(${events.timestamp} < ${cursor.ts} OR (${events.timestamp} = ${cursor.ts} AND ${events.id} < ${cursor.id}::uuid))`
          : undefined
      )
    )
    .orderBy(desc(events.timestamp), desc(events.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const items: WorkflowFeedItem[] = page.map((e) => ({
    id: e.id,
    at: e.at,
    type: e.type,
    sessionId: e.subjectId,
    data: (e.data ?? null) as Record<string, unknown> | null,
    correlationId: e.correlationId ?? null,
  }));
  const last = page[page.length - 1];
  const nextCursor =
    hasMore && last ? encodeCursor({ ts: last.at, id: last.id }) : null;

  return { items, nextCursor };
}
