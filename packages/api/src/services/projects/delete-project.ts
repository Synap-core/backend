/**
 * `deleteProjectGoverned` — the ONE governed path a project is deleted through.
 *
 * The sibling of `updateProjectGoverned`. The tRPC `projects.delete` (browser,
 * relay, the `project/delete` approve executor) and the Hub REST
 * `DELETE /projects/:id` each built the gate and the write by hand, and the
 * REST copy had drifted into a hole: it loaded nothing, gave the gate NO
 * workspace (so the membership RBAC step never ran — the gate treats a write
 * with no workspace as the caller's own pod-scoped resource), and
 * `ProjectRepository.delete` filters on the id alone. Any key holding
 * `hub-protocol.write` could hard-delete ANY user's project by id. It also
 * fired no audit row and no `project.delete` side effects.
 *
 * Order (load-bearing):
 *   1. load on the visibility floor (`loadVisibleProject`) — an invisible
 *      project is NOT_FOUND BEFORE governance, so no proposal is ever filed
 *      against a foreign id and no existence oracle is created;
 *   2. governance on the PROJECT's workspace (never the caller's lens): a
 *      workspace project runs membership RBAC (a role below `delete` proposes
 *      to the workspace's reviewers or is denied), a pod-personal project is
 *      already owner-only by step 1; an agent always proposes (destructive
 *      floor);
 *   3. delete → audit → side effects.
 *
 * Throws `TRPCError` (NOT_FOUND / FORBIDDEN); the REST door maps it with
 * `httpStatusForTrpcError`.
 */

import { TRPCError } from "@trpc/server";
import {
  getDb,
  EventRepository,
  sql,
  ProjectRepository,
} from "@synap/database";
import { emitSideEffects } from "@synap/events";
import { checkPermissionOrPropose } from "../../utils/permission-check.js";
import { auditLog } from "../../utils/audit-log.js";
import { loadVisibleProject } from "./load-visible-project.js";

export interface DeleteProjectGovernedInput {
  id: string;
  userId: string;
  /** Present ⇒ an AGENT asked: the gate attributes and proposes. */
  agentUserId?: string | null;
}

export type DeleteProjectGovernedOutcome =
  | { status: "deleted" }
  | {
      status: "proposed";
      proposalId: string;
      reviewPath?: string;
      reviewUrl?: string;
    };

export async function deleteProjectGoverned(
  input: DeleteProjectGovernedInput
): Promise<DeleteProjectGovernedOutcome> {
  const db = await getDb();
  const target = await loadVisibleProject(db, input.id, input.userId);
  if (!target) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Project not found" });
  }
  const workspaceId = target.workspaceId ?? undefined;

  const perm = await checkPermissionOrPropose({
    userId: input.userId,
    ...(input.agentUserId ? { agentUserId: input.agentUserId } : {}),
    workspaceId,
    subjectType: "project",
    action: "delete",
    data: { id: input.id },
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
    };
  }

  const repo = new ProjectRepository(db, new EventRepository(sql));
  await repo.delete(input.id, input.userId);

  auditLog({
    subjectType: "project",
    action: "delete",
    phase: "completed",
    subjectId: input.id,
    userId: input.userId,
    workspaceId,
  });
  emitSideEffects({
    subjectType: "project",
    action: "delete",
    subjectId: input.id,
    userId: input.userId,
    workspaceId,
  });

  return { status: "deleted" };
}
