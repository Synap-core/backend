/**
 * Hub Protocol - Context Router
 *
 * Thin wrapper around regular API endpoints.
 * Uses API key authentication but calls regular API internally
 * to ensure all operations go through the same infrastructure.
 */

import { z } from "zod";
import { router } from "../../trpc.js";
import { scopedProcedure } from "../../middleware/api-key-auth.js";
import { channelsRouter } from "../channels.js";
import { entitiesRouter } from "../entities.js";
import { createHubProtocolCallerContext } from "./utils.js";
import { db } from "@synap/database";
import {
  entities,
  documents,
  workspaceMembers,
  channels,
} from "@synap/database/schema";
import { inArray, eq } from "@synap/database";
import {
  renderProposalForPrompt,
  type ProposalPromptContext,
} from "../proposals/render-for-prompt.js";

export const contextRouter = router({
  /**
   * Get thread context (messages + metadata + linked entities/documents)
   * Requires: hub-protocol.read scope
   *
   * Calls regular API's getThread and getMessages endpoints internally.
   * Includes linked entities and documents (from thread_entities, thread_documents) for AI context.
   */
  getThreadContext: scopedProcedure(["hub-protocol.read"])
    .input(
      z.object({
        threadId: z.string().uuid(),
      })
    )
    .query(async ({ input, ctx }) => {
      // Look up the thread's userId, workspaceId, contextSummary and metadata
      const thread = await db
        .select({
          userId: channels.userId,
          workspaceId: channels.workspaceId,
          contextSummary: channels.contextSummary,
          metadata: channels.metadata,
          contextObjectType: channels.contextObjectType,
          contextObjectId: channels.contextObjectId,
        })
        .from(channels)
        .where(eq(channels.id, input.threadId))
        .limit(1)
        .then((r) => r[0]);
      const workspaceId =
        thread?.workspaceId ??
        ((ctx as Record<string, unknown>).workspaceId as string | null) ??
        null;
      const threadUserId = thread?.userId ?? ctx.userId!;
      // Use the thread's actual userId (not API key owner "system")
      const callerContext = await createHubProtocolCallerContext(
        threadUserId,
        ctx.scopes || [],
        workspaceId
      );
      const chatCaller = channelsRouter.createCaller(callerContext);
      const entitiesCaller = entitiesRouter.createCaller(callerContext);

      // Get channel with context (includes channel_context_items rows)
      const threadResult = await chatCaller.getChannel({
        channelId: input.threadId,
        includeContext: true,
        includeBranches: false,
      });

      // Get messages
      const messagesResult = await chatCaller.getMessages({
        threadId: input.threadId,
        limit: 50,
      });

      // Get recent entities for this user
      const entitiesResult = await entitiesCaller.list({
        limit: 10,
      });

      // Linked entities/documents from channel_context_items
      const contextItems = threadResult.contextItems ?? [];
      const linkedEntityIds: string[] = contextItems
        .filter((i: { objectType: string }) => i.objectType === "entity")
        .map((i: { objectId: string }) => i.objectId);
      const linkedDocumentIds: string[] = contextItems
        .filter((i: { objectType: string }) => i.objectType === "document")
        .map((i: { objectId: string }) => i.objectId);

      // Resolve linked entities and documents for prompt injection (id, type/title)
      let linkedEntities: Array<{
        id: string;
        type: string;
        title: string | null;
        properties?: Record<string, unknown>;
      }> = [];
      let linkedDocuments: Array<{ id: string; title: string | null }> = [];

      if (linkedEntityIds.length > 0) {
        const rows = await db.query.entities.findMany({
          where: inArray(entities.id, linkedEntityIds),
          columns: { id: true, type: true, title: true, properties: true },
        });
        linkedEntities = rows.map((r) => ({
          id: r.id,
          type: r.type,
          title: r.title ?? null,
          // Pass document metadata through for both `document` (canonical) and
          // legacy `file` — the file→document merge is operator-driven, so
          // un-migrated uploads stay `type:"file"` until it runs.
          ...(r.type === "document" || r.type === "file"
            ? { properties: r.properties as Record<string, unknown> }
            : {}),
        }));
      }
      if (linkedDocumentIds.length > 0) {
        const rows = await db.query.documents.findMany({
          where: inArray(documents.id, linkedDocumentIds),
          columns: { id: true, title: true },
        });
        linkedDocuments = rows.map((r) => ({
          id: r.id,
          title: r.title ?? null,
        }));
      }

      // On-demand "discuss/refine this proposal" threads bind to the proposal via
      // the channel's primary contextObject (not a context-item). Hydrate it so
      // the agent sees the proposal it may revise (via update_proposal) — and
      // surface `proposalId` explicitly so the tool has its target.
      let linkedProposal: ProposalPromptContext | null = null;
      if (thread?.contextObjectType === "proposal" && thread?.contextObjectId) {
        linkedProposal = await renderProposalForPrompt(thread.contextObjectId);
      }

      return {
        thread: {
          id: threadResult.channel.id,
          userId: threadResult.channel.userId,
          projectId: undefined,
          agentId:
            (threadResult.channel.assignedAgentId ??
              threadResult.channel.senderAgentId) ||
            undefined,
        },
        ...(linkedProposal
          ? { proposalId: linkedProposal.id, linkedProposal }
          : {}),
        contextSummary: thread?.contextSummary ?? null,
        metadata: thread?.metadata ?? null,
        messages: messagesResult.messages.map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          timestamp: m.timestamp,
        })),
        recentEntities: entitiesResult.entities.slice(0, 10).map((e) => ({
          id: e.id,
          type: e.type,
          title: e.title || null,
        })),
        linkedEntityIds,
        linkedDocumentIds,
        linkedEntities,
        linkedDocuments,
      };
    }),

  /**
   * Get user context
   * Requires: hub-protocol.read scope
   *
   * Calls regular API's list endpoints internally
   */
  getUserContext: scopedProcedure(["hub-protocol.read"])
    .input(
      z.object({
        userId: z.string(),
      })
    )
    .query(async ({ input, ctx }) => {
      // Look up user's primary workspace (by input.userId — the real user, not the API key owner)
      const membership = await db
        .select({ workspaceId: workspaceMembers.workspaceId })
        .from(workspaceMembers)
        .where(eq(workspaceMembers.userId, input.userId))
        .limit(1)
        .then((r) => r[0]);
      const workspaceId =
        membership?.workspaceId ??
        ((ctx as Record<string, unknown>).workspaceId as string | null) ??
        null;
      // Use input.userId (the real user) not ctx.userId (the API key owner "system")
      const callerContext = await createHubProtocolCallerContext(
        input.userId,
        ctx.scopes || [],
        workspaceId
      );
      const chatCaller = channelsRouter.createCaller(callerContext);
      const entitiesCaller = entitiesRouter.createCaller(callerContext);

      // Get recent entities
      const entitiesResult = await entitiesCaller.list({
        limit: 20,
      });

      // Get recent channels
      const threadsResult = await chatCaller.listChannels({
        limit: 5,
      });

      return {
        userId: input.userId,
        preferences: {},
        recentActivity: [
          ...entitiesResult.entities.map((e) => ({
            type: "entity_created",
            timestamp: e.createdAt,
            data: { entityId: e.id, entityType: e.type },
          })),
          ...threadsResult.channels.map((t) => ({
            type: "channel_updated",
            timestamp: t.updatedAt,
            data: { channelId: t.id },
          })),
        ]
          .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
          .slice(0, 10),
      };
    }),

  /**
   * Update thread context
   * Requires: hub-protocol.write scope
   *
   * Note: Regular API's updateThread doesn't have contextSummary parameter.
   * This is a specialized Hub Protocol operation, so we keep direct DB update
   * but it's a simple metadata update (not a state change).
   */
  updateThreadContext: scopedProcedure(["hub-protocol.write"])
    .input(
      z.object({
        threadId: z.string().uuid(),
        contextSummary: z.string(),
      })
    )
    .mutation(async ({ input }) => {
      // This is a simple metadata update (contextSummary is not part of event sourcing)
      // We could extend the regular API to support this, but for now we keep it direct
      // since it's a specialized Hub Protocol operation
      const { db, eq } = await import("@synap/database");
      const { channels } = await import("@synap/database/schema");

      await db
        .update(channels)
        .set({
          contextSummary: input.contextSummary,
          updatedAt: new Date(),
        })
        .where(eq(channels.id, input.threadId));

      return { success: true };
    }),
});
