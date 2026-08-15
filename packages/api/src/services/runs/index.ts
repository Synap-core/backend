/**
 * Unified runs read layer — the spine of the runs-substrate consolidation.
 *
 * Maps the pod's several run ledgers to ONE `UnifiedRun` (see ./types) so a
 * single Runs/Activity view + the AI diagnose door read every flow the same way.
 * No new table, no migration (D3): capture runs are SYNTHESISED from the
 * `capture.graph` proposal + its `correlationId`-keyed events — the story capture
 * already emits, finally surfaced.
 *
 * Every read is USER-floored via `userVisibleWhere` (the identical predicate
 * `proposals.list` / `activity.summary` use), so no cross-workspace run leaks.
 */

import {
  db,
  and,
  or,
  eq,
  isNull,
  gt,
  lt,
  asc,
  desc,
  inArray,
  drizzleSql,
  automations,
  automationRuns,
  automationStepRuns,
  playbooks,
  playbookRuns,
  focusSessions,
  proposals,
  events,
  channels,
  links,
  entities,
  messages,
  users,
  chatTurns,
  chatTurnEvents,
  ChatTurnStatus,
} from "@synap/database";
import { ProposalStatus } from "@synap/database/schema";
import {
  userVisibleWhere,
  workspaceLensWhere,
  ownerPrivateVisibleWhere,
} from "../../utils/user-visible-where.js";
import { accessScopeWhere } from "../../utils/project-scope.js";
import { AI_DECISION, AI_PROCESSING } from "../../lib/ai-events.js";
import type {
  FlowType,
  RunStatus,
  UnifiedRun,
  RunActivityItem,
  UnifiedRunDetail,
  PlaybookRunDetail,
  RunProducedEntity,
  RunProposalItem,
  RunAgent,
  RunGroup,
  RunDefinitionSnapshot,
  AutomationStepActivityItem,
} from "./types.js";
import type {
  AutomationNode,
  FlowDefinition,
  RunPathTaken,
} from "@synap/database";
import {
  decodeRunGroupCursor,
  encodeRunGroupCursor,
  type RunGroupCursor,
} from "../../utils/keyset-cursor.js";
import { validateFlowDefinition } from "../automations/validate-flow.js";

const CAPTURE_PROPOSAL_TYPE = "capture.graph";
/** `proposals.proposalType` for the agnostic-capability last-mile executor
 * (Workstream 1 — see approve-executors.ts's `capability.run` executor). */
const CAPABILITY_RUN_PROPOSAL_TYPE = "capability.run";
/**
 * `events.data.kind` (and `action`) for a capability run's ai_decision event —
 * the literal BOTH the `capability.run` approve-executor AND the direct-run door
 * (`executeCapability`) emit. A DIRECT run (owner-bypass / read-only builtin /
 * governance-auto-granted agent) has this event but NO proposal, so the run read
 * layer must synthesise it from the event to make direct runs observable too.
 */
const CAPABILITY_RUN_EVENT_KIND = "capability_run";

/**
 * Newest-first comparator for the unified feed — TOLERANT OF A MISSING DATE.
 *
 * `UnifiedRun.startedAt` is declared `Date` (non-optional), but this feed is a
 * UNION over six independently-mapped ledgers, and each mapper reads a different
 * source column (`startedAt`, `createdAt`, an event `timestamp`, …). A mapper
 * that reads a column its row does not carry yields `undefined` at runtime while
 * still typechecking — and the previous `b.startedAt.getTime()` then threw
 * `Cannot read properties of undefined (reading 'getTime')` INSIDE `Array.sort`,
 * taking down the ENTIRE runs feed because ONE row of one ledger was malformed.
 *
 * A union feed must degrade per-row, never per-request: an undateable run sorts
 * last instead of erasing every other run. This is deliberately NOT a silent
 * `?? new Date()` — fabricating "now" would rank a broken row FIRST, which is
 * the opposite of honest.
 */
function byStartedAtDesc(
  a: { startedAt?: Date | null },
  b: { startedAt?: Date | null }
): number {
  const at = a.startedAt?.getTime?.() ?? -Infinity;
  const bt = b.startedAt?.getTime?.() ?? -Infinity;
  return bt - at;
}

/**
 * A capability run's output (`proposal.data.runResult`) can be arbitrarily large
 * (a provider list, a full API envelope). Pass it through the RunDetail's
 * `outputSummary` verbatim when small; otherwise a truncated preview + a flag so
 * a huge payload never bloats the detail response.
 */
function boundRunResult(runResult: unknown): unknown {
  if (runResult === undefined || runResult === null) return null;
  const json = JSON.stringify(runResult);
  if (json.length <= 8000) return runResult;
  return { truncated: true, preview: json.slice(0, 8000) };
}

/**
 * Server-side scope — narrows the feed to a lens WITHIN the user floor, so the
 * Activity telescope's altitudes (workspace / project / entity-focus) filter at
 * the DB instead of client-side over one page. Each is applied only where the
 * ledger carries the column (automation runs have no project/subject → they are
 * excluded when project/entity scope is set; see listRuns).
 */
export interface RunScope {
  workspaceId?: string;
  projectId?: string;
  /** Entity-focus: runs about / touching this entity. */
  subjectEntityId?: string;
}

export interface ListRunsInput {
  userId: string;
  /** Restrict to one ledger; omit for the merged cross-flow feed. */
  flowType?: FlowType;
  /** Restrict to one flow's runs (automationId / playbookId). */
  flowId?: string;
  /** Narrow to a workspace / project / entity lens (within the user floor). */
  scope?: RunScope;
  /**
   * Filter to one lifecycle status, pushed down into EACH ledger's own vocabulary
   * (so "Running" is a DB predicate, not a client filter over a truncated page —
   * the runs-feed truncation bug). A ledger that cannot produce the requested
   * status contributes nothing. Omit for all statuses.
   */
  status?: RunStatus;
  /** Per-flow cap before the merge; the merged result is also capped. */
  limit?: number;
}

// ── Status normalisers ───────────────────────────────────────────────────────

/** focus_sessions lifecycle → the run vocabulary. */
function sessionStatus(s: string): RunStatus {
  switch (s) {
    case "closed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    // A reaper-marked stale session is NOT "still going" — mapping it to
    // "running" in the run feed would mislabel a dead session as active. It is
    // a terminal, non-success end-state → cancelled.
    case "stale":
      return "cancelled";
    // active / paused / forming / scheduled are all "still going" for a run view.
    default:
      return "running";
  }
}

// ── Status-filter mappers (normalised RunStatus → each ledger's own vocabulary) ─
// Each returns the concrete column values matching the normalised filter; an
// EMPTY array means the ledger can never produce that status (skip the query).

type AutomationRunStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "skipped"
  | "blocked_by_policy";
type PlaybookRunStatusValue = "running" | "completed" | "failed" | "proposed";
type FocusSessionStatus =
  | "active"
  | "paused"
  | "closed"
  | "forming"
  | "scheduled"
  | "failed"
  | "cancelled"
  | "stale";

function automationStatusValues(status: RunStatus): AutomationRunStatus[] {
  switch (status) {
    case "running":
    case "completed":
    case "failed":
    case "cancelled":
    case "skipped":
    case "blocked_by_policy":
      return [status];
    case "proposed":
      return []; // automation_runs has no "proposed"
  }
}

function playbookStatusValues(status: RunStatus): PlaybookRunStatusValue[] {
  switch (status) {
    case "running":
    case "completed":
    case "failed":
    case "proposed":
      return [status];
    case "cancelled":
    case "skipped":
    case "blocked_by_policy":
      return []; // playbook_runs has no "cancelled"/"skipped"/"blocked_by_policy"
  }
}

function sessionStatusValues(status: RunStatus): FocusSessionStatus[] {
  switch (status) {
    case "running":
      return ["active", "paused", "forming", "scheduled"];
    case "completed":
      return ["closed"];
    case "failed":
      return ["failed"];
    case "cancelled":
      // `stale` projects to the `cancelled` RunStatus (see normalizeSessionStatus),
      // so the reverse filter MUST include it — else a stale session shows a
      // `cancelled` badge in the run feed but is unreachable by the cancelled filter.
      return ["cancelled", "stale"];
    case "proposed":
    case "skipped":
    case "blocked_by_policy":
      return []; // focus_sessions is never "proposed"/"skipped"/"blocked_by_policy"
  }
}

type ChatTurnStatusValue =
  | typeof ChatTurnStatus.RUNNING
  | typeof ChatTurnStatus.COMPLETED
  | typeof ChatTurnStatus.FAILED
  | typeof ChatTurnStatus.CANCELLED;

function chatRunStatus(s: string): RunStatus {
  switch (s) {
    case ChatTurnStatus.COMPLETED:
      return "completed";
    case ChatTurnStatus.FAILED:
      return "failed";
    case ChatTurnStatus.CANCELLED:
      return "cancelled";
    case ChatTurnStatus.RUNNING:
    default:
      return "running";
  }
}

function chatStatusValues(status: RunStatus): ChatTurnStatusValue[] {
  switch (status) {
    case "running":
      return [ChatTurnStatus.RUNNING];
    case "completed":
      return [ChatTurnStatus.COMPLETED];
    case "failed":
      return [ChatTurnStatus.FAILED];
    case "cancelled":
      return [ChatTurnStatus.CANCELLED];
    case "proposed":
    case "skipped":
    case "blocked_by_policy":
      return []; // chat_turns has none of these
  }
}

// ── Per-ledger adapters (list) ───────────────────────────────────────────────

async function listAutomationRuns(
  userId: string,
  flowId: string | undefined,
  scope: RunScope,
  limit: number,
  status?: RunStatus,
  exactRunId?: string
): Promise<UnifiedRun[]> {
  const statusValues = status ? automationStatusValues(status) : null;
  if (statusValues && statusValues.length === 0) return [];
  const rows = await db
    .select({
      id: automationRuns.id,
      automationId: automationRuns.automationId,
      flowName: automations.name,
      status: automationRuns.status,
      startedAt: automationRuns.startedAt,
      completedAt: automationRuns.completedAt,
      workspaceId: automationRuns.workspaceId,
      subjectEntityId: automationRuns.subjectEntityId,
      error: automationRuns.errorMessage,
      outputSummary: automationRuns.outputSummary,
      triggeredBy: automationRuns.triggeredBy,
      stepsCompleted: automationRuns.stepsCompleted,
      stepsFailed: automationRuns.stepsFailed,
      // NULL snapshot → NULL version (tolerant); ::int for a numeric field.
      definitionVersion: drizzleSql<
        number | null
      >`(${automationRuns.definitionSnapshot}->>'version')::int`,
      // The automation's ONE durable run channel (runs-substrate rule) — same
      // for every run of this automation, bound via contextObjectId.
      channelId: channels.id,
      replayOf: automationRuns.replayOf,
    })
    .from(automationRuns)
    .innerJoin(automations, eq(automations.id, automationRuns.automationId))
    .leftJoin(
      channels,
      and(
        eq(channels.contextObjectType, "automation"),
        eq(channels.contextObjectId, automationRuns.automationId)
      )
    )
    .where(
      and(
        userVisibleWhere(automationRuns.workspaceId, userId),
        exactRunId ? eq(automationRuns.id, exactRunId) : undefined,
        flowId ? eq(automationRuns.automationId, flowId) : undefined,
        scope.workspaceId
          ? eq(automationRuns.workspaceId, scope.workspaceId)
          : undefined,
        scope.subjectEntityId
          ? eq(automationRuns.subjectEntityId, scope.subjectEntityId)
          : undefined,
        statusValues ? inArray(automationRuns.status, statusValues) : undefined
      )
    )
    .orderBy(desc(automationRuns.startedAt))
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    flowType: "automation" as const,
    flowId: r.automationId,
    flowName: r.flowName ?? "Automation",
    status: r.status as RunStatus,
    startedAt: r.startedAt,
    completedAt: r.completedAt ?? null,
    // `automation_runs` has no updated_at, and the step-level activity that
    // would stand in for one cannot distinguish a hang from a legitimately
    // delay-suspended run (a delay node can wait DAYS — see
    // `RUN_NOT_DELAY_SUSPENDED`). Reporting UNKNOWN is the honest answer;
    // automation hangs are covered by `automation-run-reaper` instead, which
    // force-fails an orphan within 45min and thereby surfaces it under
    // `failed_flows`, delay-exemption and all.
    lastActivityAt: null,
    workspaceId: r.workspaceId ?? null,
    projectId: null,
    subjectEntityId: r.subjectEntityId ?? null,
    channelId: r.channelId ?? null,
    correlationId: null,
    replayOf: r.replayOf ?? null,
    summary:
      typeof r.outputSummary?.summary === "string"
        ? (r.outputSummary.summary as string)
        : null,
    error: r.error ?? null,
    triggeredBy: r.triggeredBy ?? null,
    stepsCompleted: r.stepsCompleted ?? null,
    stepsFailed: r.stepsFailed ?? null,
    definitionVersion: r.definitionVersion ?? null,
  }));
}

async function listPlaybookRuns(
  userId: string,
  flowId: string | undefined,
  scope: RunScope,
  limit: number,
  status?: RunStatus,
  exactRunId?: string
): Promise<UnifiedRun[]> {
  const statusValues = status ? playbookStatusValues(status) : null;
  if (statusValues && statusValues.length === 0) return [];
  const rows = await db
    .select({
      id: playbookRuns.id,
      playbookId: playbookRuns.playbookId,
      flowName: playbooks.name,
      status: playbookRuns.status,
      startedAt: playbookRuns.startedAt,
      completedAt: playbookRuns.completedAt,
      workspaceId: playbookRuns.workspaceId,
      summary: playbookRuns.summary,
      error: playbookRuns.error,
      // The run's room lives on its session (playbook → 1 channel per run).
      channelId: focusSessions.channelId,
      subjectEntityId: focusSessions.subjectEntityId,
      projectId: focusSessions.projectId,
      // Progress signal: `playbook_runs` has no updated_at, so "actively
      // worked" is read off the linked session — the SAME column
      // `playbook-run-reaper` uses to decide a run is orphaned. One signal, two
      // consumers (it reports, the reaper acts), never two definitions.
      lastActivityAt: focusSessions.updatedAt,
      replayOf: playbookRuns.replayOf,
      // NULL snapshot → NULL version (tolerant); ::int for a numeric field.
      definitionVersion: drizzleSql<
        number | null
      >`(${playbookRuns.definitionSnapshot}->>'version')::int`,
    })
    .from(playbookRuns)
    .innerJoin(playbooks, eq(playbooks.id, playbookRuns.playbookId))
    .leftJoin(focusSessions, eq(focusSessions.id, playbookRuns.sessionId))
    .where(
      and(
        userVisibleWhere(playbookRuns.workspaceId, userId),
        exactRunId ? eq(playbookRuns.id, exactRunId) : undefined,
        flowId ? eq(playbookRuns.playbookId, flowId) : undefined,
        scope.workspaceId
          ? eq(playbookRuns.workspaceId, scope.workspaceId)
          : undefined,
        scope.projectId
          ? eq(focusSessions.projectId, scope.projectId)
          : undefined,
        scope.subjectEntityId
          ? eq(focusSessions.subjectEntityId, scope.subjectEntityId)
          : undefined,
        statusValues ? inArray(playbookRuns.status, statusValues) : undefined
      )
    )
    .orderBy(desc(playbookRuns.startedAt))
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    flowType: "playbook" as const,
    flowId: r.playbookId,
    flowName: r.flowName ?? "Playbook",
    status: r.status as RunStatus,
    startedAt: r.startedAt,
    completedAt: r.completedAt ?? null,
    lastActivityAt: r.lastActivityAt ?? null,
    workspaceId: r.workspaceId ?? null,
    projectId: r.projectId ?? null,
    subjectEntityId: r.subjectEntityId ?? null,
    channelId: r.channelId ?? null,
    correlationId: null,
    replayOf: r.replayOf ?? null,
    summary: r.summary ?? null,
    error: r.error ?? null,
    triggeredBy: null,
    stepsCompleted: null,
    stepsFailed: null,
    definitionVersion: r.definitionVersion ?? null,
  }));
}

async function listCaptureRuns(
  userId: string,
  scope: RunScope,
  limit: number,
  status?: RunStatus,
  exactRunId?: string
): Promise<UnifiedRun[]> {
  // Capture runs are always "completed"; any other status filter excludes them.
  if (status && status !== "completed") return [];
  // A capture run = one auto-approved `capture.graph` proposal. Its correlationId
  // (== the captureId) is the join key that also groups its ai_decision +
  // capture_trace events (surfaced in getRun's activity).
  const rows = await db
    .select({
      id: proposals.id,
      correlationId: proposals.correlationId,
      status: proposals.status,
      createdAt: proposals.createdAt,
      reviewedAt: proposals.reviewedAt,
      workspaceId: proposals.workspaceId,
      projectId: proposals.projectId,
      data: proposals.data,
    })
    .from(proposals)
    .where(
      and(
        eq(proposals.proposalType, CAPTURE_PROPOSAL_TYPE),
        userVisibleWhere(proposals.workspaceId, userId),
        exactRunId
          ? or(
              eq(proposals.correlationId, exactRunId),
              eq(proposals.id, exactRunId)
            )
          : undefined,
        scope.workspaceId
          ? eq(proposals.workspaceId, scope.workspaceId)
          : undefined,
        scope.projectId ? eq(proposals.projectId, scope.projectId) : undefined,
        // Entity-focus: captures that materialized this entity (any of the
        // produced ids, not just the primary). JSONB containment on the array.
        scope.subjectEntityId
          ? drizzleSql`${proposals.data}->'materialized'->'entityIds' @> ${JSON.stringify(
              [scope.subjectEntityId]
            )}::jsonb`
          : undefined
      )
    )
    .orderBy(desc(proposals.createdAt))
    .limit(limit);

  return rows.map((r) => {
    const data = (r.data ?? {}) as Record<string, unknown>;
    const materialized = (data.materialized ?? {}) as {
      entityIds?: unknown;
    };
    const firstEntity = Array.isArray(materialized.entityIds)
      ? (materialized.entityIds[0] as string | undefined)
      : undefined;
    return {
      // The captureId is the run's identity — fall back to the row id.
      id: r.correlationId ?? r.id,
      flowType: "capture" as const,
      flowId: null,
      flowName: "Capture",
      // An auto-approved capture write is done; traces (if any) surface as
      // activity warnings, not a failed status.
      status: "completed" as const,
      startedAt: r.createdAt,
      completedAt: r.reviewedAt ?? r.createdAt,
      // Synthesised from a terminal proposal — a capture run is never "running",
      // so there is nothing for a progress signal to watch.
      lastActivityAt: null,
      workspaceId: r.workspaceId ?? null,
      projectId: r.projectId ?? null,
      subjectEntityId: firstEntity ?? null,
      channelId: null,
      correlationId: r.correlationId ?? null,
      replayOf: null,
      summary:
        typeof data.summary === "string" ? (data.summary as string) : null,
      error: null,
      triggeredBy: null,
      stepsCompleted: null,
      stepsFailed: null,
      definitionVersion: null,
    };
  });
}

/** Map a `capability.run` proposal's ProposalStatus to the unified RunStatus. */
function capabilityRunStatus(status: string): RunStatus {
  switch (status) {
    case ProposalStatus.PENDING:
      return "proposed";
    case ProposalStatus.APPROVED:
    case ProposalStatus.AUTO_APPROVED:
      return "completed";
    case ProposalStatus.APPROVAL_FAILED:
      return "failed";
    case ProposalStatus.REJECTED:
    case ProposalStatus.WITHDRAWN:
    case ProposalStatus.REVERTED:
      return "cancelled";
    default:
      return "proposed";
  }
}

/**
 * A capability run = one `capability.run` proposal (Workstream 1's agnostic
 * capability last-mile — approve-executors.ts's `capability.run` executor).
 * Mirrors `listCaptureRuns`: the executor stamps `correlationId` on approval,
 * which is the join key for the run's `ai_decision`-keyed timeline (see
 * getRun's "capability" branch below). Has no `flowId`/channel, exactly like
 * capture (an ad-hoc, non-grouped run).
 */
async function listCapabilityRuns(
  userId: string,
  scope: RunScope,
  limit: number,
  status?: RunStatus,
  exactRunId?: string
): Promise<UnifiedRun[]> {
  // No entity-subject linkage exists for a capability run (unlike capture's
  // materialized entityIds) — an entity-focused scope has nothing to match.
  if (scope.subjectEntityId) return [];

  const rows = await db
    .select({
      id: proposals.id,
      correlationId: proposals.correlationId,
      status: proposals.status,
      createdAt: proposals.createdAt,
      reviewedAt: proposals.reviewedAt,
      workspaceId: proposals.workspaceId,
      projectId: proposals.projectId,
      data: proposals.data,
    })
    .from(proposals)
    .where(
      and(
        eq(proposals.proposalType, CAPABILITY_RUN_PROPOSAL_TYPE),
        userVisibleWhere(proposals.workspaceId, userId),
        // Mirror listCaptureRuns: the executor stamps `correlationId` on approval
        // and that is the id diagnose/getRun pass in. Match BOTH so a run is
        // resolvable by its correlationId, not just the proposal row id.
        exactRunId
          ? or(
              eq(proposals.correlationId, exactRunId),
              eq(proposals.id, exactRunId)
            )
          : undefined,
        scope.workspaceId
          ? eq(proposals.workspaceId, scope.workspaceId)
          : undefined,
        scope.projectId ? eq(proposals.projectId, scope.projectId) : undefined
      )
    )
    .orderBy(desc(proposals.createdAt))
    .limit(limit);

  const proposalRuns: UnifiedRun[] = rows.map((r) => {
    const data = (r.data ?? {}) as Record<string, unknown>;
    return {
      id: r.id,
      flowType: "capability" as const,
      flowId: null,
      flowName:
        typeof data.verbId === "string" && data.verbId
          ? data.verbId
          : typeof data.skillId === "string"
            ? data.skillId
            : "Capability",
      status: capabilityRunStatus(r.status),
      startedAt: r.createdAt,
      completedAt: r.reviewedAt ?? null,
      // Synthesised from a proposal row — no per-run progress column exists.
      lastActivityAt: null,
      workspaceId: r.workspaceId ?? null,
      projectId: r.projectId ?? null,
      subjectEntityId: null,
      channelId: null,
      correlationId: r.correlationId ?? null,
      replayOf: null,
      // The executor stores the run output in `data.runResult` on approval;
      // surface a compact one-line form so the Activity feed shows the result
      // (mirrors capture's `data.summary`), not a blank row.
      summary:
        data.runResult !== undefined
          ? `Result: ${JSON.stringify(data.runResult).slice(0, 200)}`
          : null,
      error: null,
      triggeredBy: null,
      stepsCompleted: null,
      stepsFailed: null,
      definitionVersion: null,
    };
  });

  // DIRECT runs — a capability executed via the door WITHOUT a proposal
  // (owner-bypass / read-only builtin / governance-auto-granted agent) emits a
  // `capability_run` ai_decision event keyed by correlationId but has NO
  // proposal row. Synthesise a run from that event so direct runs are observable
  // too. Events carry no project column (workspace lives in `data.workspaceId`),
  // so a project-scoped feed excludes them; user-floored on `events.userId`.
  const eventRuns: UnifiedRun[] = scope.projectId
    ? []
    : await (async () => {
        const eventRows = await db
          .select({
            id: events.id,
            correlationId: events.correlationId,
            timestamp: events.timestamp,
            data: events.data,
          })
          .from(events)
          .where(
            and(
              eq(events.subjectType, AI_DECISION),
              drizzleSql`${events.data}->>'kind' = ${CAPABILITY_RUN_EVENT_KIND}`,
              // A direct run's identity IS its correlationId — required so it is
              // listable + diagnosable by that key.
              drizzleSql`${events.correlationId} IS NOT NULL`,
              eq(events.userId, userId),
              exactRunId ? eq(events.correlationId, exactRunId) : undefined,
              scope.workspaceId
                ? drizzleSql`${events.data}->>'workspaceId' = ${scope.workspaceId}`
                : undefined
            )
          )
          .orderBy(desc(events.timestamp))
          .limit(limit);
        return eventRows.map((e) => {
          const data = (e.data ?? {}) as Record<string, unknown>;
          const runResult = data.runResult;
          return {
            // A direct run has no proposal row — its correlationId is its id
            // (mirrors capture's `correlationId ?? id`).
            id: e.correlationId ?? e.id,
            flowType: "capability" as const,
            flowId: null,
            flowName:
              typeof data.verbId === "string" && data.verbId
                ? data.verbId
                : typeof data.skillId === "string"
                  ? data.skillId
                  : "Capability",
            // An emitted direct run reached its handler and returned → completed.
            status: "completed" as const,
            startedAt: e.timestamp,
            completedAt: e.timestamp,
            // Synthesised from a single terminal event — never "running".
            lastActivityAt: null,
            workspaceId:
              typeof data.workspaceId === "string" ? data.workspaceId : null,
            projectId: null,
            subjectEntityId: null,
            channelId: null,
            correlationId: e.correlationId ?? null,
            replayOf: null,
            summary:
              runResult !== undefined
                ? `Result: ${JSON.stringify(runResult).slice(0, 200)}`
                : null,
            error: null,
            triggeredBy: null,
            stepsCompleted: null,
            stepsFailed: null,
            definitionVersion: null,
          };
        });
      })();

  // Union + dedupe by correlationId. A proposed→approved run has BOTH a proposal
  // (correlationId stamped on approval) AND a `capability_run` event with the
  // same key — it must appear ONCE, proposal-backed winning (it carries the
  // richer lifecycle status + reviewedAt). PENDING proposals have a null
  // correlationId and collide with nothing.
  const seenCorrelation = new Set(
    proposalRuns
      .map((r) => r.correlationId)
      .filter((c): c is string => typeof c === "string")
  );
  const merged = [
    ...proposalRuns,
    ...eventRuns.filter(
      (r) => !r.correlationId || !seenCorrelation.has(r.correlationId)
    ),
  ];
  merged.sort(byStartedAtDesc);
  return merged.slice(0, limit).filter((r) => !status || r.status === status);
}

/**
 * A plain AGENT WRITE — the catch-all ledger for an auto-approved agent action
 * that instantiates no flow.
 *
 * A CLI `synap capture`, an MCP `create_entity`, a `remember_fact` — each leaves
 * an AUTO_APPROVED proposal receipt (permission-check.ts's `gov.decision ===
 * "execute"` branch) plus a `.completed` event on the spine, and belongs to no
 * automation, playbook, chat turn or capability run. Every other flow type keyed
 * off a ledger row or a specific proposalType, so these rendered in NONE of them
 * and were invisible in the unified feed.
 *
 * Synthesis is the SAME correlationId-keyed mechanism `listCaptureRuns` /
 * `listCapabilityRuns` already use (the receipt is the row, its correlationId is
 * the run identity and the join key for its events) — deliberately not a second
 * mechanism.
 *
 * The floor excludes what another flow type already renders:
 *   - `capture.graph` / `capability.run` proposalTypes  → their own flow types
 *   - `stepRunId IS NOT NULL`                            → an automation step's
 *     write, already inside its automation run's timeline
 * and requires `agentUserId IS NOT NULL` (a HUMAN's auto-approved write is not
 * an agent action, and is not what this feed answers for).
 */
async function listAgentWriteRuns(
  userId: string,
  scope: RunScope,
  limit: number,
  status?: RunStatus,
  exactRunId?: string
): Promise<UnifiedRun[]> {
  // An auto-approved receipt means the write already executed → always
  // "completed"; any other status filter excludes this ledger entirely.
  if (status && status !== "completed") return [];
  // No entity-subject linkage exists on a plain write receipt (unlike capture's
  // `data.materialized.entityIds`) — an entity-focused scope has nothing to
  // match. Mirrors listCapabilityRuns.
  if (scope.subjectEntityId) return [];

  const rows = await db
    .select({
      id: proposals.id,
      correlationId: proposals.correlationId,
      proposalType: proposals.proposalType,
      targetType: proposals.targetType,
      agentUserId: proposals.agentUserId,
      createdAt: proposals.createdAt,
      workspaceId: proposals.workspaceId,
      projectId: proposals.projectId,
      data: proposals.data,
    })
    .from(proposals)
    .where(
      and(
        eq(proposals.status, ProposalStatus.AUTO_APPROVED),
        drizzleSql`${proposals.agentUserId} IS NOT NULL`,
        drizzleSql`${proposals.proposalType} NOT IN (${CAPTURE_PROPOSAL_TYPE}, ${CAPABILITY_RUN_PROPOSAL_TYPE})`,
        isNull(proposals.stepRunId),
        userVisibleWhere(proposals.workspaceId, userId),
        exactRunId
          ? or(
              eq(proposals.correlationId, exactRunId),
              eq(proposals.id, exactRunId)
            )
          : undefined,
        scope.workspaceId
          ? eq(proposals.workspaceId, scope.workspaceId)
          : undefined,
        scope.projectId ? eq(proposals.projectId, scope.projectId) : undefined
      )
    )
    .orderBy(desc(proposals.createdAt))
    .limit(limit);

  return rows.map((r) => {
    const data = (r.data ?? {}) as Record<string, unknown>;
    // The model sometimes volunteers a rationale on an auto-approved write
    // (permission-check threads it into `data.reasoning`) — it is the single
    // most useful line to show, so prefer it over the bare action label.
    const reasoning =
      typeof data.reasoning === "string" && data.reasoning
        ? (data.reasoning as string)
        : null;
    return {
      // Mirrors capture: the correlationId IS the run's identity when present.
      id: r.correlationId ?? r.id,
      flowType: "agent_write" as const,
      flowId: null,
      flowName: r.proposalType,
      status: "completed" as const,
      startedAt: r.createdAt,
      completedAt: r.createdAt,
      // A write receipt is instantaneous — never "running".
      lastActivityAt: null,
      workspaceId: r.workspaceId ?? null,
      projectId: r.projectId ?? null,
      subjectEntityId: null,
      channelId: null,
      correlationId: r.correlationId ?? null,
      replayOf: null,
      summary: reasoning ?? r.proposalType,
      error: null,
      // The AGENT is what did this — the whole point of the flow type.
      triggeredBy: r.agentUserId ?? null,
      stepsCompleted: null,
      stepsFailed: null,
      definitionVersion: null,
    };
  });
}

async function listSessionRuns(
  userId: string,
  scope: RunScope,
  limit: number,
  status?: RunStatus,
  exactRunId?: string
): Promise<UnifiedRun[]> {
  const statusValues = status ? sessionStatusValues(status) : null;
  if (statusValues && statusValues.length === 0) return [];
  // Sessions that carry their OWN story — i.e. have NO playbook_runs row. This
  // covers both standalone agent/interactive sessions AND playbook-linked sessions
  // whose run row was never written (safety fallback, Wave 3.F/C): without this a
  // session with a playbookId but no run row is invisible in BOTH ledgers. Sessions
  // that DO have a run row surface via listPlaybookRuns and are excluded here via
  // the LEFT JOIN (no double-count). Automation-origin sessions are still excluded
  // by metadata (they surface via the automation ledger).
  const rows = await db
    .select({
      id: focusSessions.id,
      goal: focusSessions.goal,
      status: focusSessions.status,
      startedAt: focusSessions.startedAt,
      closedAt: focusSessions.closedAt,
      workspaceId: focusSessions.workspaceId,
      projectId: focusSessions.projectId,
      subjectEntityId: focusSessions.subjectEntityId,
      channelId: focusSessions.channelId,
      // Every real step on a session touches updated_at — this is the only
      // minutes-scale "is it still moving?" signal a session ledger carries.
      lastActivityAt: focusSessions.updatedAt,
    })
    .from(focusSessions)
    .leftJoin(playbookRuns, eq(playbookRuns.sessionId, focusSessions.id))
    .where(
      and(
        // focus_sessions is ownerPrivate — a NULL workspace is personal to
        // `userId`, so owner-gate that branch (bare userVisibleWhere would leak
        // every user's private standalone sessions to all callers).
        ownerPrivateVisibleWhere(
          focusSessions.workspaceId,
          focusSessions.userId,
          userId
        ),
        exactRunId ? eq(focusSessions.id, exactRunId) : undefined,
        // No run row references this session → it is not double-counted by the
        // playbook ledger, so surface it here (see block comment above).
        isNull(playbookRuns.id),
        // metadata.automationId absent → not an automation-origin run session
        // (those already surface via the automation ledger — no double-count).
        drizzleSql`${focusSessions.metadata}->>'automationId' IS NULL`,
        statusValues ? inArray(focusSessions.status, statusValues) : undefined,
        scope.workspaceId
          ? eq(focusSessions.workspaceId, scope.workspaceId)
          : undefined,
        scope.projectId
          ? eq(focusSessions.projectId, scope.projectId)
          : undefined,
        scope.subjectEntityId
          ? eq(focusSessions.subjectEntityId, scope.subjectEntityId)
          : undefined
      )
    )
    .orderBy(desc(focusSessions.startedAt))
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    flowType: "session" as const,
    flowId: null,
    flowName: r.goal ?? "Session",
    status: sessionStatus(r.status),
    startedAt: r.startedAt,
    completedAt: r.closedAt ?? null,
    lastActivityAt: r.lastActivityAt ?? null,
    workspaceId: r.workspaceId ?? null,
    projectId: r.projectId ?? null,
    subjectEntityId: r.subjectEntityId ?? null,
    channelId: r.channelId ?? null,
    correlationId: null,
    replayOf: null,
    summary: null,
    error: null,
    triggeredBy: null,
    stepsCompleted: null,
    stepsFailed: null,
    definitionVersion: null,
  }));
}

/**
 * A chat run = one `chat_turns` row (browser `channels.sendMessage` or Discord
 * `/discord/agent-turn`). USER-floored on `chat_turns.userId` (the acting
 * principal). Workspace lens joins `channels`. No project/entity subject —
 * those scopes return empty (same as capability).
 *
 * GLOBAL diagnose only cares about failed + stuck (running past threshold);
 * successful Discord pings stay off the stuck/failed sections. Callers can
 * still list every turn via `listRuns({ flowType: "chat" })`.
 */
async function listChatRuns(
  userId: string,
  scope: RunScope,
  limit: number,
  status?: RunStatus,
  exactRunId?: string
): Promise<UnifiedRun[]> {
  if (scope.projectId || scope.subjectEntityId) return [];
  const statusValues = status ? chatStatusValues(status) : null;
  if (statusValues && statusValues.length === 0) return [];

  const rows = await db
    .select({
      id: chatTurns.id,
      status: chatTurns.status,
      startedAt: chatTurns.startedAt,
      completedAt: chatTurns.completedAt,
      channelId: chatTurns.channelId,
      lastActivityAt: chatTurns.updatedAt,
      error: chatTurns.error,
      workspaceId: channels.workspaceId,
      channelTitle: channels.title,
    })
    .from(chatTurns)
    .innerJoin(channels, eq(channels.id, chatTurns.channelId))
    .where(
      and(
        eq(chatTurns.userId, userId),
        exactRunId ? eq(chatTurns.id, exactRunId) : undefined,
        statusValues ? inArray(chatTurns.status, statusValues) : undefined,
        scope.workspaceId
          ? eq(channels.workspaceId, scope.workspaceId)
          : undefined
      )
    )
    .orderBy(desc(chatTurns.startedAt))
    .limit(limit);

  return rows.map((r) => {
    const turnShort = r.id.slice(0, 8);
    const room = (r.channelTitle || "").trim();
    // Primary label: channel title when present, else "AI turn · ab12cd34"
    // so Failed lists are not a wall of identical "Chat" rows.
    const flowName = room
      ? room.length > 48
        ? `${room.slice(0, 45)}…`
        : room
      : `AI turn · ${turnShort}`;
    const err = r.error?.trim() || null;
    return {
      id: r.id,
      flowType: "chat" as const,
      flowId: null,
      flowName,
      status: chatRunStatus(r.status),
      startedAt: r.startedAt,
      completedAt: r.completedAt ?? null,
      lastActivityAt: r.lastActivityAt ?? null,
      workspaceId: r.workspaceId ?? null,
      projectId: null,
      subjectEntityId: null,
      channelId: r.channelId,
      correlationId: null,
      replayOf: null,
      summary: err
        ? err.length > 120
          ? `${err.slice(0, 117)}…`
          : err
        : `Chat turn ${turnShort}`,
      error: err,
      triggeredBy: userId,
      stepsCompleted: null,
      stepsFailed: null,
      definitionVersion: null,
    };
  });
}

// ── Public: list (merged cross-flow feed) ────────────────────────────────────

/**
 * List runs across flows (or one flow), newest first. USER-floored. When
 * `flowType` is set only that ledger is read; otherwise all ledgers are merged.
 */
export async function listRuns(input: ListRunsInput): Promise<UnifiedRun[]> {
  const { userId, flowType, flowId, status } = input;
  const scope = input.scope ?? {};
  const perFlow = Math.min(input.limit ?? 25, 100);

  // Automation runs have no project lens, but do carry a durable entity subject.
  // Only a project focus excludes them; entity focus is filtered in
  // `listAutomationRuns` like every other ledger.
  const automationExcluded = !!scope.projectId;

  const jobs: Array<Promise<UnifiedRun[]>> = [];
  if ((!flowType || flowType === "automation") && !automationExcluded)
    jobs.push(listAutomationRuns(userId, flowId, scope, perFlow, status));
  if (!flowType || flowType === "playbook")
    jobs.push(listPlaybookRuns(userId, flowId, scope, perFlow, status));
  // capture/capability/session/chat have no per-flow id, so a flowId filter
  // excludes them.
  if ((!flowType || flowType === "capture") && !flowId)
    jobs.push(listCaptureRuns(userId, scope, perFlow, status));
  if ((!flowType || flowType === "capability") && !flowId)
    jobs.push(listCapabilityRuns(userId, scope, perFlow, status));
  if ((!flowType || flowType === "session") && !flowId)
    jobs.push(listSessionRuns(userId, scope, perFlow, status));
  if ((!flowType || flowType === "agent_write") && !flowId)
    jobs.push(listAgentWriteRuns(userId, scope, perFlow, status));
  // Chat in the merged feed only when the caller is looking for trouble
  // (running/failed) or explicitly filters flowType=chat — avoids flooding the
  // Activity feed with every successful Discord ping. Explicit flowType=chat
  // still lists all statuses (completed included).
  const includeChat =
    flowType === "chat" ||
    (!flowType && !flowId && (status === "running" || status === "failed"));
  if (includeChat) jobs.push(listChatRuns(userId, scope, perFlow, status));

  const merged = (await Promise.all(jobs)).flat();
  // Dedupe by (flowType,id) — a defensive guard against a run row being
  // multiplied by a 1:many join (e.g. a rare duplicate automation channel).
  const seen = new Set<string>();
  const unique = merged.filter((r) => {
    const key = `${r.flowType}:${r.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  unique.sort(byStartedAtDesc);
  return unique.slice(0, perFlow);
}

// ── Public: run GROUPS (one row per template/flow) ───────────────────────────

export interface ListRunGroupsInput {
  userId: string;
  /** Restrict to one flow ledger; omit for automation + playbook merged. */
  flowType?: "automation" | "playbook";
  /** Narrow to a workspace lens (within the user floor). */
  scope?: { workspaceId?: string };
  /** Cap on groups returned (newest-active first). */
  limit?: number;
  /** Opaque keyset cursor returned by `listRunGroupsPage`. */
  cursor?: string;
}

/**
 * Runs collapsed to ONE row per flow (automation / playbook), newest-active
 * first. USER-floored via the SAME `userVisibleWhere` predicate `listRuns` uses,
 * so a group never counts a run the user can't see. Each ledger is grouped in the
 * DB (GROUP BY flowId) — the counts + latest run are exact over the whole ledger,
 * never a client fold over a truncated page. capture/session runs have no flowId
 * and are intentionally absent (they stay individual rows in the feed).
 */
export async function listRunGroups(
  input: ListRunGroupsInput
): Promise<RunGroup[]> {
  return (await listRunGroupsPage(input)).groups;
}

export interface RunGroupsPage {
  groups: RunGroup[];
  nextCursor: string | null;
}

/**
 * Keyset-paginated variant of `listRunGroups`. Sort is deterministic across the
 * two ledgers: latest start descending, then flow kind and flow id ascending.
 */
export async function listRunGroupsPage(
  input: ListRunGroupsInput
): Promise<RunGroupsPage> {
  const { userId, flowType } = input;
  const scope = input.scope ?? {};
  const limit = Math.min(input.limit ?? 50, 100);
  const cursor = input.cursor ? decodeRunGroupCursor(input.cursor) : undefined;

  const jobs: Array<Promise<RunGroup[]>> = [];
  if (!flowType || flowType === "automation")
    jobs.push(
      groupAutomationRuns(userId, scope.workspaceId, limit + 1, cursor)
    );
  if (!flowType || flowType === "playbook")
    jobs.push(groupPlaybookRuns(userId, scope.workspaceId, limit + 1, cursor));

  const merged = (await Promise.all(jobs)).flat();
  merged.sort((a, b) => {
    const time = b.latestStartedAt.getTime() - a.latestStartedAt.getTime();
    if (time !== 0) return time;
    const kind = a.flowType.localeCompare(b.flowType);
    return kind !== 0 ? kind : a.flowId.localeCompare(b.flowId);
  });
  const hasNextPage = merged.length > limit;
  const groups = hasNextPage ? merged.slice(0, limit) : merged;
  const last = groups.at(-1);
  return {
    groups,
    nextCursor:
      hasNextPage && last
        ? encodeRunGroupCursor({
            at: last.latestStartedAt,
            flowType: last.flowType,
            id: last.flowId,
          })
        : null,
  };
}

async function groupAutomationRuns(
  userId: string,
  workspaceId: string | undefined,
  limit: number,
  cursor?: RunGroupCursor
): Promise<RunGroup[]> {
  const latest = drizzleSql<Date>`max(${automationRuns.startedAt})`;
  const afterCursor = cursor
    ? cursor.flowType === "automation"
      ? or(
          lt(latest, new Date(cursor.at)),
          and(
            eq(latest, new Date(cursor.at)),
            gt(automationRuns.automationId, cursor.id)
          )
        )
      : lt(latest, new Date(cursor.at))
    : undefined;
  const rows = await db
    .select({
      flowId: automationRuns.automationId,
      flowName: automations.name,
      runCount: drizzleSql<number>`count(*)::int`,
      completedCount: drizzleSql<number>`(count(*) filter (where ${automationRuns.status} = 'completed'))::int`,
      // A policy-block still needs a human's eye, so it counts toward the
      // needs-attention 'failed' rollup alongside genuine failures (the run-detail
      // surface renders the two with distinct calm/red tones).
      failedCount: drizzleSql<number>`(count(*) filter (where ${automationRuns.status} in ('failed', 'blocked_by_policy')))::int`,
      hasRunning: drizzleSql<boolean>`bool_or(${automationRuns.status} = 'running')`,
      latestStartedAt: drizzleSql<Date>`max(${automationRuns.startedAt})`,
      latestRunId: drizzleSql<string>`(array_agg(${automationRuns.id} order by ${automationRuns.startedAt} desc, ${automationRuns.id} asc))[1]`,
      latestStatus: drizzleSql<string>`(array_agg(${automationRuns.status} order by ${automationRuns.startedAt} desc, ${automationRuns.id} asc))[1]`,
    })
    .from(automationRuns)
    .innerJoin(automations, eq(automations.id, automationRuns.automationId))
    .where(
      and(
        userVisibleWhere(automationRuns.workspaceId, userId),
        workspaceId ? eq(automationRuns.workspaceId, workspaceId) : undefined
      )
    )
    .groupBy(automationRuns.automationId, automations.name)
    .having(afterCursor)
    .orderBy(desc(latest), asc(automationRuns.automationId))
    .limit(limit);

  return rows.map((r) => ({
    flowType: "automation" as const,
    flowId: r.flowId,
    flowName: r.flowName ?? "Automation",
    runCount: r.runCount,
    latestRunId: r.latestRunId,
    latestStatus: r.latestStatus as RunStatus,
    // `max(startedAt)` is a RAW SQL aggregate — postgres.js returns it as a
    // STRING, not a Date (the `drizzleSql<Date>` above is a compile-time cast
    // only). Coerce so `latestStartedAt` really is the `Date` its type claims;
    // without it the `.getTime()` sort in listRunGroups throws at runtime.
    latestStartedAt: new Date(r.latestStartedAt),
    hasRunning: r.hasRunning ?? false,
    completedCount: r.completedCount,
    failedCount: r.failedCount,
  }));
}

async function groupPlaybookRuns(
  userId: string,
  workspaceId: string | undefined,
  limit: number,
  cursor?: RunGroupCursor
): Promise<RunGroup[]> {
  const latest = drizzleSql<Date>`max(${playbookRuns.startedAt})`;
  const afterCursor = cursor
    ? cursor.flowType === "playbook"
      ? or(
          lt(latest, new Date(cursor.at)),
          and(
            eq(latest, new Date(cursor.at)),
            gt(playbookRuns.playbookId, cursor.id)
          )
        )
      : or(lt(latest, new Date(cursor.at)), eq(latest, new Date(cursor.at)))
    : undefined;
  const rows = await db
    .select({
      flowId: playbookRuns.playbookId,
      flowName: playbooks.name,
      runCount: drizzleSql<number>`count(*)::int`,
      completedCount: drizzleSql<number>`(count(*) filter (where ${playbookRuns.status} = 'completed'))::int`,
      failedCount: drizzleSql<number>`(count(*) filter (where ${playbookRuns.status} = 'failed'))::int`,
      hasRunning: drizzleSql<boolean>`bool_or(${playbookRuns.status} = 'running')`,
      latestStartedAt: drizzleSql<Date>`max(${playbookRuns.startedAt})`,
      latestRunId: drizzleSql<string>`(array_agg(${playbookRuns.id} order by ${playbookRuns.startedAt} desc, ${playbookRuns.id} asc))[1]`,
      latestStatus: drizzleSql<string>`(array_agg(${playbookRuns.status} order by ${playbookRuns.startedAt} desc, ${playbookRuns.id} asc))[1]`,
    })
    .from(playbookRuns)
    .innerJoin(playbooks, eq(playbooks.id, playbookRuns.playbookId))
    .where(
      and(
        userVisibleWhere(playbookRuns.workspaceId, userId),
        workspaceId ? eq(playbookRuns.workspaceId, workspaceId) : undefined
      )
    )
    .groupBy(playbookRuns.playbookId, playbooks.name)
    .having(afterCursor)
    .orderBy(desc(latest), asc(playbookRuns.playbookId))
    .limit(limit);

  return rows.map((r) => ({
    flowType: "playbook" as const,
    flowId: r.flowId,
    flowName: r.flowName ?? "Playbook",
    runCount: r.runCount,
    latestRunId: r.latestRunId,
    latestStatus: r.latestStatus as RunStatus,
    // `max(startedAt)` is a RAW SQL aggregate — postgres.js returns it as a
    // STRING, not a Date (the `drizzleSql<Date>` above is a compile-time cast
    // only). Coerce so `latestStartedAt` really is the `Date` its type claims;
    // without it the `.getTime()` sort in listRunGroups throws at runtime.
    latestStartedAt: new Date(r.latestStartedAt),
    hasRunning: r.hasRunning ?? false,
    completedCount: r.completedCount,
    failedCount: r.failedCount,
  }));
}

// ── Public: get one run + its activity timeline ──────────────────────────────

export interface GetRunInput {
  userId: string;
  flowType: FlowType;
  /** The run id (ledger row id, or captureId/correlationId for capture). */
  id: string;
}

/**
 * One run + its flow-agnostic activity timeline. Rich timelines: automation
 * steps, capture decision/trace events. Playbook/session runs carry a channelId
 * — their message-level story is the channel, opened by the UI (not duplicated).
 */
export async function getRun(
  input: GetRunInput
): Promise<UnifiedRunDetail | null> {
  const { userId, flowType, id } = input;

  if (flowType === "automation") {
    const [run] = await listAutomationRuns(
      userId,
      undefined,
      {},
      1,
      undefined,
      id
    );
    if (!run) return null;
    const steps = await db
      .select()
      .from(automationStepRuns)
      .where(eq(automationStepRuns.runId, run.id));
    // Detail-only fields not carried on the list-row: the full trigger payload,
    // the complete outputSummary JSONB (list keeps only outputSummary.summary),
    // and the definition snapshot — the source of the human node labels.
    const [meta] = await db
      .select({
        triggerPayload: automationRuns.triggerPayload,
        outputSummary: automationRuns.outputSummary,
        definitionSnapshot: automationRuns.definitionSnapshot,
        pathTaken: automationRuns.pathTaken,
      })
      .from(automationRuns)
      .where(eq(automationRuns.id, run.id))
      .limit(1);
    // nodeId → human label / node type, from the snapshot the run executed (no
    // new query — the snapshot rides on the run row). Falls back to the nodeId
    // per step; nodeType is null where the snapshot has none.
    const definitionSnapshot = parseRunDefinitionSnapshot(
      meta?.definitionSnapshot
    );
    const pathTaken = parseRunPathTaken(meta?.pathTaken);
    const nodeLabelById = buildNodeLabelMap(definitionSnapshot);
    const nodeTypeById = buildNodeTypeMap(definitionSnapshot);
    const activity: AutomationStepActivityItem[] = steps
      .map((s) => {
        const nodeLabel = nodeLabelById.get(s.nodeId) ?? null;
        return {
          id: s.id,
          at: s.completedAt ?? s.startedAt ?? null,
          kind: "step" as const,
          status: s.status,
          // Human node name where the snapshot has one; the node id otherwise.
          label: nodeLabel ?? s.nodeId,
          hint: s.errorMessage ?? null,
          detail: {
            output: s.output,
            resolvedInputs: s.resolvedInputs,
            // Per-step timing for the RunDetailPanel duration bars.
            startedAt: s.startedAt,
            completedAt: s.completedAt,
            // Per-node drill: raw id + resolved label + the command (if any).
            nodeId: s.nodeId,
            nodeLabel,
            commandId: s.commandId ?? null,
            // AI diagnose payload (RunDetailPanel's "Explain failure"): the
            // step's own error and its node type from the snapshot.
            errorMessage: s.errorMessage ?? null,
            nodeType: nodeTypeById.get(s.nodeId) ?? null,
            // AI telemetry across the pod↔IS seam (0224). NULL on a non-AI
            // step, and on any step run before the IS started returning it.
            // `finishReason` is what turns `out (empty)` from a dead end into
            // an answer — `length` = truncated, `content-filter` = refused,
            // `stop` + tokensOut 0 = the model said nothing.
            finishReason: s.finishReason ?? null,
            tokensIn: s.tokensIn ?? null,
            tokensOut: s.tokensOut ?? null,
            tokensUsed: s.tokensUsed ?? null,
          },
        };
      })
      .sort(byAtAsc);
    return {
      run: { ...run, flowType: "automation" },
      activity,
      trigger: {
        triggeredBy: run.triggeredBy,
        payload: meta?.triggerPayload ?? null,
      },
      outputSummary: meta?.outputSummary ?? null,
      playbookDetail: null,
      // The flow definition this run executed — lets the UI render the graph.
      definitionSnapshot,
      // Which edges of that graph the run actually walked. NULL = unknown
      // (pre-0214 run, or one that never executed a node) — not "nothing pruned".
      pathTaken,
    };
  }

  if (flowType === "capture") {
    const [run] = await listCaptureRuns(userId, {}, 1, undefined, id);
    if (!run || !run.correlationId)
      return run
        ? {
            run: { ...run, flowType: "capture" },
            activity: [],
            trigger: null,
            outputSummary: null,
            playbookDetail: null,
            definitionSnapshot: null,
            pathTaken: null,
          }
        : null;
    const rows = await db
      .select({
        id: events.id,
        at: events.timestamp,
        subjectType: events.subjectType,
        action: events.type,
        data: events.data,
      })
      .from(events)
      .where(
        and(
          eq(events.correlationId, run.correlationId),
          inArray(events.subjectType, [AI_DECISION, AI_PROCESSING])
        )
      );
    const activity: RunActivityItem[] = rows
      .map((e) => {
        const data = (e.data ?? {}) as Record<string, unknown>;
        const kind =
          typeof data.kind === "string" ? (data.kind as string) : e.subjectType;
        const reason =
          typeof data.reason === "string" ? (data.reason as string) : null;
        return {
          id: e.id,
          at: e.at ?? null,
          kind,
          status: null,
          label: reason ? `${e.action}: ${reason}` : e.action,
          hint:
            typeof data.fixHint === "string" ? (data.fixHint as string) : null,
          detail: data,
        };
      })
      .sort(byAtAsc);
    return {
      run: { ...run, flowType: "capture" },
      activity,
      trigger: null,
      outputSummary: null,
      playbookDetail: null,
      definitionSnapshot: null,
      pathTaken: null,
    };
  }

  // Mirrors the "capture" branch above (same correlationId-keyed event join) —
  // permission-check now writes correlationId as a COLUMN on the auto-approve
  // receipt, which is what makes the receipt joinable to its spine events at all.
  if (flowType === "agent_write") {
    const [run] = await listAgentWriteRuns(userId, {}, 1, undefined, id);
    if (!run) return null;
    const base = {
      trigger: null,
      outputSummary: null,
      playbookDetail: null,
      definitionSnapshot: null,
      pathTaken: null,
    } as const;
    if (!run.correlationId)
      return {
        run: { ...run, flowType: "agent_write" as const },
        activity: [],
        ...base,
      };
    const rows = await db
      .select({
        id: events.id,
        at: events.timestamp,
        subjectType: events.subjectType,
        action: events.type,
        data: events.data,
      })
      .from(events)
      .where(
        and(
          eq(events.correlationId, run.correlationId),
          eq(events.userId, userId)
        )
      );
    const activity: RunActivityItem[] = rows
      .map((e) => {
        const data = (e.data ?? {}) as Record<string, unknown>;
        return {
          id: e.id,
          at: e.at ?? null,
          kind:
            typeof data.kind === "string"
              ? (data.kind as string)
              : e.subjectType,
          status: null,
          label: e.action,
          hint:
            typeof data.fixHint === "string" ? (data.fixHint as string) : null,
          detail: data,
        };
      })
      .sort(byAtAsc);
    return {
      run: { ...run, flowType: "agent_write" as const },
      activity,
      ...base,
    };
  }

  // Mirrors the "capture" branch above verbatim (same correlationId-keyed
  // ai_decision/ai_processing join) — the executor stamps correlationId +
  // emits an ai_decision on approval (see approve-executors.ts's
  // `capability.run` executor).
  if (flowType === "capability") {
    const [run] = await listCapabilityRuns(userId, {}, 1, undefined, id);
    if (!run) return null;
    // A PROPOSAL-backed run stores its output in `data.runResult` on approval
    // (approve-executors.ts) — its `run.id` is the proposal row id. A DIRECT run
    // has NO proposal (`run.id` is its correlationId), and carries its output in
    // the `capability_run` event's `data.runResult` instead — read below.
    const [proposalRow] = await db
      .select({ data: proposals.data })
      .from(proposals)
      .where(eq(proposals.id, run.id))
      .limit(1);
    let runResult = (proposalRow?.data as Record<string, unknown> | null)
      ?.runResult;
    if (!run.correlationId)
      return {
        run: { ...run, flowType: "capability" },
        activity: [],
        trigger: null,
        outputSummary:
          runResult !== undefined ? boundRunResult(runResult) : null,
        playbookDetail: null,
        definitionSnapshot: null,
        pathTaken: null,
      };
    const rows = await db
      .select({
        id: events.id,
        at: events.timestamp,
        subjectType: events.subjectType,
        action: events.type,
        data: events.data,
      })
      .from(events)
      .where(
        and(
          eq(events.correlationId, run.correlationId),
          inArray(events.subjectType, [AI_DECISION, AI_PROCESSING])
        )
      );
    // DIRECT-run fallback: no proposal carried the output, so pull it off the
    // `capability_run` ai_decision event (executeCapability stamps a bounded copy
    // there). Proposal-backed runs keep the proposal value already read above.
    if (runResult === undefined) {
      for (const e of rows) {
        const d = (e.data ?? {}) as Record<string, unknown>;
        if (d.kind === CAPABILITY_RUN_EVENT_KIND && d.runResult !== undefined) {
          runResult = d.runResult;
          break;
        }
      }
    }
    const outputSummary =
      runResult !== undefined ? boundRunResult(runResult) : null;
    const activity: RunActivityItem[] = rows
      .map((e) => {
        const data = (e.data ?? {}) as Record<string, unknown>;
        const kind =
          typeof data.kind === "string" ? (data.kind as string) : e.subjectType;
        const reason =
          typeof data.reason === "string" ? (data.reason as string) : null;
        return {
          id: e.id,
          at: e.at ?? null,
          kind,
          status: null,
          label: reason ? `${e.action}: ${reason}` : e.action,
          hint:
            typeof data.fixHint === "string" ? (data.fixHint as string) : null,
          detail: data,
        };
      })
      .sort(byAtAsc);
    return {
      run: { ...run, flowType: "capability" },
      activity,
      trigger: null,
      outputSummary,
      playbookDetail: null,
      definitionSnapshot: null,
      pathTaken: null,
    };
  }

  if (flowType === "chat") {
    const [run] = await listChatRuns(userId, {}, 1, undefined, id);
    if (!run) return null;

    // Prefer durable chat_turn_events when present; fall back to the assistant
    // message's metadata.aiSteps (Discord agent-turn path does not always
    // append turn events, but does persist aiSteps on the reply).
    const eventRows = await db
      .select({
        id: chatTurnEvents.id,
        seq: chatTurnEvents.seq,
        type: chatTurnEvents.type,
        payload: chatTurnEvents.payload,
        createdAt: chatTurnEvents.createdAt,
      })
      .from(chatTurnEvents)
      .where(eq(chatTurnEvents.turnId, id));
    eventRows.sort((a, b) => a.seq - b.seq);

    let activity: RunActivityItem[];
    if (eventRows.length > 0) {
      activity = eventRows.map((e) => ({
        id: e.id,
        at: e.createdAt ?? null,
        kind: e.type,
        status: null,
        label: e.type,
        hint:
          typeof (e.payload as { error?: unknown } | null)?.error === "string"
            ? ((e.payload as { error: string }).error as string)
            : null,
        detail: e.payload ?? null,
      }));
    } else {
      const [turnMeta] = await db
        .select({
          assistantMessageId: chatTurns.assistantMessageId,
          error: chatTurns.error,
          status: chatTurns.status,
          startedAt: chatTurns.startedAt,
          completedAt: chatTurns.completedAt,
        })
        .from(chatTurns)
        .where(and(eq(chatTurns.id, id), eq(chatTurns.userId, userId)))
        .limit(1);

      const lifecycle: RunActivityItem = {
        id: run.id,
        at: turnMeta?.startedAt ?? run.startedAt,
        kind: "lifecycle",
        status: run.status,
        label: run.summary ?? run.flowName,
        hint: run.error ?? turnMeta?.error ?? null,
        detail: null,
      };

      let stepItems: RunActivityItem[] = [];
      if (turnMeta?.assistantMessageId) {
        const [msg] = await db
          .select({
            metadata: messages.metadata,
            timestamp: messages.timestamp,
          })
          .from(messages)
          .where(eq(messages.id, turnMeta.assistantMessageId))
          .limit(1);
        const meta = (msg?.metadata ?? {}) as {
          aiSteps?: Array<Record<string, unknown>>;
        };
        const steps = Array.isArray(meta.aiSteps) ? meta.aiSteps : [];
        stepItems = steps.map((s, i) => {
          const stepId =
            typeof s.id === "string" ? s.id : `${run.id}-step-${i}`;
          const toolName =
            typeof s.toolName === "string" ? s.toolName : undefined;
          const content = typeof s.content === "string" ? s.content : "";
          const stepType = typeof s.type === "string" ? s.type : "step";
          return {
            id: stepId,
            at: msg?.timestamp ?? run.startedAt,
            kind: stepType,
            status: typeof s.status === "string" ? s.status : null,
            label: toolName ?? (content.slice(0, 80) || stepType),
            hint: typeof s.error === "string" ? s.error : null,
            detail: s,
          };
        });
      }
      activity = [...stepItems, lifecycle].sort(byAtAsc);
    }

    return {
      run: { ...run, flowType: "chat" },
      activity,
      trigger: null,
      outputSummary: null,
      playbookDetail: null,
      definitionSnapshot: null,
      pathTaken: null,
    };
  }

  // playbook / session — the run's story is its channel; return the run with a
  // single lifecycle marker (the UI opens `run.channelId` for the messages).
  const [run] =
    flowType === "playbook"
      ? await listPlaybookRuns(userId, undefined, {}, 1, undefined, id)
      : await listSessionRuns(userId, {}, 1, undefined, id);
  if (!run) return null;
  const activity: RunActivityItem[] = [
    {
      id: run.id,
      at: run.startedAt,
      kind: "lifecycle",
      status: run.status,
      label: run.summary ?? run.flowName,
      hint: run.error ?? null,
      detail: null,
    },
  ];
  // Playbook runs get the rich per-kind footprint: produced / proposals / agents
  // / session card. Session runs (no playbook_run row) keep the lifecycle-only
  // shape — their story is their channel.
  const playbookDetail =
    flowType === "playbook"
      ? await loadPlaybookRunDetail(userId, run.id)
      : null;
  return {
    run: { ...run, flowType },
    activity,
    trigger: null,
    outputSummary: null,
    playbookDetail,
    definitionSnapshot: null,
    pathTaken: null,
  };
}

// ── Playbook run detail (produced / proposals / agents / session card) ────────

/** Per-derivation caps — one run's detail stays a handful of bounded queries. */
const RUN_PRODUCED_CAP = 200;
const RUN_PROPOSAL_CAP = 50;
const RUN_MESSAGE_SCAN_CAP = 500;

/**
 * A playbook run's rich footprint. The run's ONE session (playbook → one session
 * per run) is the derivation anchor; every list is user-floored and capped.
 */
async function loadPlaybookRunDetail(
  userId: string,
  runId: string
): Promise<PlaybookRunDetail> {
  // The run's session card — user-floored (defense in depth; the run already is).
  const [sess] = await db
    .select({
      id: focusSessions.id,
      goal: focusSessions.goal,
      status: focusSessions.status,
      currentStage: focusSessions.currentStage,
      progress: focusSessions.progress,
      expectedOutputs: focusSessions.expectedOutputs,
      verificationReport: focusSessions.verificationReport,
      channelId: focusSessions.channelId,
    })
    .from(playbookRuns)
    .innerJoin(focusSessions, eq(focusSessions.id, playbookRuns.sessionId))
    .where(
      and(
        eq(playbookRuns.id, runId),
        // focus_sessions is ownerPrivate — owner-gate the NULL-workspace branch
        // (defense in depth; the run row is already floored).
        ownerPrivateVisibleWhere(
          focusSessions.workspaceId,
          focusSessions.userId,
          userId
        )
      )
    )
    .limit(1);

  if (!sess) return { session: null, produced: [], proposals: [], agents: [] };

  const [produced, proposalResult] = await Promise.all([
    loadRunProduced([sess.id], userId),
    loadRunProposals(sess.id, userId),
  ]);
  const agents = await loadRunAgents(
    sess.channelId ?? null,
    proposalResult.agentUserIds
  );

  return {
    session: {
      id: sess.id,
      goal: sess.goal,
      status: sess.status,
      currentStage: sess.currentStage ?? null,
      progress: sess.progress ?? null,
      expectedOutputs: sess.expectedOutputs ?? null,
      verificationReport: sess.verificationReport ?? null,
      channelId: sess.channelId ?? null,
    },
    produced,
    proposals: proposalResult.items,
    agents,
  };
}

/**
 * Entities the session produced — the SAME `session --produced--> entity` query
 * shape workflow-place's loadResults uses. Only entities the user can still see
 * (visible + not deleted) are surfaced.
 */
async function loadRunProduced(
  sessionIds: string[],
  userId: string
): Promise<RunProducedEntity[]> {
  if (sessionIds.length === 0) return [];
  const edges = await db
    .select({ toId: links.toId, createdAt: links.createdAt })
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
    .limit(RUN_PRODUCED_CAP);
  if (edges.length === 0) return [];

  const entityIds = [...new Set(edges.map((e) => e.toId))];
  const rows = await db
    .select({ id: entities.id, title: entities.title, type: entities.type })
    .from(entities)
    .where(
      and(
        inArray(entities.id, entityIds),
        isNull(entities.deletedAt),
        // `entities` is ownerPrivate — bare `userVisibleWhere` admits pod-wide
        // NULL-workspace rows to ALL users. Use the canonical entity READ floor
        // (owner-gated NULL + membership + exposure + role-lens), identical to
        // entities.list, so a produced-entity title never leaks cross-tenant.
        accessScopeWhere({
          workspaceIdColumn: entities.workspaceId,
          entityIdColumn: entities.id,
          ownerColumn: entities.userId,
          userId,
          facetLens: true,
        })
      )
    );
  const byId = new Map(rows.map((r) => [r.id, r]));

  const out: RunProducedEntity[] = [];
  for (const e of edges) {
    const ent = byId.get(e.toId);
    if (!ent) continue;
    out.push({
      entityId: ent.id,
      title: ent.title ?? null,
      type: ent.type,
      producedAt: e.createdAt,
    });
  }
  return out;
}

/**
 * The proposalType → compact change class map. Honest: only where the vocabulary
 * carries a create/update/delete intent. Unknowns (capability.run,
 * messaging.external.send, run, join, import.graph, vault.request, …) map to
 * null and the caller reads the raw proposalType.
 */
function deriveChangeKind(
  proposalType: string
): "create" | "update" | "delete" | null {
  const t = proposalType.toLowerCase();
  if (t === "delete" || t.startsWith("delete") || t.endsWith(".delete"))
    return "delete";
  if (
    t === "create" ||
    t === "create_composite" ||
    // Structured imports create entities (import-orchestrator stamps
    // "import.graph" with the sessionId set, so it reaches this ledger).
    t === "import.graph" ||
    t.startsWith("create") ||
    t.endsWith(".create")
  )
    return "create";
  if (
    t === "update" ||
    t === "edit" ||
    t === "ai_edit" ||
    t === "user_edit" ||
    t === "merge" ||
    t.endsWith(".update") ||
    t.endsWith(".edit")
  )
    return "update";
  return null;
}

/**
 * The session's proposals — the created/updated/removed ledger, capped. Mirrors
 * workflow-place's loadProposals shape; also harvests the distinct agent-user
 * ids (proposals.agentUserId) so the caller can resolve "who worked it".
 */
async function loadRunProposals(
  sessionId: string,
  userId: string
): Promise<{ items: RunProposalItem[]; agentUserIds: string[] }> {
  const rows = await db
    .select({
      id: proposals.id,
      proposalType: proposals.proposalType,
      status: proposals.status,
      targetType: proposals.targetType,
      targetId: proposals.targetId,
      rejectionReason: proposals.rejectionReason,
      revisionHistory: proposals.revisionHistory,
      agentUserId: proposals.agentUserId,
      createdAt: proposals.createdAt,
      reviewedAt: proposals.reviewedAt,
    })
    .from(proposals)
    .where(
      and(
        eq(proposals.sessionId, sessionId),
        userVisibleWhere(proposals.workspaceId, userId)
      )
    )
    .orderBy(desc(proposals.createdAt))
    .limit(RUN_PROPOSAL_CAP);

  const agentUserIds = [
    ...new Set(rows.map((r) => r.agentUserId).filter((x): x is string => !!x)),
  ];
  const items: RunProposalItem[] = rows.map((r) => ({
    id: r.id,
    proposalType: r.proposalType,
    changeKind: deriveChangeKind(r.proposalType),
    status: r.status,
    targetType: r.targetType,
    targetId: r.targetId,
    rejectionReason: r.rejectionReason ?? null,
    revisionCount: Array.isArray(r.revisionHistory)
      ? r.revisionHistory.length
      : 0,
    createdAt: r.createdAt,
    reviewedAt: r.reviewedAt ?? null,
  }));
  return { items, agentUserIds };
}

/**
 * Best-effort distinct actors who worked the run. Two reliable agent-user
 * signals are unioned: proposal authors (proposals.agentUserId, FK-backed) and
 * routed AI-agent message authors (messages.routedTeammateId) in the run's
 * channel. Plain AI-agent messages are excluded — their `userId` is the
 * requesting owner, not the agent. Names resolve via the same fields the
 * proposal review UI uses (name / agentType / email); unresolved ids get a null
 * name rather than being dropped.
 */
async function loadRunAgents(
  channelId: string | null,
  proposalAgentIds: string[]
): Promise<RunAgent[]> {
  const sources = new Map<string, Set<"proposal" | "message">>();
  const mark = (id: string, src: "proposal" | "message") => {
    let set = sources.get(id);
    if (!set) sources.set(id, (set = new Set()));
    set.add(src);
  };
  for (const id of proposalAgentIds) mark(id, "proposal");

  if (channelId) {
    // One bounded scan of the run's channel — routed AI-agent authors only.
    const authorRows = await db
      .selectDistinct({ teammateId: messages.routedTeammateId })
      .from(messages)
      .where(
        and(
          eq(messages.channelId, channelId),
          eq(messages.authorType, "ai_agent"),
          isNull(messages.deletedAt),
          drizzleSql`${messages.routedTeammateId} IS NOT NULL`
        )
      )
      .limit(RUN_MESSAGE_SCAN_CAP);
    for (const r of authorRows) if (r.teammateId) mark(r.teammateId, "message");
  }

  const ids = [...sources.keys()];
  if (ids.length === 0) return [];

  const userRows = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      userType: users.userType,
      agentType: users.agentType,
      agentMetadata: users.agentMetadata,
    })
    .from(users)
    .where(inArray(users.id, ids));
  const byId = new Map(userRows.map((u) => [u.id, u]));

  return ids.map((id) => {
    const u = byId.get(id);
    const set = sources.get(id)!;
    const source: RunAgent["source"] =
      set.has("proposal") && set.has("message")
        ? "both"
        : set.has("proposal")
          ? "proposal"
          : "message";
    return { id, name: u ? runAgentDisplayName(u) : null, source };
  });
}

/** Same precedence the proposal review UI uses: name → agentType → email. */
function runAgentDisplayName(row: {
  name: string | null;
  email: string;
  userType: string;
  agentType: string | null;
  agentMetadata: { agentType?: string; description?: string } | null;
}): string | null {
  if (row.name) return row.name;
  if (row.userType === "agent")
    return (
      row.agentType ??
      row.agentMetadata?.agentType ??
      row.agentMetadata?.description ??
      row.email ??
      null
    );
  return row.email || null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFinitePosition(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.x === "number" &&
    Number.isFinite(value.x) &&
    typeof value.y === "number" &&
    Number.isFinite(value.y)
  );
}

function isAutomationNode(value: unknown): value is AutomationNode {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    isAutomationNodeType(value.type) &&
    isFinitePosition(value.position) &&
    isRecord(value.data)
  );
}

function isFlowDefinition(value: unknown): value is FlowDefinition {
  if (!isRecord(value)) return false;
  if (!Array.isArray(value.nodes) || !value.nodes.every(isAutomationNode)) {
    return false;
  }
  if (
    !Array.isArray(value.edges) ||
    !value.edges.every(
      (edge) =>
        isRecord(edge) &&
        typeof edge.id === "string" &&
        typeof edge.source === "string" &&
        typeof edge.target === "string"
    )
  ) {
    return false;
  }
  return (
    value.precondition === undefined || typeof value.precondition === "string"
  );
}

/**
 * Validate JSONB at the service boundary. Drizzle's `$type` is compile-time
 * only, while old imports and direct database writes can still carry malformed
 * shapes. Returning null keeps the UI honest: no trustworthy snapshot means no
 * graph, rather than a crash or a graph of the current definition.
 */
export function parseRunDefinitionSnapshot(
  value: unknown
): RunDefinitionSnapshot | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.version !== "number" ||
    !Number.isInteger(value.version) ||
    value.version < 1 ||
    !isFlowDefinition(value.flowDefinition) ||
    !validateFlowDefinition(value.flowDefinition).valid
  ) {
    return null;
  }
  return {
    version: value.version,
    flowDefinition: value.flowDefinition,
  };
}

/**
 * Validate path evidence independently from the definition snapshot. `null`
 * means unknown; empty arrays are meaningful and therefore preserved.
 */
export function parseRunPathTaken(value: unknown): RunPathTaken | null {
  if (!isRecord(value)) return null;
  if (
    !Array.isArray(value.traversedEdgeIds) ||
    !value.traversedEdgeIds.every((id) => typeof id === "string") ||
    !Array.isArray(value.prunedEdgeIds) ||
    !value.prunedEdgeIds.every((id) => typeof id === "string")
  ) {
    return null;
  }
  return {
    traversedEdgeIds: [...new Set(value.traversedEdgeIds)],
    prunedEdgeIds: [...new Set(value.prunedEdgeIds)],
  };
}

/**
 * nodeId → human label from an automation run's definition snapshot. Tolerant of
 * a missing/partial snapshot (returns an empty map). Prefers `data.label`, then
 * a command node's `commandTitle`, then a generic `name`.
 */
export function buildNodeLabelMap(
  snapshot: { flowDefinition?: { nodes?: unknown } | null } | null | undefined
): Map<string, string> {
  const map = new Map<string, string>();
  const nodes = snapshot?.flowDefinition?.nodes;
  if (!Array.isArray(nodes)) return map;
  for (const n of nodes) {
    if (!n || typeof n !== "object") continue;
    const node = n as { id?: unknown; data?: Record<string, unknown> };
    if (typeof node.id !== "string") continue;
    const d = node.data ?? {};
    const label =
      (typeof d.label === "string" && d.label) ||
      (typeof d.commandTitle === "string" && d.commandTitle) ||
      (typeof d.name === "string" && d.name) ||
      null;
    if (label) map.set(node.id, label);
  }
  return map;
}

/**
 * nodeId → node type (e.g. "command", "condition") from an automation run's
 * definition snapshot. Same tolerance/shape as `buildNodeLabelMap` — reads the
 * top-level `node.type` (the `AutomationNodeBase.type` union in
 * schema/automations.ts), not `node.data`.
 */
export function buildNodeTypeMap(
  snapshot: { flowDefinition?: { nodes?: unknown } | null } | null | undefined
): Map<string, AutomationNode["type"]> {
  const map = new Map<string, AutomationNode["type"]>();
  const nodes = snapshot?.flowDefinition?.nodes;
  if (!Array.isArray(nodes)) return map;
  for (const n of nodes) {
    if (!n || typeof n !== "object") continue;
    const node = n as { id?: unknown; type?: unknown };
    if (typeof node.id !== "string") continue;
    if (isAutomationNodeType(node.type)) map.set(node.id, node.type);
  }
  return map;
}

const AUTOMATION_NODE_TYPES: ReadonlySet<AutomationNode["type"]> = new Set([
  "trigger",
  "command",
  "condition",
  "delay",
  "output",
  "loop",
  "transform",
  "fetch",
  "query",
  "messages_query",
  "runs_query",
  "proposals_query",
  "switch",
  "skill",
  "capability",
  "sub_automation",
  "playbook_run",
  "entity_read",
  "related_entities",
  "compute",
  "select",
  "claim",
  "guard",
]);

function isAutomationNodeType(value: unknown): value is AutomationNode["type"] {
  return (
    typeof value === "string" &&
    AUTOMATION_NODE_TYPES.has(value as AutomationNode["type"])
  );
}

// ── helpers ──────────────────────────────────────────────────────────────────

function byAtAsc(a: { at: Date | null }, b: { at: Date | null }): number {
  return (a.at?.getTime() ?? 0) - (b.at?.getTime() ?? 0);
}
