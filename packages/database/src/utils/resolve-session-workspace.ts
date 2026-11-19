/**
 * `resolveSessionWorkspacePlacement` — the space a NEW session sits in, read
 * from its chain (work-model plan 8daa514b, W3; founder decisions D1 a, D9 a).
 *
 * WHY: a session's space defaulted to null and every agent was told to omit
 * it, so 35% of work sessions (70% in the week of 18 Nov 2026) had no space:
 * they counted at pod level, never in the space they worked for, and a space's
 * pillar read "stale" while its work ran outside it.
 *
 * The ladder, first rung that answers wins:
 *   1. explicit — what the caller passed. Always wins, never checked here
 *      (the governance membrane decides it, as before);
 *   2. playbook — the space of the playbook the session follows;
 *   3. subject — the space of the entity the session is about (its own, or
 *      the space a pod-wide record was filed for);
 *   4. parent — the space of the session it was pushed from (owned by the
 *      same person);
 *   5. project_home — the project's home space (`projects.workspace_id`);
 *   6. focus — the acting agent's declared workspace focus, last: a hint,
 *      not a home.
 *
 * A DERIVED rung (2–6) counts only when the actor (the agent when there is
 * one, else the person) is a member of that space with a role that may write
 * there, and the space is not archived. Otherwise the next rung answers. So
 * the ladder never turns a start into a `workspace.join` proposal or a denial
 * the caller did not ask for: a space the actor cannot write is skipped, the
 * same rule the MCP lens applies (`routers/mcp/adapter.ts`).
 *
 * Runs before `checkPermissionOrPropose`: the space is the session's
 * governance home. No rung infers: each reads a fact the caller already holds.
 * Nothing answers ⇒ null, as before.
 */

import { and, eq, isNull } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type * as schema from "../schema/index.js";
import { entities } from "../schema/entities.js";
import { focusSessions } from "../schema/focus-sessions.js";
import { playbooks } from "../schema/playbooks.js";
import { projects } from "../schema/projects.js";
import { workspaceMembers, workspaces } from "../schema/workspaces.js";
import { hasRolePermission, type UserRole } from "./permissions.js";

export const SESSION_WORKSPACE_RUNGS = [
  "explicit",
  "playbook",
  "subject",
  "parent",
  "project_home",
  "focus",
] as const;
export type SessionWorkspaceRung = (typeof SESSION_WORKSPACE_RUNGS)[number];

/**
 * `focus_sessions.metadata` key: which rung placed the session
 * (`{ rung }`). Server-owned. Read by the app-grant reach rule
 * (`access/session-counted-spaces.ts`, decision D2 a): a session the LADDER
 * placed keeps the project-wide reach it had when it had no space.
 */
export const SESSION_WORKSPACE_PLACEMENT_KEY = "workspacePlacement";

export interface SessionWorkspaceContext {
  /** The session's owner. Floors the parent rung. */
  userId: string;
  /** The agent acting, if any: the membership is checked for it. */
  agentUserId?: string | null;
  explicitWorkspaceId?: string | null;
  playbookId?: string | null;
  /** Already floored by the caller (the subject must be visible to it). */
  subjectEntityId?: string | null;
  parentSessionId?: string | null;
  /** The session's project (after the project ladder). */
  projectId?: string | null;
  /**
   * The acting agent's workspace focus, read by the caller. A function so the
   * read happens only when every rung above it is empty.
   */
  focusWorkspaceId?: () => Promise<string | null>;
}

export interface SessionWorkspacePlacement {
  workspaceId: string | null;
  rung: SessionWorkspaceRung | null;
}

type Db = PostgresJsDatabase<typeof schema>;

/** The metadata stamp for a placement (`{}` when nothing placed it). */
export function workspacePlacementPatch(
  placement: SessionWorkspacePlacement
): Record<string, { rung: SessionWorkspaceRung }> {
  return placement.workspaceId && placement.rung
    ? { [SESSION_WORKSPACE_PLACEMENT_KEY]: { rung: placement.rung } }
    : {};
}

/** Can `actorId` write in `workspaceId` (a member, a writing role, not archived)? */
async function actorCanWriteIn(
  db: Db,
  actorId: string,
  workspaceId: string
): Promise<boolean> {
  const [row] = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, actorId),
        isNull(workspaces.archivedAt)
      )
    )
    .limit(1);
  return !!row && hasRolePermission(row.role as UserRole, "write");
}

export async function resolveSessionWorkspacePlacement(
  db: Db,
  ctx: SessionWorkspaceContext
): Promise<SessionWorkspacePlacement> {
  if (ctx.explicitWorkspaceId) {
    return { workspaceId: ctx.explicitWorkspaceId, rung: "explicit" };
  }
  const actorId = ctx.agentUserId || ctx.userId;

  const rungs: Array<[SessionWorkspaceRung, () => Promise<string | null>]> = [
    [
      "playbook",
      async () => {
        if (!ctx.playbookId) return null;
        const [row] = await db
          .select({ workspaceId: playbooks.workspaceId })
          .from(playbooks)
          .where(eq(playbooks.id, ctx.playbookId))
          .limit(1);
        return row?.workspaceId ?? null;
      },
    ],
    [
      "subject",
      async () => {
        if (!ctx.subjectEntityId) return null;
        const [row] = await db
          .select({
            workspaceId: entities.workspaceId,
            homeWorkspaceId: entities.homeWorkspaceId,
          })
          .from(entities)
          .where(eq(entities.id, ctx.subjectEntityId))
          .limit(1);
        return row?.workspaceId ?? row?.homeWorkspaceId ?? null;
      },
    ],
    [
      "parent",
      async () => {
        if (!ctx.parentSessionId) return null;
        const [row] = await db
          .select({ workspaceId: focusSessions.workspaceId })
          .from(focusSessions)
          .where(
            and(
              eq(focusSessions.id, ctx.parentSessionId),
              eq(focusSessions.userId, ctx.userId)
            )
          )
          .limit(1);
        return row?.workspaceId ?? null;
      },
    ],
    [
      "project_home",
      async () => {
        if (!ctx.projectId) return null;
        const [row] = await db
          .select({ workspaceId: projects.workspaceId })
          .from(projects)
          .where(eq(projects.id, ctx.projectId))
          .limit(1);
        return row?.workspaceId ?? null;
      },
    ],
    ["focus", async () => (ctx.focusWorkspaceId ? ctx.focusWorkspaceId() : null)],
  ];

  for (const [rung, read] of rungs) {
    const workspaceId = await read();
    if (workspaceId && (await actorCanWriteIn(db, actorId, workspaceId))) {
      return { workspaceId, rung };
    }
  }
  return { workspaceId: null, rung: null };
}

/**
 * The stamp for a start approved from a proposal: the rung the proposing door
 * recorded (`data.workspacePlacement`), when it names one and the proposal
 * carries a space. Anything else in the payload stamps nothing.
 */
export function workspacePlacementPatchFromProposal(
  rung: unknown,
  workspaceId: string | null
): Record<string, { rung: SessionWorkspaceRung }> {
  return typeof rung === "string" &&
    (SESSION_WORKSPACE_RUNGS as readonly string[]).includes(rung)
    ? workspacePlacementPatch({
        workspaceId,
        rung: rung as SessionWorkspaceRung,
      })
    : {};
}
