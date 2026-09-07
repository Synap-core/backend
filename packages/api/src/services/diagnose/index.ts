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
  or,
  eq,
  desc,
  isNull,
  drizzleSql,
  proposals,
  focusSessions,
  capabilities,
  entities,
  views,
  documents,
  users,
  skills,
  tools,
  events,
  ProposalStatus,
} from "@synap/database";
import { EXTERNAL_DISPATCH_SOURCE } from "../../connectors/external-dispatch-constants.js";
import { authoredByUser } from "../agent-identity-service.js";
import type { ProposalRevision } from "@synap/database";
import { accessScopeWhere } from "../../utils/project-scope.js";
import {
  userVisibleWhere,
  ownerPrivateVisibleWhere,
} from "../../utils/user-visible-where.js";
import { visibleSkillsWhere } from "../skills/visibility.js";
import { listRuns, listRunGroups, getRun } from "../runs/index.js";
import { CAPABILITY_RUN_PROPOSAL_TYPE } from "../proposals/proposal-class.js";
import {
  collapseProposalsToClusters,
  type ClusterInputRow,
} from "../proposals/fingerprint.js";
import { AGENT_PROPOSALS_PER_USER_PER_DAY } from "../../utils/permission-check.js";
import { agentScorecard } from "./agent-scorecard.js";
import { diagnoseGlobal } from "./global.js";
import { buildCapabilityComposition } from "./capability-composition.js";
import { resolveObjectKind } from "./resolve-object-kind.js";
import {
  diagnoseWorkspaceClass,
  diagnoseWorkspaceObject,
} from "./workspace.js";
import type {
  DiagnoseClass,
  DiagnoseResult,
  ClassReport,
  ObjectReport,
  CapabilityComposition,
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
  "workspace",
];

/* `CAPABILITY_RUN_PROPOSAL_TYPE` — the agnostic-capability last-mile executor's
 * `proposals.proposalType`, the one whose `data.runResult` carries the run
 * output — is imported from the module that classifies on it. */

/** Bound a (possibly large) diagnose value for the response — pass small values
 * through verbatim, truncate a huge payload to a preview so diagnose stays lean. */
function boundDiagnoseValue(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  const json = JSON.stringify(value);
  if (json.length <= 8000) return value;
  return { truncated: true, preview: json.slice(0, 8000) };
}

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
    // Use `resolved.id`, not `input.id`: the correlationId fallback in
    // resolveObjectKind resolves a stamped correlationId to the underlying
    // proposal ROW id, which is what the object lookups below key on. For every
    // row-id probe `resolved.id === input.id`, so this is behaviour-preserving.
    if (resolved.kind === "agent") {
      return agentScorecard({ userId, agentId: resolved.id });
    }
    return diagnoseObject(userId, resolved.kind, resolved.id);
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
): Promise<ObjectReport | CapabilityComposition | { error: string }> {
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
          data: proposals.data,
        })
        .from(proposals)
        .where(
          and(
            eq(proposals.id, id),
            // LENS **or** OWNERSHIP — the same pairing `resolve-object-kind.ts`
            // uses to FIND the row. Without it the two halves disagreed: the
            // resolver identified an outside-lens proposal and this loader then
            // answered "Proposal not found", so the fix upstream just changed
            // which error the user got. Both halves of the id path must reach
            // the rows `mineOutsideLens` advertises.
            or(
              userVisibleWhere(proposals.workspaceId, userId),
              authoredByUser(userId)
            )
          )
        )
        .limit(1);
      if (!row) return { error: "Proposal not found" };
      const revisionCount = Array.isArray(row.revisionHistory)
        ? (row.revisionHistory as ProposalRevision[]).length
        : 0;
      // A `capability.run` proposal stores its executed output in
      // `data.runResult` (approve-executors.ts). Surface a bounded view so
      // diagnose(proposalId) shows the RESULT, not just the proposal state.
      const runResult =
        row.proposalType === CAPABILITY_RUN_PROPOSAL_TYPE
          ? (row.data as Record<string, unknown> | null)?.runResult
          : undefined;
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
          ...(runResult !== undefined
            ? { runResult: boundDiagnoseValue(runResult) }
            : {}),
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
            // An OR against a bare `userVisibleWhere` WIDENS, it does not
            // gate: that helper's `isNull(workspaceId)` branch is owner-BLIND,
            // so it already returned true for ANOTHER user's pod-personal
            // session. `focus_sessions` is `ownerPrivate` in the access
            // registry — own the NULL branch, keep the workspace branch on the
            // shared user floor.
            ownerPrivateVisibleWhere(
              focusSessions.workspaceId,
              focusSessions.userId,
              userId
            )
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
          metadata: capabilities.metadata,
        })
        .from(capabilities)
        .where(
          and(
            eq(capabilities.id, id),
            userVisibleWhere(capabilities.workspaceId, userId)
          )
        )
        .limit(1);
      if (row) {
        // A real `capabilities` row is a CONTAINER — return its composition
        // (members + health + gaps), the FROZEN shape a parallel frontend
        // consumes. The generic object report is insufficient for a container:
        // "what did this materialize, and is it healthy?" is the actual question.
        return await buildCapabilityComposition({
          userId,
          capability: {
            id: row.id,
            name: row.name,
            description: row.description,
            approved: row.approved,
            metadata: row.metadata as Record<string, unknown> | null,
            workspaceId: row.workspaceId,
          },
        });
      }

      // Not a registered `capabilities` verb — resolveObjectKind also matches a
      // bare `skills`/`tools` row under "capability" (a `capability.run`'s
      // skillId is rarely a `capabilities` row), so explain it from there.
      const [skillRow] = await db
        .select({
          id: skills.id,
          name: skills.name,
          kind: skills.kind,
          approved: skills.approved,
          workspaceId: skills.workspaceId,
        })
        .from(skills)
        .where(and(eq(skills.id, id), visibleSkillsWhere(userId)))
        .limit(1);
      if (skillRow) {
        return {
          mode: "object",
          kind,
          id,
          summary: `Skill "${skillRow.name}" (${skillRow.kind}) is ${skillRow.approved ? "approved" : "awaiting approval"}`,
          state: {
            name: skillRow.name,
            description: null,
            approved: skillRow.approved,
            workspaceId: skillRow.workspaceId,
          },
          why: null,
        };
      }

      const [toolRow] = await db
        .select({
          id: tools.id,
          name: tools.name,
          description: tools.description,
          workspaceId: tools.workspaceId,
        })
        .from(tools)
        .where(
          and(eq(tools.id, id), userVisibleWhere(tools.workspaceId, userId))
        )
        .limit(1);
      if (!toolRow) return { error: "Capability not found" };
      return {
        mode: "object",
        kind,
        id,
        summary: `Tool "${toolRow.name}"`,
        state: {
          name: toolRow.name,
          description: toolRow.description,
          approved: null,
          workspaceId: toolRow.workspaceId,
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
            ownerPrivateVisibleWhere(
              entities.workspaceId,
              entities.userId,
              userId
            )
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

    // `view` and `document` joined `ObjectKind` when `/resolve/:id` stopped
    // keeping its own probe list (they existed only there). They get their own
    // arms rather than falling to the `default` below: a kind the prober can
    // detect but the explainer answers with "No object handler for kind view"
    // is a worse answer than the one it replaced. Floors mirror the probes.
    case "view": {
      const [row] = await db
        .select({
          name: views.name,
          type: views.type,
          workspaceId: views.workspaceId,
        })
        .from(views)
        .where(
          and(
            eq(views.id, id),
            ownerPrivateVisibleWhere(views.workspaceId, views.userId, userId)
          )
        )
        .limit(1);
      if (!row) return { error: "View not found" };
      return {
        mode: "object",
        kind,
        id,
        summary: `View "${row.name}" (${row.type})`,
        state: {
          name: row.name,
          type: row.type,
          workspaceId: row.workspaceId,
        },
        why: null,
      };
    }

    case "document": {
      const [row] = await db
        .select({
          title: documents.title,
          workspaceId: documents.workspaceId,
        })
        .from(documents)
        .where(
          and(
            eq(documents.id, id),
            accessScopeWhere({
              workspaceIdColumn: documents.workspaceId,
              entityIdColumn: documents.id,
              ownerColumn: documents.userId,
              userId,
            })
          )
        )
        .limit(1);
      if (!row) return { error: "Document not found" };
      return {
        mode: "object",
        kind,
        id,
        summary: `Document "${row.title}"`,
        state: { title: row.title, workspaceId: row.workspaceId },
        why: null,
      };
    }

    // A WORKSPACE — the pod's organising lens. Delegated whole to
    // `./workspace.ts` (entity count, the kinds that actually live here, the
    // pod-scoped share, last activity, empty/duplicate-name flags) rather than
    // inlined, so OBJECT and CLASS mode read the SAME landscape loader and can
    // never report two different pictures of the same workspace.
    case "workspace":
      return diagnoseWorkspaceObject(userId, id);

    // A completed external-dispatch send — resolved by `resolveObjectKind`'s
    // correlationId fallback (no row of its own; `id` here IS the
    // correlationId). Re-read the SAME audit event to explain it.
    case "external_send": {
      const [row] = await db
        .select({
          type: events.type,
          data: events.data,
          timestamp: events.timestamp,
        })
        .from(events)
        .where(
          and(
            eq(events.correlationId, id),
            eq(events.source, EXTERNAL_DISPATCH_SOURCE),
            eq(events.userId, userId)
          )
        )
        .orderBy(desc(events.timestamp))
        .limit(1);
      if (!row) return { error: "External send not found" };
      const data = (row.data ?? {}) as Record<string, unknown>;
      return {
        mode: "object",
        kind,
        id,
        summary: `${row.type} → ${data.status ?? "unknown"} (${data.target ?? "?"})`,
        state: {
          eventType: row.type,
          status: data.status ?? null,
          target: data.target ?? null,
          timestamp: row.timestamp,
        },
        why: { data: boundDiagnoseValue(data) },
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
      // Same lens gap the GLOBAL door now names (`services/diagnose/global.ts`,
      // `mineOutsideLens`). `userVisibleWhere` is a WORKSPACE-membership
      // predicate, so a pending row whose `workspaceId` does not resolve to a
      // workspace this user belongs to is dropped — and those are precisely the
      // malformed ones (orphaned workspace ids; one row carries a USER id in
      // the workspace column). Three external test passes reported this door
      // saying 11 while `orient`/`list_proposals` said 14, with no explanation.
      //
      // Adds NO disclosure: it is the AUTHOR floor `orient` already reports to
      // this same user. No membership term — this is not a workspace widening.
      const [mineRow] = await db
        .select({ mine: drizzleSql<number>`count(*)::int` })
        .from(proposals)
        .where(
          and(
            authoredByUser(userId),
            eq(proposals.status, ProposalStatus.PENDING),
            workspaceId ? eq(proposals.workspaceId, workspaceId) : undefined
          )
        );
      // Clamped: the author floor is not a superset of the workspace floor (a
      // teammate's row in a shared workspace is workspace-visible, not mine).
      const mineOutsideLens = Math.max(0, (mineRow?.mine ?? 0) - rows.length);

      const clusters = collapseProposalsToClusters(clusterRows);
      const duplicates = clusters.filter((c) => c.count > 1);
      const oldest = rows.length > 0 ? rows[rows.length - 1]!.createdAt : null;
      return {
        mode: "class",
        type,
        summary:
          rows.length === 0
            ? "No pending proposals in the review queue."
            : `${rows.length} pending proposal(s), ${duplicates.length} duplicate cluster(s).` +
              (mineOutsideLens > 0
                ? ` ${mineOutsideLens} more of yours sit outside your workspace lens (unresolvable placement).`
                : ""),
        detail: {
          pending: rows.length,
          mineOutsideLens,
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
            // Still OPEN, not yet resolved — the backlog half of the roster's
            // job. Unlike the other buckets this one is not recoverable from a
            // rate (there is no pendingRate), so dropping it made a queue
            // problem invisible on the only surface that ranks agents.
            pending: card.counts.pending,
            approveRate: card.rates.approveRate,
            // A partially-applied proposal is EXCLUDED from `approveRate` (a
            // gutted package is not an endorsement), so without these two the
            // roster shows a high approve rate with no way to see that the
            // reviewer threw work away — the same blindness the scorecard split
            // exists to end, reproduced one layer up at the door.
            partiallyApproved: card.counts.partiallyApproved,
            partialApproveRate: card.rates.partialApproveRate,
            rejectRate: card.rates.rejectRate,
            // A human had to REWRITE the proposal before it resolved — the same
            // class of trust signal as `partialApproveRate` (work the reviewer
            // had to redo), and excluded from `approveRate` for the same reason.
            reviseRate: card.rates.reviseRate,
            duplicateRate: card.rates.duplicateRate,
            // WHY the rejects happened, bucketed. `rejectRate` alone says an
            // agent is failing but never says at what, which is the whole point
            // of ranking a roster.
            rejectionReasons: card.rejectionReasons,
            dailyCap: card.dailyCap.cap,
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
            : // Per-agent cap: each agent gets its OWN daily budget (base
              // AGENT_PROPOSALS_PER_USER_PER_DAY, scaled up for a proven agent) —
              // not a pool shared across the owner's roster.
              `${cards.length} agent(s). Base cap: ${AGENT_PROPOSALS_PER_USER_PER_DAY}/day per agent (trusted agents get more — see each agent's dailyCap).`,
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

    // The workspace LANDSCAPE — the "do I have too many workspaces?" read.
    // `workspaceId` narrows it to one lens, exactly like every other class arm.
    case "workspace":
      return diagnoseWorkspaceClass(userId, workspaceId);

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
