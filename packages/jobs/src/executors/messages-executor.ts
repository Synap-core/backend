import { inngest } from "../client.js";
import { getDb, EventRepository, MessageRepository } from "@synap/database";

export const messagesHandler = async ({
  event,
  step,
}: {
  event: any;
  step: any;
}) => {
  const action = event.name.split(".")[1] as "create" | "delete";
  const { userId } = event.user;
  const data = event.data;

  const db = await getDb();
  const eventRepo = new EventRepository(db as any);
  const messageRepo = new MessageRepository(db, eventRepo);

  return await step.run("process-message", async () => {
    if (action === "create") {
      await messageRepo.create(
        {
          threadId: data.threadId,
          content: data.content,
          role: data.role,
          parentId: data.parentId,
          attachments: data.attachments,
          metadata: data.metadata,
          userId,
        },
        userId
      );
    } else if (action === "delete") {
      await messageRepo.delete(data.id, userId);
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
