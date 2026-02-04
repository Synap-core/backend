import { inngest } from "../client.js";
import {
  getDb,
  EventRepository,
  MessageRepository,
  sql,
} from "@synap/database";
import {
  extractEventInfo,
  type UnifiedEventData,
} from "../types/unified-events.js";

export const messagesHandler = async ({
  event,
  step,
}: {
  event: { name: string; data: UnifiedEventData; user: { id: string } };
  step: any;
}) => {
  const eventInfo = extractEventInfo(event.name);
  const { action, phase } = eventInfo;

  if (phase !== "validated") {
    console.warn(
      `[messagesExecutor] Received non-validated event: ${event.name}`
    );
    return { success: false, reason: "Not a validated event" };
  }

  const db = await getDb();
  const eventRepo = new EventRepository(sql);
  const messageRepo = new MessageRepository(db, eventRepo);

  const userId = event.user.id;
  const data = event.data;

  return await step.run("process-message", async () => {
    if (action === "create") {
      // Note: MessageRepository may emit events manually
      await messageRepo.create(
        {
          threadId: data.threadId as string,
          content: (data.content as string) || "",
          role: ((data.role as string) || "user") as
            | "user"
            | "assistant"
            | "system",
          parentId: (data.parentId as string) || undefined,
          attachments: (data.attachments as Array<unknown>) || undefined,
          metadata: (data.metadata as Record<string, unknown>) || {},
          userId,
        },
        userId
      );
    } else if (action === "delete") {
      await messageRepo.delete(data.id as string, userId);
    }

    return { success: true, action };
  });
};

export const messagesExecutor = inngest.createFunction(
  {
    id: "messages-executor",
    name: "Execute Message Operations",
    concurrency: { limit: 10 },
  },
  { event: "messages.*.validated" },
  messagesHandler
);
