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
 * OBJECT ANCHORS (document / entity, Documents v2) are written by ONE door
 * only, the comments service (`services/comments`), which mints them into the
 * object's room after the object's read floor — see `ObjectCommentAnchorSchema`
 * below. `sendMessage` and the Hub REST doors keep the proposal shape and
 * refuse the others (`.strict()`), so there is no second write path.
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

/** Longest `quote` / heading text a document anchor may carry. */
export const DOCUMENT_ANCHOR_QUOTE_MAX = 500;

/**
 * A comment on a DOCUMENT (Documents v2, 2026-09-26) — the D19 contract
 * extended to every object: the comment is a message in the document's ONE
 * object room, and this anchor says which part of the document it is about.
 *
 *   - `blockRef` — the heading the comment sits under, by TEXT + occurrence
 *     (the n-th heading with that text). Survives edits above it, unlike a
 *     character offset. Future block ids join as another `kind`.
 *   - `quote`    — the selected passage, bounded; shown when the anchor no
 *     longer resolves (an orphaned comment still says what it was about).
 *   - `offset`   — the markdown range at comment time, a hint only.
 *   - `revision` — the document revision the commenter saw (the stale mark,
 *     mirroring the proposal anchor's `contentVersion`).
 *
 * WHOLE DOCUMENT = none of blockRef / quote / offset. It is never inferred
 * from `offset.start === 0`: a heading at offset 0 (most documents open with
 * `# Title`) is a section, not the whole document.
 */
export const DocumentAnchorSchema = z
  .object({
    kind: z.literal("document"),
    documentId: z.string().uuid(),
    blockRef: z
      .object({
        kind: z.literal("heading"),
        text: z.string().trim().min(1).max(DOCUMENT_ANCHOR_QUOTE_MAX),
        occurrence: z.number().int().min(0).max(10_000),
      })
      .strict()
      .optional(),
    quote: z.string().trim().min(1).max(DOCUMENT_ANCHOR_QUOTE_MAX).optional(),
    offset: z
      .object({
        start: z.number().int().min(0),
        end: z.number().int().min(0),
      })
      .strict()
      .optional(),
    revision: z.number().int().min(0).optional(),
  })
  .strict();
export type DocumentAnchor = z.infer<typeof DocumentAnchorSchema>;

/**
 * A comment on an ENTITY: the entity's object room, optionally one field.
 */
export const EntityAnchorSchema = z
  .object({
    kind: z.literal("entity"),
    entityId: z.string().uuid(),
    field: z.string().trim().min(1).max(MESSAGE_ANCHOR_TOKEN_MAX).optional(),
  })
  .strict();
export type EntityAnchor = z.infer<typeof EntityAnchorSchema>;

/** Every anchor a comment in an OBJECT ROOM may carry (the comments door). */
export const ObjectCommentAnchorSchema = z.discriminatedUnion("kind", [
  DocumentAnchorSchema,
  EntityAnchorSchema,
]);
export type ObjectCommentAnchor = z.infer<typeof ObjectCommentAnchorSchema>;

/** The object an object-room anchor names. */
export function anchorObjectRef(anchor: ObjectCommentAnchor): {
  type: "document" | "entity";
  id: string;
} {
  return anchor.kind === "document"
    ? { type: "document", id: anchor.documentId }
    : { type: "entity", id: anchor.entityId };
}

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
