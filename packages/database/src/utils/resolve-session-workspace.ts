/**
 * `resolveSessionWorkspacePlacement` — the space a NEW session sits in, read
 * from its chain (work-model plan 8daa514b, W3; founder decisions D1 a, D9 a).
 * Without it a session's space defaulted to null: it counted at pod level,
 * never in the space it worked for.
 *
 * The ladder, first rung that answers wins:
 *   1. explicit — what the caller passed. Always wins, never checked here
 *      (the governance membrane decides it, as before). A caller that copies
 *      another session's space passes that session's rung with it
 *      (`explicitRung`), so the copy keeps the source's reach;
 *   2. playbook — the space of the playbook the session follows;
 *   3. subject — the space of the entity the session is about (its own, or
 *      the space a pod-wide record was filed for);
 *   4. parent — the space of the session it was pushed from (owned by the
 *      same person);
 *   5. project_home — the project's home space (`projects.workspace_id`);
 *   6. focus — the acting agent's declared workspace focus, last: a hint,
 *      not a home.
 *
 * A DERIVED rung (2–6) counts only for a live (not archived) space the
 * caller's own write check admits (`mayPlaceIn`): the governance gate's check
 * for a governed start (`gateAdmitsWorkspace`, `permission-check.ts`), the
 * membership rule for an ungated run (`workspaceMemberMayWrite`). Otherwise
 * the next rung answers, so the ladder never turns a start into a
 * `workspace.join` proposal or a denial the caller did not ask for.
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
import { workspaces } from "../schema/workspaces.js";
import { verifyPermission } from "./permissions.js";

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
 * The rungs that stand in for "no space" (decision D2 a): before the ladder a
 * session they place had no space, and counted in every space its project
 * uses for an app grant. It keeps that reach. `explicit` and `focus` place a
 * session where the caller (or its declared focus) put it, as before the
 * ladder: one space.
 */
export const PROJECT_REACH_RUNGS: readonly SessionWorkspaceRung[] = [
  "playbook",
  "subject",
  "parent",
  "project_home",
];

/**
 * `focus_sessions.metadata` key: which rung placed the session
 * (`{ rung }`). Server-owned. Read by the app-grant reach rule
 * (`access/session-counted-spaces.ts`) and carried by every door that copies
 * a session's space into a new session.
 */
export const SESSION_WORKSPACE_PLACEMENT_KEY = "workspacePlacement";

/** The rung stamped on a session's metadata, or null (none, or malformed). */
export function readWorkspacePlacementRung(
  metadata: unknown
): SessionWorkspaceRung | null {
  const placement =
    metadata && typeof metadata === "object"
      ? (metadata as Record<string, unknown>)[SESSION_WORKSPACE_PLACEMENT_KEY]
      : undefined;
  const rung =
    placement && typeof placement === "object"
      ? (placement as Record<string, unknown>).rung
      : undefined;
  return typeof rung === "string" &&
    (SESSION_WORKSPACE_RUNGS as readonly string[]).includes(rung)
    ? (rung as SessionWorkspaceRung)
    : null;
}

export interface SessionWorkspaceContext {
  /** The session's owner. Floors the parent rung. */
  userId: string;
  explicitWorkspaceId?: string | null;
  /**
   * With `explicitWorkspaceId` copied from another session: the rung that
   * placed that session (`readWorkspacePlacementRung`). Absent ⇒ `explicit`.
   */
  explicitRung?: SessionWorkspaceRung | null;
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
  /** The caller's own write check for a candidate space (see the module doc). */
  mayPlaceIn: (workspaceId: string) => Promise<boolean>;
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

/**
 * The membership rule an ungated run is placed by: `actorId` is a member of
 * `workspaceId` whose role may write — `verifyPermission`, the rule the
 * governance gate's own check starts from.
 */
export async function workspaceMemberMayWrite(
  db: Db,
  actorId: string,
  workspaceId: string
): Promise<boolean> {
  const result = await verifyPermission({
    db,
    userId: actorId,
    workspace: { id: workspaceId },
    requiredPermission: "write",
  });
  return result.allowed;
}

async function isLiveWorkspace(db: Db, workspaceId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(and(eq(workspaces.id, workspaceId), isNull(workspaces.archivedAt)))
    .limit(1);
  return !!row;
}

export async function resolveSessionWorkspacePlacement(
  db: Db,
  ctx: SessionWorkspaceContext
): Promise<SessionWorkspacePlacement> {
  if (ctx.explicitWorkspaceId) {
    return {
      workspaceId: ctx.explicitWorkspaceId,
      rung: "explicit",
    };
  }

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
    [
      "focus",
      async () => (ctx.focusWorkspaceId ? ctx.focusWorkspaceId() : null),
    ],
  ];

  for (const [rung, read] of rungs) {
    const workspaceId = await read();
    if (
      workspaceId &&
      (await isLiveWorkspace(db, workspaceId)) &&
      (await ctx.mayPlaceIn(workspaceId))
    ) {
      return { workspaceId, rung };
    }
  }
  return { workspaceId: null, rung: null };
}

/**
 * The stamp for a start approved from a proposal: the rung the proposing door
 * recorded (`data.workspacePlacement`, pinned against revision by
 * `PINNED_PLACEMENT_FIELDS`), when it names one and the proposal carries a
 * space. Anything else in the payload stamps nothing.
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
