/**
 * Tell a proposal's owner that its approval failed when nobody saw it fail
 * (plan 8032a127 D6). A person who clicked Approve reads the failure in their
 * toast and gets nothing more; these failures had no one in the loop:
 *
 *  - an AGENT's auto-applied receipt whose materialization threw
 *    (`runMaterializationUnderReceipt`): the agent got the error, the person
 *    never heard (the 10 failed `capture.graph` receipts of research
 *    96467668 §2, e.g. 7ad8bdde);
 *  - an approval the `proposal-approve` job applied after the request had
 *    returned (`runApprovalJob`): the person may have closed the page.
 *
 * The words are the registry's (`proposal.approval_failed`): this file sends
 * tokens. One open row per proposal (its groupKey, the registry's dedupe
 * window); the doors that end or approve a proposal settle it with every other
 * row about it (`markProposalNotificationsActioned`). Best-effort: never
 * throws, never fails the write that called it.
 */

import { createLogger } from "@synap-core/core";
import { db, eq, proposals } from "@synap/database";
import { ProposalStatus } from "@synap/database/schema";
import { NotificationService } from "../../notifications/NotificationService.js";
import { resolveProposalHumanOwner } from "./scan-stale-proposals.js";

const logger = createLogger({ module: "unseen-approval-failure" });

/**
 * Undecided: waiting for a review, or a review whose approval failed. A job
 * whose apply threw outside a plan leaves the proposal pending (its run
 * records the failure). TODO(W5 follow-up): read `UNDECIDED_PROPOSAL_STATUSES`
 * once backend#1090 lands it in `proposal-transition.ts`.
 */
const UNDECIDED: readonly string[] = [
  ProposalStatus.PENDING,
  ProposalStatus.APPROVAL_FAILED,
];

/**
 * @param opts.agentReceipt the caller is the receipt path: notify only when an
 *   agent is behind the write (`agentUserId`, or `data.source = 'agent'` on
 *   rows from before the agent was recorded: the predicate of
 *   `createAutoApprovedProposal`). A person's own capture failed in front of
 *   them.
 * @param opts.sentence the safe sentence to show when the proposal row does not
 *   carry one (a job failure that left it pending).
 * @returns whether a notification was sent (for the tests and the log).
 */
export async function notifyUnseenApprovalFailure(
  proposalId: string,
  opts: { agentReceipt?: boolean; sentence?: string } = {}
): Promise<boolean> {
  try {
    const [row] = await db
      .select({
        id: proposals.id,
        status: proposals.status,
        proposalType: proposals.proposalType,
        targetType: proposals.targetType,
        targetId: proposals.targetId,
        data: proposals.data,
        workspaceId: proposals.workspaceId,
        proposedByUserId: proposals.proposedByUserId,
        createdBy: proposals.createdBy,
        agentUserId: proposals.agentUserId,
        rejectionReason: proposals.rejectionReason,
      })
      .from(proposals)
      .where(eq(proposals.id, proposalId))
      .limit(1);
    // Decided meanwhile (a retry applied it, someone rejected it): no news.
    if (!row || !UNDECIDED.includes(row.status)) return false;
    if (
      opts.agentReceipt &&
      !row.agentUserId &&
      (row.data as { source?: unknown } | null)?.source !== "agent"
    ) {
      return false;
    }
    const owner = await resolveProposalHumanOwner(row);
    if (!owner) return false;

    // The proposal's name for its owner, through the one name door the
    // proposal read doors use (redacted when it names a session the owner
    // cannot read). A naming failure still sends the notice, unnamed.
    let name: string | undefined;
    try {
      const { proposalNeighborNames } =
        await import("../object-graph/graph-service.js");
      name = (await proposalNeighborNames([row], owner)).get(row.id);
    } catch (err) {
      logger.warn(
        { err, proposalId },
        "unseen approval failure: naming the proposal failed, sent unnamed"
      );
    }
    const sentence = row.rejectionReason ?? opts.sentence;

    const id = await NotificationService.create({
      type: "proposal.approval_failed",
      sourceType: "proposal",
      sourceId: row.id,
      userId: owner,
      workspaceId: row.workspaceId,
      groupKey: `proposal.approval_failed:${row.id}`,
      data: {
        named: name ? "yes" : "no",
        name: name ?? "",
        reason: sentence ? "yes" : "no",
        sentence: sentence ?? "",
      },
    });
    return id !== undefined;
  } catch (err) {
    logger.warn(
      { err, proposalId },
      "unseen approval failure: the owner could not be notified"
    );
    return false;
  }
}
