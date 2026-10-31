/**
 * ASSIGN and PAUSE an agent — the two person-only writes THE route reads
 * (`route.ts`, agent routing W1b).
 *
 *   assign  participant(agent) --assigned_to--> playbook | profile | project |
 *           workspace. The agent that takes that target's work when nobody
 *           named one. ONE agent per target PER OWNER (unique index, 0329):
 *           assigning replaces only this owner's previous agent on it, in one
 *           transaction — a teammate's assignment in a shared space stays.
 *   pause   `users.agent_paused_at`. The route skips a paused agent when it
 *           picks for a person and refuses it by name. Keys are untouched.
 *
 * Both are HUMAN-ONLY (the procedure refuses an agent key: an agent that could
 * assign or un-pause itself could staff itself onto anyone's work) and limited
 * to the agent's owner or a pod admin — the same gate as `setBinding`.
 */

import { TRPCError } from "@trpc/server";
import {
  db,
  and,
  drizzleSql,
  eq,
  inArray,
  isUniqueViolation,
  links,
  playbooks,
  profiles,
  projects,
  users,
} from "@synap/database";
import { isPodAdmin } from "../../utils/workspace-role.js";
import { auditLog } from "../../utils/audit-log.js";
import { createLink } from "../links/links-service.js";
import { checkLinkEndpointVisible } from "../../routers/hub-protocol/rest/link-endpoint-visibility.js";
import type { AssignmentTarget } from "./route.js";

/**
 * Why an assign or pause was refused, on the error's `cause.reasonCode` — the
 * Hub REST door answers them as `{ error, reasonCode }`.
 */
export const ASSIGNMENT_REASON_CODES = {
  /** No agent user with that id. */
  agentNotFound: "NOT_FOUND",
  /** The caller is neither the agent's owner nor a pod admin. */
  notOwner: "NOT_OWNER",
  /** The target does not exist or the person cannot see it. */
  targetNotFound: "TARGET_NOT_FOUND",
} as const;

/**
 * The space a target lives in — what a key's grant is checked against when it
 * assigns (an app's write permissions are always pinned to spaces). A space is
 * itself; a playbook, kind or project is its row's `workspace_id`, null when
 * it is pod-wide (then only a grant not pinned to spaces permits it).
 */
export async function assignmentTargetWorkspaceId(target: {
  type: AssignmentTarget;
  id: string;
}): Promise<string | null> {
  switch (target.type) {
    case "workspace":
      return target.id;
    case "playbook": {
      const [row] = await db
        .select({ workspaceId: playbooks.workspaceId })
        .from(playbooks)
        .where(eq(playbooks.id, target.id))
        .limit(1);
      return row?.workspaceId ?? null;
    }
    case "profile": {
      const [row] = await db
        .select({ workspaceId: profiles.workspaceId })
        .from(profiles)
        .where(eq(profiles.id, target.id))
        .limit(1);
      return row?.workspaceId ?? null;
    }
    case "project": {
      const [row] = await db
        .select({ workspaceId: projects.workspaceId })
        .from(projects)
        .where(eq(projects.id, target.id))
        .limit(1);
      return row?.workspaceId ?? null;
    }
  }
}

async function loadManagedAgent(callerId: string, agentUserId: string) {
  const [agent] = await db
    .select({ id: users.id, createdByUserId: users.createdByUserId })
    .from(users)
    .where(and(eq(users.id, agentUserId), eq(users.userType, "agent")))
    .limit(1);
  if (!agent) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Agent user not found",
      cause: { reasonCode: ASSIGNMENT_REASON_CODES.agentNotFound },
    });
  }
  const isOwner = !!agent.createdByUserId && agent.createdByUserId === callerId;
  if (!isOwner && !(await isPodAdmin(callerId))) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Only the agent's owner or a pod admin can change this",
      cause: { reasonCode: ASSIGNMENT_REASON_CODES.notOwner },
    });
  }
  return {
    id: agent.id,
    ownerId: agent.createdByUserId ?? "",
    by: isOwner ? "owner" : "pod_admin",
  } as const;
}

export async function setAgentAssignment(p: {
  callerId: string;
  agentUserId: string;
  target: { type: AssignmentTarget; id: string };
  /** false = remove this agent's assignment to the target. */
  assigned: boolean;
  /**
   * Runs once the agent and the target are known to the caller, before
   * anything is written, with the target's space: a key-auth door checks the
   * key's grant there (`assertKeyMayWrite`). It refuses by throwing.
   */
  authorize?: (scope: {
    workspaceId: string | null;
    projectId: string | null;
  }) => Promise<void>;
}): Promise<{
  agentUserId: string;
  target: { type: AssignmentTarget; id: string };
  assigned: boolean;
  replaced: string[];
}> {
  const agent = await loadManagedAgent(p.callerId, p.agentUserId);
  // The target must be one the person can see — the links door's own floor.
  const refusal = await checkLinkEndpointVisible(
    p.target.type,
    p.target.id,
    p.callerId,
    null
  );
  if (refusal) {
    throw new TRPCError({
      code: refusal.status === 403 ? "FORBIDDEN" : "NOT_FOUND",
      message: refusal.error,
      cause: { reasonCode: ASSIGNMENT_REASON_CODES.targetNotFound },
    });
  }
  if (p.authorize) {
    await p.authorize({
      workspaceId: await assignmentTargetWorkspaceId(p.target),
      projectId: p.target.type === "project" ? p.target.id : null,
    });
  }

  const replaced = await db
    .transaction(async (tx) => {
      const dropped = await tx
        .delete(links)
        .where(
          and(
            eq(links.linkType, "assigned_to"),
            eq(links.toType, p.target.type),
            eq(links.toId, p.target.id),
            // Removing: only THIS agent's edge. Assigning: this owner's agent on
            // the target — never a teammate's.
            p.assigned
              ? drizzleSql`COALESCE(${links.metadata}->>'ownerId', '') = ${agent.ownerId}`
              : eq(links.fromId, agent.id)
          )
        )
        .returning({ fromId: links.fromId });
      if (p.assigned) {
        await createLink(
          {
            workspaceId: p.target.type === "workspace" ? p.target.id : null,
            fromType: "participant",
            fromId: agent.id,
            toType: p.target.type,
            toId: p.target.id,
            linkType: "assigned_to",
            metadata: { assignedBy: p.callerId, ownerId: agent.ownerId },
          },
          tx
        );
      }
      return dropped.map((d) => d.fromId).filter((id) => id !== agent.id);
    })
    .catch((err: unknown) => {
      // Two concurrent assigns of one target: the unique index refuses the
      // second — said as a conflict, never a 500.
      if (isUniqueViolation(err)) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Someone assigned this at the same time — try again",
        });
      }
      throw err;
    });

  await auditLog({
    subjectType: "link",
    action: p.assigned ? "create" : "delete",
    phase: "completed",
    subjectId: agent.id,
    userId: p.callerId,
    data: {
      linkType: "assigned_to",
      agentUserId: agent.id,
      target: p.target,
      replacedAgentUserIds: replaced,
      by: agent.by,
    },
  });
  return {
    agentUserId: agent.id,
    target: p.target,
    assigned: p.assigned,
    replaced,
  };
}

export async function setAgentPaused(p: {
  callerId: string;
  agentUserId: string;
  paused: boolean;
}): Promise<{ agentUserId: string; pausedAt: string | null }> {
  const agent = await loadManagedAgent(p.callerId, p.agentUserId);
  const pausedAt = p.paused ? new Date() : null;
  await db
    .update(users)
    .set({
      agentPausedAt: pausedAt,
      agentPausedBy: p.paused ? p.callerId : null,
    })
    .where(eq(users.id, agent.id));
  await auditLog({
    subjectType: "agent_user",
    action: "update",
    phase: "completed",
    subjectId: agent.id,
    userId: p.callerId,
    data: { paused: p.paused, by: agent.by },
  });
  return { agentUserId: agent.id, pausedAt: pausedAt?.toISOString() ?? null };
}

/**
 * The agent `ownerId` assigned to `target` — the per-owner row setAgentAssignment
 * writes (`metadata.ownerId` = the agent's owner, one per target, 0329) — or
 * null when that person assigned nobody there. A failed read throws.
 */
export async function readAgentAssignment(p: {
  ownerId: string;
  target: { type: AssignmentTarget; id: string };
}): Promise<{
  agentUserId: string;
  agentName: string | null;
  assignedAt: string;
} | null> {
  const [row] = await db
    .select({
      agentUserId: links.fromId,
      agentName: users.name,
      assignedAt: links.createdAt,
    })
    .from(links)
    .innerJoin(users, eq(users.id, links.fromId))
    .where(
      and(
        eq(links.linkType, "assigned_to"),
        eq(links.fromType, "participant"),
        eq(links.toType, p.target.type),
        eq(links.toId, p.target.id),
        drizzleSql`${links.metadata}->>'ownerId' = ${p.ownerId}`
      )
    )
    .limit(1);
  if (!row) return null;
  return {
    agentUserId: row.agentUserId,
    agentName: row.agentName ?? null,
    assignedAt: new Date(row.assignedAt).toISOString(),
  };
}

/** Each agent's assignment targets (batched, for roster reads). */
export async function loadAgentAssignments(
  agentUserIds: readonly string[]
): Promise<Map<string, Array<{ type: AssignmentTarget; id: string }>>> {
  const out = new Map<string, Array<{ type: AssignmentTarget; id: string }>>();
  if (agentUserIds.length === 0) return out;
  const rows = await db
    .select({ fromId: links.fromId, toType: links.toType, toId: links.toId })
    .from(links)
    .where(
      and(
        eq(links.linkType, "assigned_to"),
        eq(links.fromType, "participant"),
        inArray(links.fromId, [...new Set(agentUserIds)])
      )
    );
  for (const r of rows) {
    const list = out.get(r.fromId) ?? [];
    list.push({ type: r.toType as AssignmentTarget, id: r.toId });
    out.set(r.fromId, list);
  }
  return out;
}
