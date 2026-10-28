/**
 * Message Links Router
 *
 * Handles message link CRUD operations.
 */

import { z } from "zod";
import { router, workspaceProcedure } from "../trpc.js";
import { TRPCError } from "@trpc/server";
import {
  channels,
  eq,
  getDb,
  messages,
  MessageLinksRepository,
} from "@synap/database";
import { AccessContext, scopedDb } from "../access/index.js";
import {
  MessageLinkTargetType,
  MessageLinkRelationshipType,
} from "@synap-core/types";

const createMessageLinkSchema = z.object({
  messageId: z.string().uuid(),
  targetType: z.nativeEnum(MessageLinkTargetType),
  targetId: z.string().uuid(),
  relationshipType: z.nativeEnum(MessageLinkRelationshipType),
  position: z
    .object({
      start: z.number().int().nonnegative(),
      end: z.number().int().nonnegative(),
    })
    .optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const queryMessageLinksSchema = z.object({
  messageId: z.string().uuid().optional(),
  targetType: z.nativeEnum(MessageLinkTargetType).optional(),
  targetId: z.string().uuid().optional(),
  relationshipType: z.nativeEnum(MessageLinkRelationshipType).optional(),
});

export const messageLinksRouter = router({
  /**
   * Create a message link.
   *
   * The caller must be able to READ the message: a link is how
   * `listLinkedMessages` later joins the message's content in, so linking a
   * message id you cannot read would hand you its content (audit F6).
   */
  create: workspaceProcedure
    .input(createMessageLinkSchema)
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      const linksRepo = new MessageLinksRepository(db);

      // The message's read floor is its channel's: the registered, grant-aware
      // channel visibility (the gate getMessages / setMessagePinned use).
      const [message] = await db
        .select({ channelId: messages.channelId })
        .from(messages)
        .where(eq(messages.id, input.messageId))
        .limit(1);
      const channel = message
        ? await scopedDb(AccessContext.from(ctx)).findFirst(channels, {
            where: eq(channels.id, message.channelId),
          })
        : undefined;
      if (!channel) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Message not found or access denied",
        });
      }

      const link = await linksRepo.create({
        ...input,
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
      });

      return link;
    }),

  /**
   * Delete a message link
   */
  delete: workspaceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      const linksRepo = new MessageLinksRepository(db);

      // Verify link belongs to workspace
      const links = await linksRepo.query({
        workspaceId: ctx.workspaceId,
      });
      const link = links.find((l) => l.id === input.id);

      if (!link) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Message link not found",
        });
      }

      await linksRepo.delete(input.id);
      return { success: true };
    }),

  /**
   * Get all links for a message
   */
  getByMessage: workspaceProcedure
    .input(z.object({ messageId: z.string().uuid() }))
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      const linksRepo = new MessageLinksRepository(db);

      const links = await linksRepo.getByMessage(input.messageId);

      // Filter by workspace
      return links.filter((link) => link.workspaceId === ctx.workspaceId);
    }),

  /**
   * Get all links to a target (e.g., all messages linked to a proposal)
   */
  getByTarget: workspaceProcedure
    .input(
      z.object({
        targetType: z.nativeEnum(MessageLinkTargetType),
        targetId: z.string().uuid(),
      })
    )
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      const linksRepo = new MessageLinksRepository(db);

      const links = await linksRepo.getByTarget(
        input.targetType,
        input.targetId
      );

      // Filter by workspace
      return links.filter((link) => link.workspaceId === ctx.workspaceId);
    }),

  /**
   * Get approval chain for a proposal
   */
  getApprovalChain: workspaceProcedure
    .input(z.object({ proposalId: z.string().uuid() }))
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      const linksRepo = new MessageLinksRepository(db);

      const links = await linksRepo.getApprovalChain(input.proposalId);

      // Filter by workspace
      return links.filter((link) => link.workspaceId === ctx.workspaceId);
    }),

  /**
   * Query message links with filters
   */
  query: workspaceProcedure
    .input(queryMessageLinksSchema)
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      const linksRepo = new MessageLinksRepository(db);

      const links = await linksRepo.query({
        ...input,
        workspaceId: ctx.workspaceId,
      });

      return links;
    }),

  /**
   * List messages linked to a target (entity, document, etc.) with message content.
   * For "messages linked to this entity/document" UI. Paginated via cursor.
   */
  listLinkedMessages: workspaceProcedure
    .input(
      z.object({
        targetType: z.nativeEnum(MessageLinkTargetType),
        targetId: z.string().uuid(),
        limit: z.number().min(1).max(100).default(50).optional(),
        cursor: z.string().optional(),
      })
    )
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      const linksRepo = new MessageLinksRepository(db);

      return linksRepo.getByTargetWithMessages(
        input.targetType,
        input.targetId,
        ctx.workspaceId,
        {
          limit: input.limit,
          cursor: input.cursor,
          // The link row's workspace is the caller's; the message it joins in
          // must ALSO be readable by the caller: its channel passes the
          // registered channel visibility (audit F6).
          channelVisibleWhere: scopedDb(AccessContext.from(ctx)).predicate(
            channels
          ),
        }
      );
    }),
});
