/**
 * Chat Threads Executor
 *
 * Handles validated chat thread events.
 */

import { inngest } from "../client.js";
import { ChatThreadRepository, getDb } from "@synap/database";
import {
  ChatThreadType,
  ChatThreadStatus,
  ChatThreadAgentType,
  ThreadEntityRelationshipType,
  ThreadDocumentRelationshipType,
} from "@synap/database/schema";
import {
  extractEventInfo,
  type UnifiedEventData,
} from "../types/unified-events.js";

export const chatThreadsExecutor = inngest.createFunction(
  {
    id: "chat-threads-executor",
    name: "Chat Threads Executor",
    retries: 3,
  },
  [
    { event: "chat_threads.create.validated" },
    { event: "chat_threads.update.validated" },
    { event: "chat_threads.delete.validated" },
    { event: "chat_threads.branch.validated" },
    { event: "chat_threads.merge.validated" },
    { event: "chat_threads.archive.validated" },
  ],
  async ({ event, step }) => {
    const eventInfo = extractEventInfo(event.name);
    const { action, phase } = eventInfo;
    const data = event.data as UnifiedEventData;

    // Ensure we're handling a validated event
    if (phase !== "validated") {
      console.warn(
        `[chatThreadsExecutor] Received non-validated event: ${event.name}`
      );
      return { success: false, reason: "Not a validated event" };
    }

    return await step.run("execute-chat-thread-operation", async () => {
      const db = await getDb();
      const repo = new ChatThreadRepository(db);
      const { randomUUID } = await import("crypto");
      const { threadEntities, threadDocuments } =
        await import("@synap/database/schema");
      const { eq } = await import("@synap/database");

      // Handle custom actions (branch, merge, archive) and standard actions
      if (
        action === "create" ||
        event.name === "chat_threads.create.validated"
      ) {
        const thread = await repo.create({
          id: data.id as string | undefined,
          userId: data.userId as string,
          projectId: data.projectId as string | undefined,
          title: data.title as string | undefined,
          threadType: data.threadType as ChatThreadType | undefined,
          parentThreadId: data.parentThreadId as string | undefined,
          branchedFromMessageId: data.branchedFromMessageId as
            | string
            | undefined,
          branchPurpose: data.branchPurpose as string | undefined,
          agentId: data.agentId as string | undefined,
          agentType: data.agentType as ChatThreadAgentType | undefined,
          agentConfig: data.agentConfig as Record<string, unknown> | undefined,
          metadata: data.metadata as Record<string, unknown> | undefined,
        });

        return {
          status: "completed",
          threadId: thread.id,
          message: "Chat thread created successfully",
        };
      }

      if (event.name === "chat_threads.branch.validated") {
        // Create branch thread with context inheritance
        const threadId = randomUUID();
        const thread = await repo.create({
          id: threadId,
          userId: data.userId as string,
          projectId: data.projectId as string | undefined,
          threadType: ChatThreadType.BRANCH,
          parentThreadId: data.parentThreadId as string | undefined,
          branchPurpose: data.branchPurpose as string | undefined,
          agentId: (data.agentId as string | undefined) || "orchestrator",
          agentType:
            (data.agentType as ChatThreadAgentType | undefined) ||
            ChatThreadAgentType.DEFAULT,
          agentConfig: data.agentConfig as Record<string, unknown> | undefined,
        });

        // Inherit context from parent if requested
        if (data.inheritContext && data.parentThreadId) {
          const parentThreadId = data.parentThreadId as string;
          // Get parent's entities
          const parentEntities = await db.query.threadEntities.findMany({
            where: eq(threadEntities.threadId, parentThreadId),
          });

          // Get parent's documents
          const parentDocuments = await db.query.threadDocuments.findMany({
            where: eq(threadDocuments.threadId, parentThreadId),
          });

          // Copy entities with 'inherited_from_parent' type
          if (parentEntities.length > 0) {
            await db.insert(threadEntities).values(
              parentEntities.map(
                (e: {
                  entityId: string;
                  workspaceId: string;
                  sourceEventId: string | null;
                }) => ({
                  threadId,
                  entityId: e.entityId,
                  relationshipType:
                    ThreadEntityRelationshipType.INHERITED_FROM_PARENT,
                  userId: data.userId as string,
                  workspaceId: e.workspaceId,
                  sourceEventId: e.sourceEventId || undefined,
                })
              )
            );
          }

          // Copy documents with 'inherited_from_parent' type
          if (parentDocuments.length > 0) {
            await db.insert(threadDocuments).values(
              parentDocuments.map(
                (d: {
                  documentId: string;
                  workspaceId: string;
                  sourceEventId: string | null;
                }) => ({
                  threadId,
                  documentId: d.documentId,
                  relationshipType:
                    ThreadDocumentRelationshipType.INHERITED_FROM_PARENT,
                  userId: data.userId as string,
                  workspaceId: d.workspaceId,
                  sourceEventId: d.sourceEventId || undefined,
                })
              )
            );
          }
        }

        return {
          status: "completed",
          threadId: thread.id,
          parentThreadId: data.parentThreadId as string | undefined,
          message: "Branch thread created successfully",
        };
      }

      if (event.name === "chat_threads.merge.validated") {
        // Merge branch: update parent context and mark branch as merged
        const branchId = data.branchId as string;
        const branch = await repo.getById(branchId);
        if (!branch) {
          throw new Error(`Branch thread ${branchId} not found`);
        }

        // Generate summary if not provided
        let summary = data.summary as string | undefined;
        if (!summary) {
          // TODO: Use LLM to generate summary from branch messages
          summary = `Branch "${branch.branchPurpose}" completed`;
        }

        // Update parent thread context summary
        if (branch.parentThreadId) {
          const parent = await repo.getById(branch.parentThreadId);
          if (parent) {
            const updatedSummary = parent.contextSummary
              ? `${parent.contextSummary}\n\n${summary}`
              : summary;
            await repo.update(
              branch.parentThreadId,
              { contextSummary: updatedSummary },
              data.userId as string
            );
          }
        }

        // Mark branch as merged
        await repo.update(
          branchId,
          {
            status: ChatThreadStatus.MERGED,
            contextSummary: summary,
            mergedAt: new Date(),
          },
          data.userId as string
        );

        return {
          status: "completed",
          branchId,
          parentThreadId: branch.parentThreadId,
          message: "Branch merged successfully",
        };
      }

      if (event.name === "chat_threads.archive.validated") {
        // Archive thread (soft delete)
        await repo.update(
          data.threadId as string,
          { status: ChatThreadStatus.ARCHIVED },
          data.userId as string
        );

        return {
          status: "completed",
          threadId: data.threadId as string,
          message: "Thread archived successfully",
        };
      }

      if (action === "update") {
        const thread = await repo.update(
          data.id as string,
          {
            title: data.title as string | undefined,
            status: data.status as ChatThreadStatus | undefined,
            contextSummary: data.contextSummary as string | undefined,
            metadata: data.metadata as Record<string, unknown> | undefined,
            mergedAt: data.mergedAt as Date | undefined,
          },
          data.userId as string
        );

        return {
          status: "completed",
          threadId: thread.id,
          message: "Chat thread updated successfully",
        };
      }

      if (action === "delete") {
        await repo.delete(data.id as string, data.userId as string);

        return {
          status: "completed",
          threadId: data.id as string,
          message: "Chat thread deleted successfully",
        };
      }

      throw new Error(`Unknown action or event: ${action} (${event.name})`);
    });
  }
);
