/**
 * WHO may bind a renderer — the authorization half of the `renderer_bindings`
 * write door.
 *
 * The write itself is `setRendererBinding` / `revokeRendererBinding` in
 * `@synap/database`, which is deliberately PURE: the database layer has no
 * access to `isPodAdmin` or workspace membership, and a copy of either there
 * would be a second, drifting floor. So the floor lives here, in the api layer,
 * and `setProfileRenderer` calls it before every write — one gate, one door.
 *
 * The floor is per SCOPE, because scope is exactly how far a binding reaches:
 *
 *   user      — MY choice, visible to nobody else. Only the acting user may
 *               write it. There is no "admin sets your personal override": a
 *               pod admin writing into another user's scope would be an
 *               invisible impersonation, and the resolver would report it as
 *               that user's own preference.
 *   workspace — editor+ on THAT workspace, or pod admin. Pod admin is NOT
 *               generosity: a sovereign single-user pod's owner legitimately
 *               has no `workspace_members` row (the same gap that hid a pod
 *               owner's own vocabulary from `profiles.list`), and
 *               `requireEditor` answers NOT_FOUND for a non-member — so
 *               membership alone would lock the pod owner out of their own
 *               workspace's renderers.
 *   pod       — pod admin only. A pod binding answers for EVERY workspace and
 *               every user, which is the same blast radius `requirePodAdmin`
 *               already guards for pod-wide capabilities.
 *
 * This is a TIGHTENING for `scope: 'pod'`, which previously had no
 * role floor of its own (it relied on `checkPermissionOrPropose` alone, which
 * gates agent-vs-operator, not pod-admin-ness). Stated explicitly rather than
 * slipped in: an operator who is not a pod admin can no longer set a
 * profile-wide system default. Approval of a pod-scoped proposal is unaffected
 * in practice — `assertCanRetargetProposalDestination` already requires
 * `isPodAdmin` for pod-wide proposals.
 */

import { TRPCError } from "@trpc/server";
import { db } from "@synap/database";

import { isPodAdmin } from "../../utils/workspace-role.js";
import { requireEditor } from "../../utils/workspace-permissions.js";
import type { RendererScope } from "./set-profile-renderer.js";

export interface BindRendererAuthzInput {
  /** The acting identity — the one whose authority is being checked. */
  userId: string;
  scope: RendererScope;
  /** Required for `scope: 'workspace'`. */
  workspaceId: string | null;
  /**
   * The user a `scope: 'user'` binding is FOR. Defaults to the actor; passing
   * anyone else is refused rather than silently ignored.
   */
  targetUserId?: string | null;
}

export async function assertMayBindRenderer(
  input: BindRendererAuthzInput
): Promise<void> {
  const { userId, scope, workspaceId } = input;

  if (scope === "user") {
    const target = input.targetUserId ?? userId;
    if (target !== userId) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message:
          "A user-scoped renderer binding can only be written for yourself.",
      });
    }
    return;
  }

  if (scope === "pod") {
    if (!(await isPodAdmin(userId))) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message:
          "Only pod administrators can bind a pod-wide renderer default.",
      });
    }
    return;
  }

  // scope === "workspace"
  if (!workspaceId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "workspaceId is required for a workspace-scoped renderer",
    });
  }
  try {
    await requireEditor(db, workspaceId, userId);
  } catch (err) {
    // A pod admin administers every workspace, including ones they hold no
    // member row on. Checked only on the membership MISS so the common path
    // stays one query.
    if (await isPodAdmin(userId)) return;
    throw err;
  }
}
