/**
 * Workspace operation DOORS (R8a) — the ONE place the Hub REST routes and the
 * MCP tools reach the governed workspace operations:
 *
 *   archive / restore  → `workspacesRouter.archive`        (DESTRUCTIVE / ADMIN floor)
 *   rename             → `workspacesRouter.update`         (ADMIN floor)
 *   move entities      → `entitiesRouter.moveToWorkspace`  (per-entity gate)
 *   grant kind access  → `profilesRouter.grantAccess`      (ADMIN floor)
 *   file into project  → `projectsRouter.fileEntities`     (ACCESS: agent proposes;
 *                         un-file = link/delete, DESTRUCTIVE floor)
 *
 * NOTHING is re-implemented here: every guard, gate, audit row and side effect
 * lives in the router procedure, and each door only builds the caller context
 * (the SAME `createHubProtocolCallerContext` every Hub door uses — it carries
 * the acting agent, so an agent key proposes) and forwards. The precedent is
 * `createProjectGoverned`: two doors, one governed path.
 *
 * A `{ status: "proposed" }` result is returned VERBATIM — `proposed` is the
 * success an agent gets.
 */

import { TRPCError } from "@trpc/server";
import { db, eq, profiles } from "@synap/database";
import { createHubProtocolCallerContext } from "../routers/hub-protocol/utils.js";
import { workspacesRouter } from "../routers/workspaces.js";
import { entitiesRouter } from "../routers/entities.js";
import { profilesRouter } from "../routers/profiles.js";
import { projectsRouter } from "../routers/projects.js";

/** Who is acting — the fields every Hub / MCP door already has in hand. */
export interface WorkspaceOpsActor {
  userId: string;
  scopes: string[];
  agentUserId?: string | null;
  sessionId?: string | null;
  keyType?: string | null;
  keyWorkspaceId?: string | null;
}

async function callerCtx(actor: WorkspaceOpsActor, workspaceId: string | null) {
  return createHubProtocolCallerContext(
    actor.userId,
    actor.scopes,
    workspaceId,
    undefined,
    actor.sessionId ?? null,
    actor.agentUserId ?? null,
    actor.keyType ?? null,
    actor.keyWorkspaceId ?? null
  );
}

/** Archive (or, with `restore`, un-archive) a workspace. */
export async function archiveWorkspaceDoor(
  actor: WorkspaceOpsActor,
  input: { workspaceId: string; restore?: boolean; reasoning?: string }
) {
  const ctx = await callerCtx(actor, input.workspaceId);
  return workspacesRouter.createCaller(ctx).archive({
    workspaceId: input.workspaceId,
    restore: input.restore === true,
    ...(input.reasoning ? { reasoning: input.reasoning } : {}),
  });
}

/** Rename / re-describe a workspace. Settings are deliberately NOT exposed. */
export async function renameWorkspaceDoor(
  actor: WorkspaceOpsActor,
  input: { workspaceId: string; name?: string; description?: string }
) {
  if (input.name === undefined && input.description === undefined) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Provide name and/or description",
    });
  }
  const ctx = await callerCtx(actor, input.workspaceId);
  return workspacesRouter.createCaller(ctx).update({
    id: input.workspaceId,
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.description !== undefined
      ? { description: input.description }
      : {}),
  });
}

/** Move entities into a workspace (best-effort per entity). */
export async function moveEntitiesDoor(
  actor: WorkspaceOpsActor,
  input: { entityIds: string[]; workspaceId: string; reason?: string }
) {
  const ctx = await callerCtx(actor, null);
  return entitiesRouter.createCaller(ctx).moveToWorkspace({
    entityIds: input.entityIds,
    workspaceId: input.workspaceId,
    ...(input.reason ? { reason: input.reason } : {}),
  });
}

/**
 * Grant a workspace access to a SHARED kind. `workspaceId` is the acting lens
 * the procedure resolves the profile in; omitted, it is the profile's HOME
 * workspace — the one whose editors may grant (`assertProfileSchemaWrite`).
 */
export async function grantProfileAccessDoor(
  actor: WorkspaceOpsActor,
  input: {
    profileId: string;
    targetWorkspaceId: string;
    workspaceId?: string;
    reasoning?: string;
  }
) {
  let actingWorkspaceId = input.workspaceId ?? null;
  if (!actingWorkspaceId) {
    const [row] = await db
      .select({ workspaceId: profiles.workspaceId })
      .from(profiles)
      .where(eq(profiles.id, input.profileId))
      .limit(1);
    actingWorkspaceId = row?.workspaceId ?? null;
  }
  if (!actingWorkspaceId) {
    // No home workspace ⇒ not a shared, workspace-owned kind. Same answer the
    // procedure gives for a profile it cannot resolve.
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `Profile not found: ${input.profileId}`,
    });
  }
  const ctx = await callerCtx(actor, actingWorkspaceId);
  return profilesRouter.createCaller(ctx).grantAccess({
    profileId: input.profileId,
    targetWorkspaceId: input.targetWorkspaceId,
    ...(input.reasoning ? { reasoning: input.reasoning } : {}),
  });
}

/**
 * File existing records into a project (or, with `remove`, un-file them). One
 * proposal for the whole batch when an agent acts.
 */
export async function fileIntoProjectDoor(
  actor: WorkspaceOpsActor,
  input: {
    projectId: string;
    entityIds: string[];
    remove?: boolean;
    reasoning?: string;
  }
) {
  const ctx = await callerCtx(actor, null);
  return projectsRouter.createCaller(ctx).fileEntities({
    projectId: input.projectId,
    entityIds: input.entityIds,
    ...(input.remove === true ? { remove: true } : {}),
    ...(input.reasoning ? { reasoning: input.reasoning } : {}),
  });
}
