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
  eq,
  isNull,
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
} from "@synap/database";
import { userVisibleWhere } from "../../utils/user-visible-where.js";
import { AI_DECISION, AI_PROCESSING } from "../../lib/ai-events.js";
import type {
  FlowType,
  RunStatus,
  UnifiedRun,
  RunActivityItem,
  UnifiedRunDetail,
} from "./types.js";

const CAPTURE_PROPOSAL_TYPE = "capture.graph";

export interface ListRunsInput {
  userId: string;
  /** Restrict to one ledger; omit for the merged cross-flow feed. */
  flowType?: FlowType;
  /** Restrict to one flow's runs (automationId / playbookId). */
  flowId?: string;
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
    // active / paused / forming / scheduled are all "still going" for a run view.
    default:
      return "running";
  }
}

// ── Per-ledger adapters (list) ───────────────────────────────────────────────

async function listAutomationRuns(
  userId: string,
  flowId: string | undefined,
  limit: number
): Promise<UnifiedRun[]> {
  const rows = await db
    .select({
      id: automationRuns.id,
      automationId: automationRuns.automationId,
      flowName: automations.name,
      status: automationRuns.status,
      startedAt: automationRuns.startedAt,
      completedAt: automationRuns.completedAt,
      workspaceId: automationRuns.workspaceId,
      error: automationRuns.errorMessage,
      outputSummary: automationRuns.outputSummary,
      // The automation's ONE durable run channel (runs-substrate rule) — same
      // for every run of this automation, bound via contextObjectId.
      channelId: channels.id,
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
        flowId ? eq(automationRuns.automationId, flowId) : undefined
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
    workspaceId: r.workspaceId ?? null,
    projectId: null,
    subjectEntityId: null,
    channelId: r.channelId ?? null,
    correlationId: null,
    summary:
      typeof r.outputSummary?.summary === "string"
        ? (r.outputSummary.summary as string)
        : null,
    error: r.error ?? null,
  }));
}

async function listPlaybookRuns(
  userId: string,
  flowId: string | undefined,
  limit: number
): Promise<UnifiedRun[]> {
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
    })
    .from(playbookRuns)
    .innerJoin(playbooks, eq(playbooks.id, playbookRuns.playbookId))
    .leftJoin(focusSessions, eq(focusSessions.id, playbookRuns.sessionId))
    .where(
      and(
        userVisibleWhere(playbookRuns.workspaceId, userId),
        flowId ? eq(playbookRuns.playbookId, flowId) : undefined
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
    workspaceId: r.workspaceId ?? null,
    projectId: r.projectId ?? null,
    subjectEntityId: r.subjectEntityId ?? null,
    channelId: r.channelId ?? null,
    correlationId: null,
    summary: r.summary ?? null,
    error: r.error ?? null,
  }));
}

async function listCaptureRuns(
  userId: string,
  limit: number
): Promise<UnifiedRun[]> {
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
        userVisibleWhere(proposals.workspaceId, userId)
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
      workspaceId: r.workspaceId ?? null,
      projectId: r.projectId ?? null,
      subjectEntityId: firstEntity ?? null,
      channelId: null,
      correlationId: r.correlationId ?? null,
      summary:
        typeof data.summary === "string" ? (data.summary as string) : null,
      error: null,
    };
  });
}

async function listSessionRuns(
  userId: string,
  limit: number
): Promise<UnifiedRun[]> {
  // Standalone agent/interactive sessions only — playbook- and automation-origin
  // sessions already surface via their own ledgers, so we exclude them here to
  // avoid double-counting: no playbookId, and no automation linkage on metadata.
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
    })
    .from(focusSessions)
    .where(
      and(
        userVisibleWhere(focusSessions.workspaceId, userId),
        isNull(focusSessions.playbookId),
        // metadata.automationId absent → not an automation-origin run session
        // (those already surface via the automation ledger — no double-count).
        drizzleSql`${focusSessions.metadata}->>'automationId' IS NULL`
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
    workspaceId: r.workspaceId ?? null,
    projectId: r.projectId ?? null,
    subjectEntityId: r.subjectEntityId ?? null,
    channelId: r.channelId ?? null,
    correlationId: null,
    summary: null,
    error: null,
  }));
}

// ── Public: list (merged cross-flow feed) ────────────────────────────────────

/**
 * List runs across flows (or one flow), newest first. USER-floored. When
 * `flowType` is set only that ledger is read; otherwise all four are merged.
 */
export async function listRuns(input: ListRunsInput): Promise<UnifiedRun[]> {
  const { userId, flowType, flowId } = input;
  const perFlow = Math.min(input.limit ?? 25, 100);

  const jobs: Array<Promise<UnifiedRun[]>> = [];
  if (!flowType || flowType === "automation")
    jobs.push(listAutomationRuns(userId, flowId, perFlow));
  if (!flowType || flowType === "playbook")
    jobs.push(listPlaybookRuns(userId, flowId, perFlow));
  // capture/session have no per-flow id, so a flowId filter excludes them.
  if ((!flowType || flowType === "capture") && !flowId)
    jobs.push(listCaptureRuns(userId, perFlow));
  if ((!flowType || flowType === "session") && !flowId)
    jobs.push(listSessionRuns(userId, perFlow));

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
  unique.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
  return unique.slice(0, perFlow);
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
    const [run] = await listRunsById(
      () => listAutomationRuns(userId, undefined, 100),
      id
    );
    if (!run) return null;
    const steps = await db
      .select()
      .from(automationStepRuns)
      .where(eq(automationStepRuns.runId, run.id));
    const activity: RunActivityItem[] = steps
      .map((s) => ({
        id: s.id,
        at: s.completedAt ?? s.startedAt ?? null,
        kind: "step",
        status: s.status,
        label: s.nodeId,
        hint: s.errorMessage ?? null,
        detail: { output: s.output, resolvedInputs: s.resolvedInputs },
      }))
      .sort(byAtAsc);
    return { run, activity };
  }

  if (flowType === "capture") {
    const [run] = await listRunsById(() => listCaptureRuns(userId, 200), id);
    if (!run || !run.correlationId) return run ? { run, activity: [] } : null;
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
    return { run, activity };
  }

  // playbook / session — the run's story is its channel; return the run with a
  // single lifecycle marker (the UI opens `run.channelId` for the messages).
  const source =
    flowType === "playbook"
      ? () => listPlaybookRuns(userId, undefined, 200)
      : () => listSessionRuns(userId, 200);
  const [run] = await listRunsById(source, id);
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
  return { run, activity };
}

// ── helpers ──────────────────────────────────────────────────────────────────

async function listRunsById(
  source: () => Promise<UnifiedRun[]>,
  id: string
): Promise<UnifiedRun[]> {
  const all = await source();
  return all.filter((r) => r.id === id);
}

function byAtAsc(a: { at: Date | null }, b: { at: Date | null }): number {
  return (a.at?.getTime() ?? 0) - (b.at?.getTime() ?? 0);
}
