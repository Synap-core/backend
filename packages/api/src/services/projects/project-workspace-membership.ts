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
 *      would never resolve. ONE relaxation, removal only: the project's OWNER
 *      may remove an edge to an ARCHIVED workspace (`archivedUsesTargetRemovable`);
 *   3. governance at POD scope (`workspaceId: undefined`): a project is a
 *      cross-cutting lens and lives outside any single workspace. An agent
 *      always proposes; a human may auto-apply per their governance rule;
 *   4. the write through the ONE edge door (`linkProjectToWorkspace` /
 *      `unlinkProjectFromWorkspace`) + the auto-approved undo stamp.
 *
 * THE governed `uses` writer for every door: tRPC `projects.setWorkspaceMembership`,
 * `createProjectGoverned`'s `usedWorkspaceIds`, and MCP
 * `synap_project_use_workspace` (which used to govern and write on its own,
 * gated in the workspace instead of at pod scope). `purpose` — what the
 * project needs from the space, the PILLAR's line — rides the gate payload,
 * so an approval replays it (`executors/catch-all.ts` → `linkProjectToWorkspace`).
 * The ungoverned system writers (pack install) stay where they are.
 *
 * Throws `TRPCError` (NOT_FOUND / FORBIDDEN); callers map it onto their wire.
 */

import { TRPCError } from "@trpc/server";
import { getDb } from "@synap/database";
import { checkPermissionOrPropose } from "../../utils/permission-check.js";
import {
  archivedUsesTargetRemovable,
  countProjectPillarGoals,
  linkProjectToWorkspace,
  unlinkProjectFromWorkspace,
  USES_PURPOSE_KEY,
  USES_PURPOSE_MAX,
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
  /**
   * What the project needs from this space (`uses` `metadata.purpose`), on an
   * ADD only: a string sets it, `null` clears it, absent leaves it. Re-linking
   * an existing edge with a purpose changes only the purpose.
   */
  purpose?: string | null;
  /** Why, in the caller's words — shown to the reviewer of a proposal. */
  reasoning?: string;
  /** The session the caller works in; the gate files the write under it. */
  sessionId?: string | null;
  /** Which door asked — the undo stamp's provenance. */
  door: string;
}

export type SetProjectWorkspaceMembershipOutcome =
  | { status: "updated"; effect: "linked" }
  /** `rows` = the edges actually removed (`0` = there was none). */
  | {
      status: "updated";
      effect: "unlinked";
      rows: number;
      /** Goals of the project that advanced the space (their edges went too). */
      goalsStoppedAdvancing: number;
    }
  | {
      status: "proposed";
      proposalId: string;
      reviewPath?: string;
      reviewUrl?: string;
      /** On a removal: goals that will stop advancing the space. */
      goalsStopAdvancing?: number;
    };

/** A purpose as stored: trimmed, `null` when blank. */
function normalizePurpose(
  purpose: string | null | undefined
): string | null | undefined {
  if (purpose === undefined || purpose === null) return purpose;
  const line = purpose.trim();
  if (line.length > USES_PURPOSE_MAX) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `A pillar's purpose is at most ${USES_PURPOSE_MAX} characters.`,
    });
  }
  return line === "" ? null : line;
}

export async function setProjectWorkspaceMembershipGoverned(
  input: SetProjectWorkspaceMembershipInput
): Promise<SetProjectWorkspaceMembershipOutcome> {
  const db = await getDb();
  const { userId, projectId, workspaceId, member } = input;
  if (!member && input.purpose !== undefined) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "A purpose is set when the project uses the space, not when it stops.",
    });
  }
  const purpose = normalizePurpose(input.purpose);

  // 1. The PROJECT must be visible first — same floor as `get`, `automations`,
  // `fileEntities`, etc.
  const project = await loadVisibleProject(db, projectId, userId);
  if (!project) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Project not found" });
  }

  // 2. Endpoint floor: the workspace must be visible to the caller BEFORE we
  // ask governance to decide. REMOVAL ONLY: an edge to an ARCHIVED workspace
  // stays removable by the project's owner (the floor refuses any archived
  // workspace) — still governed below.
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
  if (
    endpointRefusal &&
    !(
      !member &&
      (await archivedUsesTargetRemovable(db, {
        projectId,
        workspaceId,
        userId,
      }))
    )
  ) {
    throw new TRPCError({ code: "FORBIDDEN", message: endpointRefusal.error });
  }

  // What a removal also stops, said to the approver before it is filed.
  const goalsStopAdvancing = member
    ? 0
    : await countProjectPillarGoals(db, { projectId, workspaceId });
  const cascadeNote =
    goalsStopAdvancing === 0
      ? ""
      : goalsStopAdvancing === 1
        ? " 1 goal stops advancing this space."
        : ` ${goalsStopAdvancing} goals stop advancing this space.`;

  // 3. Governance at pod scope.
  const perm = await checkPermissionOrPropose({
    userId,
    agentUserId: input.agentUserId ?? undefined,
    workspaceId: undefined,
    subjectType: "link",
    action: member ? "create" : "delete",
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    reasoning:
      (input.reasoning?.trim() ||
        (member
          ? "Project uses workspace (INDEX, not ACL)"
          : "Project no longer uses workspace")) + cascadeNote,
    data: {
      title: member
        ? "project --uses--> workspace"
        : "remove project --uses--> workspace",
      fromType: "project",
      fromId: projectId,
      toType: "workspace",
      toId: workspaceId,
      linkType: "uses",
      ...(goalsStopAdvancing > 0 ? { goalsStopAdvancing } : {}),
      // The approval replays it (`executors/catch-all.ts`).
      ...(purpose !== undefined
        ? { metadata: { [USES_PURPOSE_KEY]: purpose } }
        : {}),
    },
  });
  if ("denied" in perm && perm.denied) {
    throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
  }
  if ("proposalId" in perm) {
    return {
      status: "proposed",
      proposalId: perm.proposalId,
      ...(perm.reviewPath ? { reviewPath: perm.reviewPath } : {}),
      ...(perm.reviewUrl ? { reviewUrl: perm.reviewUrl } : {}),
      ...(goalsStopAdvancing > 0 ? { goalsStopAdvancing } : {}),
    };
  }

  // 4. Write.
  if (member) {
    const result = await linkProjectToWorkspace(db, {
      projectId,
      workspaceId,
      userId,
      ...(purpose !== undefined ? { purpose } : {}),
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
    return { status: "updated", effect: "linked" };
  }

  const removed = await unlinkProjectFromWorkspace(db, {
    projectId,
    workspaceId,
    userId,
    attribution: {
      agentUserId: input.agentUserId ?? null,
      proposalId:
        "granted" in perm ? (perm.autoApprovedProposalId ?? null) : null,
      sessionId: input.sessionId ?? null,
    },
  });
  if (!removed.unlinked) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Project not found" });
  }
  return {
    status: "updated",
    effect: "unlinked",
    rows: removed.rows,
    goalsStoppedAdvancing: goalsStopAdvancing,
  };
}
