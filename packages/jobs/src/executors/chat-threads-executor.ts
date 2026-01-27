/**
 * Chat Threads Executor
 *
 * Handles validated chat thread events.
 */

import { inngest } from "../client.js";
import { ChatThreadRepository } from "@synap/database";
import { getDb } from "@synap/database";

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
    const eventType = event.name;
    const data = event.data;

    return await step.run("execute-chat-thread-operation", async () => {
      const db = await getDb();
      const repo = new ChatThreadRepository(db as any);
      const { randomUUID } = await import("crypto");
      const { threadEntities, threadDocuments } =
        await import("@synap/database/schema");
      const { eq } = await import("@synap/database");

      if (eventType === "chat_threads.create.validated") {
        const thread = await repo.create({
          id: data.id,
          userId: data.userId,
          projectId: data.projectId,
          title: data.title,
          threadType: data.threadType,
          parentThreadId: data.parentThreadId,
          branchedFromMessageId: data.branchedFromMessageId,
          branchPurpose: data.branchPurpose,
          agentId: data.agentId,
          agentType: data.agentType,
          agentConfig: data.agentConfig,
          metadata: data.metadata,
        });

        return {
          status: "completed",
          threadId: thread.id,
          message: "Chat thread created successfully",
        };
      }

      if (eventType === "chat_threads.branch.validated") {
        // Create branch thread with context inheritance
        const threadId = randomUUID();
        const thread = await repo.create({
          id: threadId,
          userId: data.userId,
          projectId: data.projectId,
          threadType: "branch",
          parentThreadId: data.parentThreadId,
          branchPurpose: data.branchPurpose,
          agentId: data.agentId || "orchestrator",
          agentType: data.agentType,
          agentConfig: data.agentConfig,
        });

        // Inherit context from parent if requested
        if (data.inheritContext && data.parentThreadId) {
          // Get parent's entities
          const parentEntities = await db.query.threadEntities.findMany({
            where: eq(threadEntities.threadId, data.parentThreadId),
          });

          // Get parent's documents
          const parentDocuments = await db.query.threadDocuments.findMany({
            where: eq(threadDocuments.threadId, data.parentThreadId),
          });

          // Copy entities with 'inherited_from_parent' type
          if (parentEntities.length > 0) {
            await db.insert(threadEntities).values(
              parentEntities.map((e) => ({
                threadId,
                entityId: e.entityId,
                relationshipType: "inherited_from_parent" as const,
                userId: data.userId,
                workspaceId: e.workspaceId,
                sourceEventId: e.sourceEventId || undefined,
              }))
            );
          }

          // Copy documents with 'inherited_from_parent' type
          if (parentDocuments.length > 0) {
            await db.insert(threadDocuments).values(
              parentDocuments.map((d) => ({
                threadId,
                documentId: d.documentId,
                relationshipType: "inherited_from_parent" as const,
                userId: data.userId,
                workspaceId: d.workspaceId,
                sourceEventId: d.sourceEventId || undefined,
              }))
            );
          }
        }

        return {
          status: "completed",
          threadId: thread.id,
          parentThreadId: data.parentThreadId,
          message: "Branch thread created successfully",
        };
      }

      if (eventType === "chat_threads.merge.validated") {
        // Merge branch: update parent context and mark branch as merged
        const branch = await repo.getById(data.branchId);
        if (!branch) {
          throw new Error(`Branch thread ${data.branchId} not found`);
        }

        // Generate summary if not provided
        let summary = data.summary;
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
              data.userId
            );
          }
        }

        // Mark branch as merged
        await repo.update(
          data.branchId,
          {
            status: "merged",
            contextSummary: summary,
            mergedAt: new Date(),
          },
          data.userId
        );

        return {
          status: "completed",
          branchId: data.branchId,
          parentThreadId: branch.parentThreadId,
          message: "Branch merged successfully",
        };
      }

      if (eventType === "chat_threads.archive.validated") {
        // Archive thread (soft delete)
        await repo.update(data.threadId, { status: "archived" }, data.userId);

        return {
          status: "completed",
          threadId: data.threadId,
          message: "Thread archived successfully",
        };
      }

      if (eventType === "chat_threads.update.validated") {
        const thread = await repo.update(
          data.id,
          {
            title: data.title,
            status: data.status,
            contextSummary: data.contextSummary,
            metadata: data.metadata,
            mergedAt: data.mergedAt,
          },
          data.userId
        );

        return {
          status: "completed",
          threadId: thread.id,
          message: "Chat thread updated successfully",
        };
      }

      if (eventType === "chat_threads.delete.validated") {
        await repo.delete(data.id, data.userId);

        return {
          status: "completed",
          threadId: data.id,
          message: "Chat thread deleted successfully",
        };
      }

      throw new Error(`Unknown event type: ${eventType}`);
    });
  }
);
