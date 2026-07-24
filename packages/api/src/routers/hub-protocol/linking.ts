/**
 * Hub Protocol - Linking Router
 *
 * Handles context linking operations (entity/document to channel).
 * These are context-tracking fast-path operations — they record which entities/documents
 * the AI referenced in a thread, not state changes to those objects.
 *
 * Governance: goes through checkPermissionOrPropose with source:"intelligence".
 * "context.*" is in the default autoApproveFor whitelist, so linking is auto-approved
 * (no proposal needed) but workspace membership is still verified.
 */

import { z } from "zod";
import { router } from "../../trpc.js";
import { scopedProcedure } from "../../middleware/api-key-auth.js";
import { db, eq, and } from "@synap/database";
import { TRPCError } from "@trpc/server";
import {
  channels,
  channelContextItems,
  ChannelContextObjectType,
  type ChannelContextRelationshipType,
  ChannelContextConflictStatus,
} from "@synap/database/schema";
import { checkPermissionOrPropose } from "../../utils/permission-check.js";
import { assertMayActAs } from "./guard.js";

const relationshipTypeEnum = z.enum([
  "used_as_context",
  "created",
  "updated",
  "referenced",
  "inherited_from_parent",
]);

export const linkingRouter = router({
  /**
   * Link entity to channel (context tracking)
   * Requires: hub-protocol.write scope
   *
   * Governance: auto-approved via "context.*" whitelist — no proposal needed for
   * context metadata. Workspace membership is still verified.
   * Idempotent: If the same (channel, entity, relationship) already exists, no-op.
   */
  linkEntity: scopedProcedure(["hub-protocol.write"])
    .input(
      z.object({
        userId: z.string(),
        threadId: z.string().uuid(),
        entityId: z.string().uuid(),
        relationshipType: relationshipTypeEnum.default("referenced"),
        sourceMessageId: z.string().uuid().optional(),
        // agentUserId: the per-human agent user acting on behalf of userId.
        agentUserId: z.string().uuid().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Identity floor: `input.userId` is the acting identity fed to
      // checkPermissionOrPropose (and stamped as the context-item owner) — a hub
      // PAT may act only as its own owner.
      assertMayActAs(ctx, input.userId);
      // Verify channel exists and resolve workspaceId
      const channel = await db.query.channels.findFirst({
        where: eq(channels.id, input.threadId),
        columns: { id: true, workspaceId: true },
      });

      if (!channel) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Channel not found",
        });
      }

      const workspaceId = channel.workspaceId ?? undefined;
      const agentUserId = input.agentUserId;

      // Governance: "context.link" is auto-approved by default whitelist.
      // Still verifies workspace membership for the acting user.
      const perm = await checkPermissionOrPropose({
        userId: input.userId,
        agentUserId,
        workspaceId,
        subjectType: "context",
        action: "link",
        source: "intelligence",
        // Group this context-link proposal under the agent's active run session
        // (else the "Link context" flood stays ungrouped — the exact case that
        // motivated the session-grouping feature).
        sessionId: ctx.sessionId ?? undefined,
        data: {
          threadId: input.threadId,
          entityId: input.entityId,
          relationshipType: input.relationshipType,
        },
      });

      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }

      // Idempotent insert — skip if already linked with same relationship
      const existing = await db.query.channelContextItems.findFirst({
        where: and(
          eq(channelContextItems.channelId, input.threadId),
          eq(channelContextItems.objectId, input.entityId),
          eq(channelContextItems.objectType, ChannelContextObjectType.ENTITY),
          eq(
            channelContextItems.relationshipType,
            input.relationshipType as ChannelContextRelationshipType
          )
        ),
      });

      if (!existing) {
        await db.insert(channelContextItems).values({
          channelId: input.threadId,
          objectType: ChannelContextObjectType.ENTITY,
          objectId: input.entityId,
          relationshipType:
            input.relationshipType as ChannelContextRelationshipType,
          userId: input.userId,
          workspaceId: channel.workspaceId ?? null,
          sourceMessageId: input.sourceMessageId,
          conflictStatus: ChannelContextConflictStatus.NONE,
        });
      }

      return {
        success: true,
        linked: !existing,
        message: existing ? "Already linked" : "Entity linked to channel",
      };
    }),

  /**
   * Link document to channel (context tracking)
   * Requires: hub-protocol.write scope
   *
   * Governance: auto-approved via "context.*" whitelist — no proposal needed for
   * context metadata. Workspace membership is still verified.
   * Idempotent: If the same (channel, document, relationship) already exists, no-op.
   */
  linkDocument: scopedProcedure(["hub-protocol.write"])
    .input(
      z.object({
        userId: z.string(),
        threadId: z.string().uuid(),
        documentId: z.string().uuid(),
        relationshipType: relationshipTypeEnum.default("referenced"),
        sourceMessageId: z.string().uuid().optional(),
        // agentUserId: the per-human agent user acting on behalf of userId.
        agentUserId: z.string().uuid().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Identity floor: see linkEntity — `input.userId` is the acting identity
      // and the context-item owner, so it must equal the key owner.
      assertMayActAs(ctx, input.userId);
      // Verify channel exists and resolve workspaceId
      const channel = await db.query.channels.findFirst({
        where: eq(channels.id, input.threadId),
        columns: { id: true, workspaceId: true },
      });

      if (!channel) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Channel not found",
        });
      }

      const workspaceId = channel.workspaceId ?? undefined;
      const agentUserId = input.agentUserId;

      // Governance: "context.link" is auto-approved by default whitelist.
      // Still verifies workspace membership for the acting user.
      const perm = await checkPermissionOrPropose({
        userId: input.userId,
        agentUserId,
        workspaceId,
        subjectType: "context",
        action: "link",
        source: "intelligence",
        // Group under the agent's active run session (see linkEntity above).
        sessionId: ctx.sessionId ?? undefined,
        data: {
          threadId: input.threadId,
          documentId: input.documentId,
          relationshipType: input.relationshipType,
        },
      });

      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }

      // Idempotent insert — skip if already linked with same relationship
      const existing = await db.query.channelContextItems.findFirst({
        where: and(
          eq(channelContextItems.channelId, input.threadId),
          eq(channelContextItems.objectId, input.documentId),
          eq(channelContextItems.objectType, ChannelContextObjectType.DOCUMENT),
          eq(
            channelContextItems.relationshipType,
            input.relationshipType as ChannelContextRelationshipType
          )
        ),
      });

      if (!existing) {
        await db.insert(channelContextItems).values({
          channelId: input.threadId,
          objectType: ChannelContextObjectType.DOCUMENT,
          objectId: input.documentId,
          relationshipType:
            input.relationshipType as ChannelContextRelationshipType,
          userId: input.userId,
          workspaceId: channel.workspaceId ?? null,
          sourceMessageId: input.sourceMessageId,
          conflictStatus: ChannelContextConflictStatus.NONE,
        });
      }

      return {
        success: true,
        linked: !existing,
        message: existing ? "Already linked" : "Document linked to channel",
      };
    }),
});
