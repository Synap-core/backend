/**
 * Proposal Reviewed Notifier Worker
 *
 * When a proposal is approved or rejected, posts a system message back to
 * the channel where the proposal originated so agents waiting for approval
 * can continue their work.
 */

import type PgBoss from "pg-boss";
import { db, proposals, messages, eq } from "@synap/database";
import { MessageRole } from "@synap/database/schema";
import { randomUUID, createHash } from "crypto";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "proposal-reviewed-notifier" });

export const PROPOSAL_REVIEWED_NOTIFY_QUEUE = "proposal-reviewed-notify";

function computeMessageHash(
  channelId: string,
  content: string,
  role: string
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        channelId,
        content,
        role,
        timestamp: new Date().toISOString(),
      })
    )
    .digest("hex");
}

export async function handleProposalReviewedNotify(
  job: PgBoss.Job<{ proposalId: string; status: string }>
): Promise<void> {
  const { proposalId, status } = job.data;

  try {
    // Fetch the proposal row
    const [proposal] = await db
      .select({
        sourceMessageId: proposals.sourceMessageId,
        threadId: proposals.threadId,
        createdBy: proposals.createdBy,
        agentUserId: proposals.agentUserId,
        targetType: proposals.targetType,
        targetId: proposals.targetId,
      })
      .from(proposals)
      .where(eq(proposals.id, proposalId))
      .limit(1);

    if (!proposal) {
      logger.warn({ proposalId }, "Proposal not found — skipping notify");
      return;
    }

    // Resolve channelId: threadId IS the channelId, fall back to sourceMessageId lookup
    let channelId: string | null = proposal.threadId ?? null;

    if (!channelId && proposal.sourceMessageId) {
      const [msg] = await db
        .select({ channelId: messages.channelId })
        .from(messages)
        .where(eq(messages.id, proposal.sourceMessageId))
        .limit(1);
      channelId = msg?.channelId ?? null;
    }

    if (!channelId) {
      logger.info(
        { proposalId },
        "No channelId resolved for proposal — skipping notify"
      );
      return;
    }

    const label = proposal.targetType ?? "Change";
    const content = `[Proposal ${status}] ${label} has been ${status}. You may continue your work.`;
    const actorUserId = proposal.createdBy ?? proposal.agentUserId ?? "system";

    await db.insert(messages).values({
      id: randomUUID(),
      channelId,
      role: MessageRole.SYSTEM,
      content,
      userId: actorUserId,
      hash: computeMessageHash(channelId, content, "system"),
    });

    logger.info(
      { proposalId, channelId, status },
      "Proposal reviewed notification posted to channel"
    );
  } catch (err) {
    // Swallow — fire-and-forget semantics
    logger.warn(
      { err, proposalId },
      "proposal-reviewed-notifier failed (non-fatal)"
    );
  }
}
