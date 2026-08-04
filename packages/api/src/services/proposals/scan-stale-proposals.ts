/**
 * scanStaleProposals — the PROACTIVE twin of the approve-time stale-target
 * preflight (`assertApprovalTargetResolves`). A pending proposal can sit for days;
 * if its target workspace has been deleted or its owner has left it, approving it
 * will FAIL. Rather than let the owner discover that on click, a cron scans pending
 * proposals and pushes ONE `governance.proposal_stale` notification per stale
 * proposal (the config-over-code producer pattern — all category/priority/actions
 * live in the registry entry, this file only detects + emits).
 *
 * Recipient = the proposal's HUMAN owner, NOT the workspace members: a DELETED
 * workspace has zero members to fan out to, and a stale proposal is the owner's
 * to withdraw / re-run. For an AI-authored proposal the human is the agent's
 * creator (`users.createdByUserId`) — never the agent user itself, which reads no
 * bell — mirroring the approve-path canReview resolution. Deduped by a cooldown
 * so a still-stale proposal is not re-notified every tick.
 *
 * Scope is the workspace-gone reason only (the genuine unguarded gap). A dead
 * *connection* is already surfaced by the connection-health nudge + the dispatch
 * layer's `no_connection`, so it is deliberately NOT duplicated here.
 */

import {
  db,
  proposals,
  notifications,
  users,
  eq,
  and,
  isNotNull,
  gte,
} from "@synap/database";
import { createLogger } from "@synap-core/core";
import { NotificationService } from "../../notifications/NotificationService.js";
import { assertApprovalTargetResolves } from "../capabilities/execute-capability.js";

const logger = createLogger({ module: "scan-stale-proposals" });

/** Don't re-notify the same stale proposal more than once per this window. */
const RENOTIFY_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24h

export async function scanStaleProposals(): Promise<{
  scanned: number;
  notified: number;
}> {
  // Only proposals bound to a concrete workspace can lose it (pod-wide = null,
  // nothing to check). Pending only — a resolved proposal is moot.
  const pending = await db
    .select({
      id: proposals.id,
      workspaceId: proposals.workspaceId,
      proposedByUserId: proposals.proposedByUserId,
      createdBy: proposals.createdBy,
      agentUserId: proposals.agentUserId,
      proposalType: proposals.proposalType,
    })
    .from(proposals)
    .where(
      and(eq(proposals.status, "pending"), isNotNull(proposals.workspaceId))
    );

  let notified = 0;
  const cooldownFloor = new Date(Date.now() - RENOTIFY_COOLDOWN_MS);

  for (const p of pending) {
    // Resolve the HUMAN owner — the recipient must be someone who reads a bell.
    // An AI-authored proposal carries proposedByUserId=NULL and createdBy=the
    // AGENT user (which has no workspace_members row and never reads a bell), so
    // `proposedByUserId ?? createdBy` would false-flag every AI proposal as stale
    // AND address the alert to a non-human. Resolve the agent's creator
    // (`users.createdByUserId`) — the SAME human the approve-path canReview admits
    // as owner (routers/proposals.ts:472). Human-authored proposals keep
    // proposedByUserId (or a human createdBy) and skip the lookup.
    let owner: string | null;
    if (p.proposedByUserId) {
      owner = p.proposedByUserId;
    } else if (p.agentUserId) {
      const [agent] = await db
        .select({ createdByUserId: users.createdByUserId })
        .from(users)
        .where(eq(users.id, p.agentUserId))
        .limit(1);
      owner = agent?.createdByUserId ?? null;
    } else {
      owner = p.createdBy;
    }
    // No attributable human owner, or (defensively) no workspace → can't act.
    if (!owner || !p.workspaceId) continue;

    // Reuse the ONE preflight check: does the target workspace still resolve for
    // the owner? Non-null result = target_missing (deleted or owner left) = stale.
    const fail = await assertApprovalTargetResolves(p.workspaceId, owner);
    if (!fail) continue;

    // Cooldown: skip if we already alerted for this proposal within the window.
    const [recent] = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          eq(notifications.type, "governance.proposal_stale"),
          eq(notifications.sourceType, "proposal"),
          eq(notifications.sourceId, p.id),
          gte(notifications.createdAt, cooldownFloor)
        )
      )
      .limit(1);
    if (recent) continue;

    await NotificationService.create({
      type: "governance.proposal_stale",
      sourceType: "proposal",
      sourceId: p.id,
      userId: owner,
      workspaceId: p.workspaceId,
      data: {
        proposalType: p.proposalType,
        reason: "the target workspace is no longer accessible",
      },
    }).catch((err) =>
      logger.warn({ err, proposalId: p.id }, "stale-proposal notify failed")
    );
    notified++;
  }

  if (notified > 0) {
    logger.info(
      { scanned: pending.length, notified },
      "stale-proposal scan complete"
    );
  }
  return { scanned: pending.length, notified };
}
