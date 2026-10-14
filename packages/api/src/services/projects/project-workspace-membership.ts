/**
 * `setProjectWorkspaceMembershipGoverned` — link or unlink a workspace to a
 * project (`project --uses--> workspace`, the project's cross-cutting INDEX),
 * governed. Moved verbatim out of tRPC `projects.setWorkspaceMembership` so
 * `createProjectGoverned` can link the spaces a new project uses through the
 * SAME rules instead of a second link writer.
 *
 * Order (load-bearing):
 *   1. the project must be visible (`loadVisibleProject`) — a foreign id never
 *      gets a `uses` edge, nor a proposal for one;
 *   2. the workspace endpoint floor (`checkLinkEndpointsVisible`) BEFORE the
 *      gate — an unreachable workspace must not become a proposal the approval
 *      would never resolve;
 *   3. governance at POD scope (`workspaceId: undefined`): a project is a
 *      cross-cutting lens and lives outside any single workspace. An agent
 *      always proposes; a human may auto-apply per their governance rule;
 *   4. the write through the ONE edge door (`linkProjectToWorkspace` /
 *      `unlinkProjectFromWorkspace`) + the auto-approved undo stamp.
 *
 * Throws `TRPCError` (NOT_FOUND / FORBIDDEN); callers map it onto their wire.
 */

import { TRPCError } from "@trpc/server";
import { getDb } from "@synap/database";
import { checkPermissionOrPropose } from "../../utils/permission-check.js";
import {
  linkProjectToWorkspace,
  unlinkProjectFromWorkspace,
} from "../../utils/project-workspace.js";
import { checkLinkEndpointsVisible } from "../../routers/hub-protocol/rest/link-endpoint-visibility.js";
import { stampAutoApprovedCreate } from "../proposals/stamp-materialized.js";
import { loadVisibleProject } from "./load-visible-project.js";

export interface SetProjectWorkspaceMembershipInput {
  userId: string;
  /** Present ⇒ an AGENT authored this: the gate attributes and proposes. */
  agentUserId?: string | null;
  projectId: string;
  workspaceId: string;
  member: boolean;
  /** Which door asked — the undo stamp's provenance. */
  door: string;
}

export type SetProjectWorkspaceMembershipOutcome =
  { status: "updated" } | { status: "proposed"; proposalId: string };

export async function setProjectWorkspaceMembershipGoverned(
  input: SetProjectWorkspaceMembershipInput
): Promise<SetProjectWorkspaceMembershipOutcome> {
  const db = await getDb();
  const { userId, projectId, workspaceId, member } = input;

  // 1. The PROJECT must be visible first — same floor as `get`, `automations`,
  // `fileEntities`, etc.
  const project = await loadVisibleProject(db, projectId, userId);
  if (!project) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Project not found" });
  }

  // 2. Endpoint floor: the workspace must be visible to the caller BEFORE we
  // ask governance to decide.
  const endpointRefusal = await checkLinkEndpointsVisible(
    {
      fromType: "project",
      fromId: projectId,
      toType: "workspace",
      toId: workspaceId,
    },
    userId,
    workspaceId
  );
  if (endpointRefusal) {
    throw new TRPCError({ code: "FORBIDDEN", message: endpointRefusal.error });
  }

  // 3. Governance at pod scope.
  const perm = await checkPermissionOrPropose({
    userId,
    agentUserId: input.agentUserId ?? undefined,
    workspaceId: undefined,
    subjectType: "link",
    action: member ? "create" : "delete",
    reasoning: member
      ? "Project uses workspace (INDEX, not ACL)"
      : "Project no longer uses workspace",
    data: {
      title: member
        ? "project --uses--> workspace"
        : "remove project --uses--> workspace",
      fromType: "project",
      fromId: projectId,
      toType: "workspace",
      toId: workspaceId,
      linkType: "uses",
    },
  });
  if ("denied" in perm && perm.denied) {
    throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
  }
  if ("proposalId" in perm) {
    return { status: "proposed", proposalId: perm.proposalId };
  }

  // 4. Write.
  if (member) {
    const result = await linkProjectToWorkspace(db, {
      projectId,
      workspaceId,
      userId,
    });
    if (!result.linked) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message:
          result.reason === "workspace_not_found"
            ? "Workspace not found"
            : "Project not found",
      });
    }
    // Stamp an undo record for the auto-approved case so the edge can be
    // rolled back without losing provenance.
    await stampAutoApprovedCreate({
      receiptId: "granted" in perm ? perm.autoApprovedProposalId : undefined,
      record: result.linkId ? { linkIds: [result.linkId] } : {},
      door: input.door,
    });
    return { status: "updated" };
  }

  const removed = await unlinkProjectFromWorkspace(db, {
    projectId,
    workspaceId,
    userId,
  });
  if (!removed.unlinked) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Project not found" });
  }
  return { status: "updated" };
}
