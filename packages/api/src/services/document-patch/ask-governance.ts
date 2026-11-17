/**
 * The check a question must pass BEFORE it is filed on a session: the same
 * governance verdict the real write will get, decided without side effects.
 *
 * `previewPermissionDecision` is a dry run, so it skips the pending-proposal
 * cap that `checkPermissionOrPropose` applies to a proposal; at the cap the
 * real gate would refuse AFTER the question was filed. Both are checked here.
 * What a dry run cannot see (state that changes between this check and the
 * real gate) can still leave the question owed on the session; the same write
 * sent again reuses it by (session, key).
 */

import { randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import {
  previewPermissionDecision,
  refuseAtAgentPendingCap,
  type PermissionCheckOpts,
} from "../../utils/permission-check.js";

/** Throws FORBIDDEN when the write would be denied, or refused at the agent's proposal cap. */
export async function assertQuestionMayBeFiled(
  opts: PermissionCheckOpts,
  agentUserId: string
): Promise<void> {
  const verdict = await previewPermissionDecision(opts);
  if (verdict.decision === "deny") {
    throw new TRPCError({ code: "FORBIDDEN", message: verdict.reason });
  }
  if (verdict.decision === "propose") {
    const atCap = await refuseAtAgentPendingCap({
      attributionAgentUserId: agentUserId,
      userId: opts.userId,
      workspaceId: opts.workspaceId,
      subjectType: opts.subjectType,
      action: opts.action,
      correlationId: randomUUID(),
    });
    if (atCap)
      throw new TRPCError({ code: "FORBIDDEN", message: atCap.reason });
  }
}
