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
  ],
  async ({ event, step }) => {
    const eventType = event.name;
    const data = event.data;

    return await step.run("execute-chat-thread-operation", async () => {
      const db = await getDb();
      const repo = new ChatThreadRepository(db as any);

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
