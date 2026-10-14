/**
 * THE AGENT × WORK MATRIX reader (agent routing W2) — `governance.matrix`.
 *
 * Every cell is the ONE resolver's answer (`dryRunAgentGovernanceDecision`),
 * asked through a read snapshot (`createReadSnapshot`) so identical reads hit
 * the database once — never a second ladder. Contract and marks:
 * `@synap-core/types/agent-matrix`.
 *
 *   lens 'pod'   every agent and every live space (the procedure requires a
 *                pod admin);
 *   lens 'mine'  the caller's own agents, in the spaces the caller can see.
 *
 * Columns, derived from the pod's own data (never a hand list):
 *   - a locked "Floors" column — platform limits no rule can widen
 *     (`nonWidenableFloorFor` over the classified doors);
 *   - per space, one column per PROCESS (a playbook that works a kind's
 *     lifecycle, `subjectProfile`), probing that kind's create / edit / move /
 *     delete;
 *   - per space, one "Other work" column (an unclassified create / edit).
 * Past `AGENT_MATRIX_LIMITS` the answer says `partial` with what was left out.
 */

import {
  db,
  and,
  eq,
  inArray,
  isNull,
  ne,
  or,
  asc,
  users,
  workspaces,
  playbooks,
  notAnAppAgent,
} from "@synap/database";
import {
  createReadSnapshot,
  dryRunAgentGovernanceDecision,
} from "@synap/database/agent-governance";
import {
  REVERSIBILITY_DOOR_CLASS,
  nonWidenableFloorFor,
} from "@synap/governance-policy";
import { readSubjectLifecycle } from "@synap/playbooks";
import { MACHINE_AGENT_TYPE } from "@synap-core/types/agents";
import {
  AGENT_MATRIX_LIMITS,
  cellOfAnswers,
  collapseCells,
  matrixVerdictOf,
  type AgentMatrix,
  type MatrixAgentRow,
  type MatrixCell,
  type MatrixColumn,
  type MatrixComputerGroup,
  type MatrixLens,
  type MatrixProbe,
  type MatrixTypeGroup,
} from "@synap-core/types/agent-matrix";
import { userVisibleWhere } from "../../utils/user-visible-where.js";

/** How many dry runs run at once (the snapshot dedupes their reads). */
const CONCURRENCY = 32;

const PROCESS_ACTIONS = [
  "entity.create",
  "entity.update",
  "entity.transition",
  "entity.delete",
] as const;
const OTHER_ACTIONS = ["entity.create", "entity.update", "document.update"] as const;

/**
 * The platform floors: one classified door per DISTINCT floor reason no rule
 * can widen (destructive, admin, human gate…), derived — a new floor kind
 * joins by existing. Door keys are `subject/action`; the event key is
 * `subject.action`.
 */
export function floorProbes(): MatrixProbe[] {
  const byReason = new Map<string, string>();
  for (const door of Object.keys(REVERSIBILITY_DOOR_CLASS).sort()) {
    const action = door.replace("/", ".");
    const reason = nonWidenableFloorFor(action);
    if (reason && !byReason.has(reason)) byReason.set(reason, action);
  }
  return [...byReason.values()]
    .slice(0, AGENT_MATRIX_LIMITS.probesPerColumn)
    .map((action) => ({ key: `floor:${action}`, action, profileSlug: null }));
}

const probesFor = (
  actions: readonly string[],
  profileSlug: string | null
): MatrixProbe[] =>
  actions
    .slice(0, AGENT_MATRIX_LIMITS.probesPerColumn)
    .map((action) => ({
      key: `${action}${profileSlug ? `:${profileSlug}` : ""}`,
      action,
      profileSlug,
    }));

async function readColumns(
  userId: string,
  lens: MatrixLens
): Promise<{ columns: MatrixColumn[]; omitted: number }> {
  const spaces = await db
    .select({ id: workspaces.id, name: workspaces.name })
    .from(workspaces)
    .where(
      lens === "pod"
        ? isNull(workspaces.archivedAt)
        : and(
            isNull(workspaces.archivedAt),
            userVisibleWhere(workspaces.id, userId)
          )
    )
    .orderBy(asc(workspaces.name));
  const processes = spaces.length
    ? await db
        .select({
          id: playbooks.id,
          name: playbooks.name,
          workspaceId: playbooks.workspaceId,
          subjectProfile: playbooks.subjectProfile,
        })
        .from(playbooks)
        .where(
          inArray(
            playbooks.workspaceId,
            spaces.map((s) => s.id)
          )
        )
        .orderBy(asc(playbooks.name))
    : [];

  const all: MatrixColumn[] = [
    {
      id: "floors",
      kind: "floors",
      label: "Floors",
      workspaceId: null,
      workspaceName: null,
      playbookId: null,
      probes: floorProbes(),
    },
  ];
  for (const space of spaces) {
    for (const pb of processes) {
      if (pb.workspaceId !== space.id) continue;
      const { profileSlug } = readSubjectLifecycle(pb.subjectProfile);
      if (!profileSlug) continue; // not a process: works no kind's lifecycle
      all.push({
        id: `process:${pb.id}`,
        kind: "process",
        label: pb.name,
        workspaceId: space.id,
        workspaceName: space.name,
        playbookId: pb.id,
        probes: probesFor(PROCESS_ACTIONS, profileSlug),
      });
    }
    all.push({
      id: `other:${space.id}`,
      kind: "other",
      label: "Other work",
      workspaceId: space.id,
      workspaceName: space.name,
      playbookId: null,
      probes: probesFor(OTHER_ACTIONS, null),
    });
  }
  const columns = all.slice(0, AGENT_MATRIX_LIMITS.columns);
  return { columns, omitted: all.length - columns.length };
}

async function readAgents(userId: string, lens: MatrixLens) {
  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      agentType: users.agentType,
      hostUserId: users.hostUserId,
      createdByUserId: users.createdByUserId,
      pausedAt: users.agentPausedAt,
    })
    .from(users)
    .where(
      and(
        eq(users.userType, "agent"),
        notAnAppAgent(users.id),
        // A computer is a ROW GROUP (its agents sit under it), not a row.
        or(isNull(users.agentType), ne(users.agentType, MACHINE_AGENT_TYPE)),
        ...(lens === "mine" ? [eq(users.createdByUserId, userId)] : [])
      )
    )
    .orderBy(asc(users.agentType), asc(users.name));
  return rows;
}

/** Run `tasks` with at most `limit` in flight. */
async function pooled<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const out = new Array<T>(tasks.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, tasks.length) }, async () => {
      while (next < tasks.length) {
        const i = next++;
        out[i] = await tasks[i]!();
      }
    })
  );
  return out;
}

export async function readAgentMatrix(p: {
  userId: string;
  lens: MatrixLens;
}): Promise<AgentMatrix> {
  const [{ columns, omitted: columnsOmitted }, allAgents] = await Promise.all([
    readColumns(p.userId, p.lens),
    readAgents(p.userId, p.lens),
  ]);
  const agents = allAgents.slice(0, AGENT_MATRIX_LIMITS.agents);
  const hostIds = [
    ...new Set(agents.map((a) => a.hostUserId).filter((h): h is string => !!h)),
  ];
  const hostNames = new Map(
    hostIds.length
      ? (
          await db
            .select({ id: users.id, name: users.name })
            .from(users)
            .where(inArray(users.id, hostIds))
        ).map((h) => [h.id, h.name ?? "Computer"] as const)
      : []
  );

  // Every cell through the ONE resolver, on one snapshot.
  const snapshot = createReadSnapshot(db);
  const rows: MatrixAgentRow[] = await pooled(
    agents.map((agent) => async () => {
      const cells: Record<string, MatrixCell> = {};
      for (const column of columns) {
        const answers = await Promise.all(
          column.probes.map(async (probe) => {
            const r = await dryRunAgentGovernanceDecision({
              db: snapshot.db,
              userId: agent.createdByUserId ?? p.userId,
              agentUserId: agent.id,
              workspaceId: column.workspaceId,
              action: probe.action,
              profileSlug: probe.profileSlug,
              door: "chat",
            });
            return {
              probeKey: probe.key,
              verdict: matrixVerdictOf(r.outcome),
              rung: r.rung,
              reason: r.reason,
              ruleId: r.winningRule?.ruleId ?? null,
            };
          })
        );
        cells[column.id] = cellOfAnswers(answers);
      }
      return {
        agentUserId: agent.id,
        name: agent.name ?? agent.agentType ?? "Agent",
        agentType: agent.agentType,
        hostUserId: agent.hostUserId,
        paused: !!agent.pausedAt,
        cells,
      };
    }),
    CONCURRENCY
  );

  const collapse = (members: readonly MatrixAgentRow[]) =>
    Object.fromEntries(
      columns.map((c) => [c.id, collapseCells(members.map((m) => m.cells[c.id]!))])
    );
  const groups: MatrixTypeGroup[] = [];
  for (const agentType of [...new Set(rows.map((r) => r.agentType ?? "agent"))]) {
    const ofType = rows.filter((r) => (r.agentType ?? "agent") === agentType);
    const computers: MatrixComputerGroup[] = [];
    for (const hostUserId of [...new Set(ofType.map((r) => r.hostUserId))]) {
      const onHost = ofType.filter((r) => r.hostUserId === hostUserId);
      computers.push({
        hostUserId,
        label: hostUserId ? (hostNames.get(hostUserId) ?? "Computer") : "No computer",
        cells: collapse(onHost),
        agents: onHost,
      });
    }
    groups.push({ agentType, cells: collapse(ofType), computers });
  }

  const agentsOmitted = allAgents.length - agents.length;
  return {
    lens: p.lens,
    columns,
    groups,
    partial:
      agentsOmitted > 0 || columnsOmitted > 0
        ? { agentsOmitted, columnsOmitted }
        : null,
  };
}
