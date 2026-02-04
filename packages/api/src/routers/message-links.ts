/**
 * Message Links Router
 *
 * Handles message link CRUD operations.
 */

import { z } from "zod";
import { router, workspaceProcedure } from "../trpc.js";
import { TRPCError } from "@trpc/server";
import { getDb, MessageLinksRepository } from "@synap/database";
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
   * Create a message link
   */
  create: workspaceProcedure
    .input(createMessageLinkSchema)
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      const linksRepo = new MessageLinksRepository(db);

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
});
