/**
 * `comments.*` — the human door to comments on an object (Documents v2).
 *
 * A comment is a message in the object's ONE linked channel, anchored to a
 * part of it; every procedure here is a thin shell over
 * `services/comments/comments.ts` (the one door the MCP tool shares). Pod-level
 * (`protectedProcedure`): a pod-wide document has no workspace, and the floor
 * is the OBJECT's, never a workspace header.
 */

import { z } from "zod";
import { router, protectedProcedure } from "../trpc.js";
import {
  COMMENT_CONTENT_MAX,
  listObjectComments,
  postComment,
  setCommentResolved,
} from "../services/comments/comments.js";
import {
  ensureObjectChannelFor,
  ensurePrivateObjectThread,
} from "../services/comments/object-channel.js";
import { ObjectCommentAnchorSchema } from "../utils/message-anchor.js";
import { OBJECT_ROOM_CONTEXT_TYPES } from "../utils/channel-visibility.js";

const ObjectRefSchema = z
  .object({
    type: z.enum(OBJECT_ROOM_CONTEXT_TYPES),
    id: z.string().uuid(),
  })
  .strict();

const ContentSchema = z.string().trim().min(1).max(COMMENT_CONTENT_MAX);

export const commentsRouter = router({
  /** Open a thread: a root comment anchored to part of the object. */
  create: protectedProcedure
    .input(
      z
        .object({
          anchor: ObjectCommentAnchorSchema,
          content: ContentSchema,
          /** One user intent — a retry returns the first comment. */
          clientRequestId: z.string().min(1).max(200).optional(),
        })
        .strict()
    )
    .mutation(({ ctx, input }) =>
      postComment({
        userId: ctx.userId,
        anchor: input.anchor,
        content: input.content,
        idempotencyKey: input.clientRequestId,
      })
    ),

  /** Reply in a thread (any message of it; the reply joins the root). */
  reply: protectedProcedure
    .input(
      z
        .object({
          parentId: z.string().uuid(),
          content: ContentSchema,
          clientRequestId: z.string().min(1).max(200).optional(),
        })
        .strict()
    )
    .mutation(({ ctx, input }) =>
      postComment({
        userId: ctx.userId,
        parentId: input.parentId,
        content: input.content,
        idempotencyKey: input.clientRequestId,
      })
    ),

  /** Resolve or re-open a thread — its author or an editor of the object. */
  setResolved: protectedProcedure
    .input(
      z.object({ messageId: z.string().uuid(), resolved: z.boolean() }).strict()
    )
    .mutation(({ ctx, input }) =>
      setCommentResolved({
        userId: ctx.userId,
        messageId: input.messageId,
        resolved: input.resolved,
      })
    ),

  /** THE listing: an object's threads in one state + both counts. */
  list: protectedProcedure
    .input(
      z
        .object({
          object: ObjectRefSchema,
          state: z.enum(["open", "resolved"]).default("open"),
        })
        .strict()
    )
    .query(({ ctx, input }) =>
      listObjectComments({
        userId: ctx.userId,
        object: input.object,
        state: input.state,
      })
    ),

  /** The object's ONE room (the "Open conversation" door). Mints if absent. */
  objectChannel: protectedProcedure
    .input(z.object({ object: ObjectRefSchema }).strict())
    .mutation(async ({ ctx, input }) => {
      const channel = await ensureObjectChannelFor(ctx.userId, input.object);
      return { channelId: channel.id };
    }),

  /** The caller's PRIVATE "Ask AI about this" thread under the room (V3). */
  privateThread: protectedProcedure
    .input(z.object({ object: ObjectRefSchema }).strict())
    .mutation(async ({ ctx, input }) => {
      const thread = await ensurePrivateObjectThread({
        userId: ctx.userId,
        ref: input.object,
      });
      return { channelId: thread.id, parentChannelId: thread.parentChannelId };
    }),
});
