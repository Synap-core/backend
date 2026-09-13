/**
 * message-anchor — the ONE contract for a channel message that focuses on one
 * part of a run (founder decision D19, amended 2026-09-13).
 *
 * Comments on a run live in the SESSION'S CHANNEL — one findable place. A
 * message may carry `metadata.anchor = { proposalId?, opRef?, field?,
 * contentVersion }` so a block / proposal can show the comments anchored to it
 * as a filtered view of that same channel, never a second store. The reader is
 * `readCommentAnchor` in `@synap-core/intake-room` (model.ts), which parses the
 * same shape strictly; keep the two in step.
 *
 * Two rules, enforced for every human-send door that accepts an anchor
 * (`channels.sendMessage` tRPC + the Hub REST message-append doors):
 *
 *   1. SHAPE — strict and bounded. Unknown keys are refused, strings are
 *      capped, `contentVersion` is a non-negative integer (the proposal's
 *      revision-history length the commenter saw).
 *   2. AUTHORITY — an anchor naming a proposal must never let a caller pin a
 *      comment to a proposal they cannot see (`assertProposalVisibleTo`, the
 *      SSOT gate), and on a SESSION channel the proposal must belong to that
 *      session — a comment in run A's channel cannot claim a block of run B.
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { db as defaultDb, eq } from "@synap/database";
import { focusSessions, proposals } from "@synap/database/schema";
import { assertProposalVisibleTo } from "./proposal-visibility.js";

type Database = typeof defaultDb;

/** Longest `opRef` / `field` accepted. Refs are `$rel3`-shaped tokens and field
 *  keys are property slugs — 200 is generous for both and bounds the row. */
export const MESSAGE_ANCHOR_TOKEN_MAX = 200;

export const MessageAnchorSchema = z
  .object({
    proposalId: z.string().uuid().optional(),
    opRef: z.string().trim().min(1).max(MESSAGE_ANCHOR_TOKEN_MAX).optional(),
    field: z.string().trim().min(1).max(MESSAGE_ANCHOR_TOKEN_MAX).optional(),
    contentVersion: z.number().int().min(0).max(1_000_000),
  })
  .strict();
export type MessageAnchor = z.infer<typeof MessageAnchorSchema>;

/**
 * The client-writable part of a message's `metadata`. ONLY `anchor` — every
 * other metadata key (`turnContext`, `attachments`, provenance) is server-owned
 * and set by the door itself, never accepted from the wire.
 */
export const ChannelMessageMetadataInputSchema = z
  .object({ anchor: MessageAnchorSchema })
  .strict();
export type ChannelMessageMetadataInput = z.infer<
  typeof ChannelMessageMetadataInputSchema
>;

/**
 * Throw unless `userId` may pin `anchor` to a message in `channelId`.
 * NOT_FOUND / FORBIDDEN come from the proposal-visibility gate; BAD_REQUEST
 * when the proposal belongs to a different run than the session channel.
 */
export async function assertMessageAnchorAllowed(params: {
  anchor: MessageAnchor;
  channelId: string;
  userId: string;
  db?: Database;
}): Promise<void> {
  const { anchor, channelId, userId } = params;
  const database = params.db ?? defaultDb;
  if (!anchor.proposalId) return;

  await assertProposalVisibleTo(anchor.proposalId, userId, { db: database });

  const channelSessions = await database.query.focusSessions.findMany({
    where: eq(focusSessions.channelId, channelId),
    columns: { id: true },
  });
  if (channelSessions.length === 0) return;

  const proposal = await database.query.proposals.findFirst({
    where: eq(proposals.id, anchor.proposalId),
    columns: { sessionId: true },
  });
  const sessionIds = new Set(channelSessions.map((s) => s.id));
  if (!proposal?.sessionId || !sessionIds.has(proposal.sessionId)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "The anchored proposal does not belong to this session",
    });
  }
}
