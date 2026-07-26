/**
 * The `diagnose` door — ONE service, mode from PAYLOAD shape.
 *
 * Mirrors how `capture` routes: the agent never classifies which diagnostic
 * surface it wants; it hands over whatever pointer it has and the door figures
 * out the altitude. Fully backward-compatible with today's run-feed reader
 * (`flowType`/`flowId`/`runId` still behave exactly as before).
 *
 *   diagnose({})                  → GLOBAL   whole-pod health
 *   diagnose({ type })            → CLASS    a diagnosable class as a surface
 *   diagnose({ id })              → OBJECT   auto-detect kind, explain state + why
 *   diagnose({ agentId })         → AGENT    behavioural scorecard
 *   diagnose({ runId, flowType }) → run-detail  (today's per-run timeline)
 *   diagnose({ flowType|flowId }) → run-feed    (today's merged feed)
 *
 * Precedence (most specific wins): agentId > runId > id > type > flowType/flowId
 * > none. Exactly like capture's guard-first ordering.
 */

import {
  db,
  and,
  eq,
  desc,
  isNull,
  drizzleSql,
  proposals,
  focusSessions,
  capabilities,
  entities,
  users,
  ProposalStatus,
} from "@synap/database";
import type { ProposalRevision } from "@synap/database";
import { userVisibleWhere } from "../../utils/user-visible-where.js";
import { listRuns, listRunGroups, getRun } from "../runs/index.js";
import {
  collapseProposalsToClusters,
  type ClusterInputRow,
} from "../proposals/fingerprint.js";
import { AGENT_PROPOSALS_PER_USER_PER_DAY } from "../../utils/permission-check.js";
import { agentScorecard } from "./agent-scorecard.js";
import { diagnoseGlobal } from "./global.js";
import { resolveObjectKind } from "./resolve-object-kind.js";
import type {
  DiagnoseClass,
  DiagnoseResult,
  ClassReport,
  ObjectReport,
  ObjectKind,
  FlowType,
} from "./types.js";

const CLASS_VALUES: DiagnoseClass[] = [
  "proposal",
  "session",
  "capability",
  "agent",
  "entity",
  "run",
];

export interface DiagnoseInput {
  /** The caller's human user floor. */
  userId: string;
  // ── new grammar ──
  /** Explicit agent-quality scorecard. */
  agentId?: string;
  /** Bare object id — auto-detect its kind. */
  id?: string;
  /** A diagnosable class as a product surface. */
  type?: DiagnoseClass;
  /** Narrow GLOBAL/CLASS to one workspace lens (within the user floor). */
  workspaceId?: string | null;
  /** Override the "stuck run" age boundary (GLOBAL). */
  stuckThresholdHours?: number;
  // ── today's run-feed grammar (backward compatible) ──
  flowType?: FlowType;
  flowId?: string;
  runId?: string;
  limit?: number;
}

export async function diagnoseRouter(
  input: DiagnoseInput
): Promise<DiagnoseResult> {
  const { userId } = input;

  // 1. Explicit agent-quality intent.
  if (input.agentId) {
    return agentScorecard({ userId, agentId: input.agentId });
  }

  // 2. Today's per-run timeline — unchanged. `runId` still requires `flowType`
  //    (the id space differs per flow).
  if (input.runId) {
    if (!input.flowType) {
      return { error: "flowType is required when runId is given" };
    }
    const detail = await getRun({
      userId,
      flowType: input.flowType,
      id: input.runId,
    });
    return detail ? { mode: "run-detail", detail } : { error: "Run not found" };
  }

  // 3. Bare id → auto-detect kind, explain state + why.
  if (input.id) {
    const resolved = await resolveObjectKind(input.id, userId);
    if (!resolved) {
      return { error: `No diagnosable object found for id ${input.id}` };
    }
    // An agent-user id is really "OBJECT where kind=agent" → the quality view.
    if (resolved.kind === "agent") {
      return agentScorecard({ userId, agentId: input.id });
    }
    return diagnoseObject(userId, resolved.kind, input.id);
  }

  // 4. A diagnosable class as a surface.
  if (input.type) {
    if (!CLASS_VALUES.includes(input.type)) {
      return {
        error: `Unknown type "${input.type}". Expected one of: ${CLASS_VALUES.join(", ")}`,
      };
    }
    return diagnoseClass(userId, input.type, input.workspaceId ?? undefined);
  }

  // 5. Today's run feed — a special case of CLASS/run. Only when a run-feed
  //    filter is explicitly present, so a truly no-arg call falls to GLOBAL.
  if (input.flowType || input.flowId) {
    const runs = await listRuns({
      userId,
      flowType: input.flowType,
      flowId: input.flowId,
      limit: input.limit,
    });
    return { mode: "run-feed", runs };
  }

  // 6. No args → whole-pod health.
  return diagnoseGlobal({
    userId,
    workspaceId: input.workspaceId ?? null,
    stuckThresholdHours: input.stuckThresholdHours,
  });
}

// ── OBJECT dispatch ──────────────────────────────────────────────────────────

async function diagnoseObject(
  userId: string,
  kind: ObjectKind,
  id: string
): Promise<ObjectReport | { error: string }> {
  switch (kind) {
    // Runs already have the richest "why" — reuse today's getRun verbatim.
    case "automation_run":
    case "playbook_run": {
      const flowType: FlowType =
        kind === "automation_run" ? "automation" : "playbook";
      const detail = await getRun({ userId, flowType, id });
      if (!detail) return { error: "Run not found" };
      return {
        mode: "object",
        kind,
        id,
        summary: `${flowType} run "${detail.run.flowName}" is ${detail.run.status}`,
        state: {
          status: detail.run.status,
          startedAt: detail.run.startedAt,
          completedAt: detail.run.completedAt,
          error: detail.run.error,
          stepsCompleted: detail.run.stepsCompleted,
          stepsFailed: detail.run.stepsFailed,
        },
        why: { activity: detail.activity, outputSummary: detail.outputSummary },
      };
    }

    case "proposal": {
      const [row] = await db
        .select({
          id: proposals.id,
          status: proposals.status,
          proposalType: proposals.proposalType,
          targetType: proposals.targetType,
          targetId: proposals.targetId,
          rejectionReason: proposals.rejectionReason,
          revisionHistory: proposals.revisionHistory,
          correlationId: proposals.correlationId,
          agentUserId: proposals.agentUserId,
          createdAt: proposals.createdAt,
          workspaceId: proposals.workspaceId,
        })
        .from(proposals)
        .where(
          and(
            eq(proposals.id, id),
            userVisibleWhere(proposals.workspaceId, userId)
          )
        )
        .limit(1);
      if (!row) return { error: "Proposal not found" };
      const revisionCount = Array.isArray(row.revisionHistory)
        ? (row.revisionHistory as ProposalRevision[]).length
        : 0;
      return {
        mode: "object",
        kind,
        id,
        summary: `${row.proposalType} proposal on ${row.targetType} is ${row.status}`,
        state: {
          status: row.status,
          proposalType: row.proposalType,
          targetType: row.targetType,
          targetId: row.targetId,
          createdAt: row.createdAt,
          workspaceId: row.workspaceId,
        },
        why: {
          rejectionReason: row.rejectionReason,
          revisionCount,
          correlationId: row.correlationId,
          agentUserId: row.agentUserId,
        },
      };
    }

    case "session": {
      const [row] = await db
        .select({
          id: focusSessions.id,
          goal: focusSessions.goal,
          status: focusSessions.status,
          createdAt: focusSessions.createdAt,
          workspaceId: focusSessions.workspaceId,
          projectId: focusSessions.projectId,
          playbookId: focusSessions.playbookId,
          channelId: focusSessions.channelId,
        })
        .from(focusSessions)
        .where(
          and(
            eq(focusSessions.id, id),
            drizzleSql`(${focusSessions.userId} = ${userId} OR ${userVisibleWhere(
              focusSessions.workspaceId,
              userId
            )})`
          )
        )
        .limit(1);
      if (!row) return { error: "Session not found" };
      const ageHours = row.createdAt
        ? (Date.now() - new Date(row.createdAt).getTime()) / (60 * 60 * 1000)
        : null;
      return {
        mode: "object",
        kind,
        id,
        summary:
          `Session "${row.goal}" is ${row.status}` +
          (ageHours !== null ? ` (${Math.round(ageHours)}h old)` : ""),
        state: {
          goal: row.goal,
          status: row.status,
          ageHours,
          workspaceId: row.workspaceId,
          projectId: row.projectId,
          playbookId: row.playbookId,
          channelId: row.channelId,
        },
        why: null,
      };
    }

    case "capability": {
      const [row] = await db
        .select({
          id: capabilities.id,
          name: capabilities.name,
          description: capabilities.description,
          approved: capabilities.approved,
          workspaceId: capabilities.workspaceId,
        })
        .from(capabilities)
        .where(
          and(
            eq(capabilities.id, id),
            userVisibleWhere(capabilities.workspaceId, userId)
          )
        )
        .limit(1);
      if (!row) return { error: "Capability not found" };
      return {
        mode: "object",
        kind,
        id,
        summary: `Capability "${row.name}" is ${row.approved ? "approved" : "awaiting approval"}`,
        state: {
          name: row.name,
          description: row.description,
          approved: row.approved,
          workspaceId: row.workspaceId,
        },
        why: null,
      };
    }

    case "entity": {
      const [row] = await db
        .select({
          id: entities.id,
          title: entities.title,
          type: entities.type,
          workspaceId: entities.workspaceId,
        })
        .from(entities)
        .where(
          and(
            eq(entities.id, id),
            isNull(entities.deletedAt),
            userVisibleWhere(entities.workspaceId, userId)
          )
        )
        .limit(1);
      if (!row) return { error: "Entity not found" };
      return {
        mode: "object",
        kind,
        id,
        summary: `Entity "${row.title ?? row.type}" (${row.type})`,
        state: {
          title: row.title,
          type: row.type,
          workspaceId: row.workspaceId,
        },
        why: null,
      };
    }

    default:
      return { error: `No object handler for kind ${kind}` };
  }
}

// ── CLASS dispatch ───────────────────────────────────────────────────────────

async function diagnoseClass(
  userId: string,
  type: DiagnoseClass,
  workspaceId?: string
): Promise<ClassReport | { error: string }> {
  switch (type) {
    // The review queue as a product: backlog + duplicate clusters.
    case "proposal": {
      const rows = await db
        .select({
          id: proposals.id,
          proposalType: proposals.proposalType,
          targetType: proposals.targetType,
          targetId: proposals.targetId,
          data: proposals.data,
          createdAt: proposals.createdAt,
          workspaceId: proposals.workspaceId,
        })
        .from(proposals)
        .where(
          and(
            userVisibleWhere(proposals.workspaceId, userId),
            eq(proposals.status, ProposalStatus.PENDING),
            workspaceId ? eq(proposals.workspaceId, workspaceId) : undefined
          )
        )
        .orderBy(desc(proposals.createdAt))
        .limit(1000);
      const clusterRows: ClusterInputRow[] = rows.map((r) => ({
        id: r.id,
        proposalType: r.proposalType,
        targetType: r.targetType,
        targetId: r.targetId,
        data: r.data,
        createdAt: r.createdAt,
        workspaceId: r.workspaceId ?? null,
      }));
      const clusters = collapseProposalsToClusters(clusterRows);
      const duplicates = clusters.filter((c) => c.count > 1);
      const oldest = rows.length > 0 ? rows[rows.length - 1]!.createdAt : null;
      return {
        mode: "class",
        type,
        summary:
          rows.length === 0
            ? "No pending proposals in the review queue."
            : `${rows.length} pending proposal(s), ${duplicates.length} duplicate cluster(s).`,
        detail: {
          pending: rows.length,
          oldestCreatedAt: oldest,
          duplicateClusters: duplicates
            .map((c) => ({ targetLabel: c.targetLabel, count: c.count }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 20),
        },
      };
    }

    // Stuck-session list — running sessions, oldest first.
    case "session": {
      const runs = await listRuns({
        userId,
        flowType: "session",
        status: "running",
        scope: workspaceId ? { workspaceId } : undefined,
        limit: 100,
      });
      const sessions = runs
        .map((r) => ({
          id: r.id,
          goal: r.flowName,
          ageHours: (Date.now() - r.startedAt.getTime()) / (60 * 60 * 1000),
          workspaceId: r.workspaceId,
        }))
        .sort((a, b) => b.ageHours - a.ageHours);
      return {
        mode: "class",
        type,
        summary:
          sessions.length === 0
            ? "No running sessions."
            : `${sessions.length} running session(s); oldest ${Math.round(sessions[0]!.ageHours)}h.`,
        detail: { running: sessions },
      };
    }

    // Per-flow run footprint — already computed in-DB.
    case "run": {
      const groups = await listRunGroups({
        userId,
        scope: workspaceId ? { workspaceId } : undefined,
        limit: 100,
      });
      const failing = groups.filter((g) => g.failedCount > 0 || g.hasRunning);
      return {
        mode: "class",
        type,
        summary:
          groups.length === 0
            ? "No automation or playbook runs."
            : `${groups.length} flow(s); ${failing.length} with failures or in-flight runs.`,
        detail: { groups },
      };
    }

    // Agent roster with a one-line quality summary each.
    case "agent": {
      const roster = await db
        .select({
          id: users.id,
          name: users.name,
          email: users.email,
          agentType: users.agentType,
        })
        .from(users)
        .where(
          and(eq(users.userType, "agent"), eq(users.createdByUserId, userId))
        );
      const cards = await Promise.all(
        roster.map(async (a) => {
          const card = await agentScorecard({ userId, agentId: a.id });
          if ("error" in card) {
            return {
              agentId: a.id,
              name: a.name ?? a.email,
              error: card.error,
            };
          }
          return {
            agentId: a.id,
            name: card.agentName,
            agentType: card.agentType,
            total: card.counts.total,
            approveRate: card.rates.approveRate,
            rejectRate: card.rates.rejectRate,
            duplicateRate: card.rates.duplicateRate,
            atOrOverCap: card.dailyCap.atOrOverCap,
          };
        })
      );
      return {
        mode: "class",
        type,
        summary:
          cards.length === 0
            ? "No agents registered for this owner."
            : `${cards.length} agent(s). Cap: ${AGENT_PROPOSALS_PER_USER_PER_DAY}/day (shared).`,
        detail: { agents: cards },
      };
    }

    // Capability health table — approved vs awaiting approval.
    case "capability": {
      const rows = await db
        .select({
          id: capabilities.id,
          name: capabilities.name,
          approved: capabilities.approved,
          workspaceId: capabilities.workspaceId,
        })
        .from(capabilities)
        .where(
          and(
            userVisibleWhere(capabilities.workspaceId, userId),
            workspaceId ? eq(capabilities.workspaceId, workspaceId) : undefined
          )
        );
      const approved = rows.filter((r) => r.approved);
      const awaiting = rows.filter((r) => !r.approved);
      return {
        mode: "class",
        type,
        summary:
          rows.length === 0
            ? "No capabilities configured."
            : `${approved.length} approved, ${awaiting.length} awaiting approval.`,
        detail: {
          approved: approved.map((r) => ({ id: r.id, name: r.name })),
          awaiting: awaiting.map((r) => ({ id: r.id, name: r.name })),
        },
      };
    }

    // Entities are diagnosed per-id (OBJECT), not as a health surface.
    case "entity":
      return {
        mode: "class",
        type,
        summary:
          "Entity diagnosis is per-object — pass a specific entity id: diagnose({ id }).",
        detail: {},
      };

    default:
      return { error: `No class handler for type ${type}` };
  }
}

export { diagnoseGlobal, agentScorecard, resolveObjectKind };
