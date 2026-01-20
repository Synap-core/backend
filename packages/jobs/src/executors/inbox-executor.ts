import { inngest } from "../client.js";
import { getDb, EventRepository, InboxRepository } from "@synap/database";

export const inboxHandler = async ({
  event,
  step,
}: {
  event: any;
  step: any;
}) => {
  const action = event.name.split(".")[1] as "create" | "update" | "delete";
  const { userId } = event.user;
  const data = event.data;

  const db = await getDb();
  const eventRepo = new EventRepository(db as any);
  const inboxRepo = new InboxRepository(db, eventRepo);

  if (action === "create") {
    await step.run("create-inbox-item", async () => {
      await inboxRepo.create(
        {
          id: data.id,
          userId: data.userId,
          provider: data.provider,
          account: data.account,
          externalId: data.externalId,
          type: data.type,
          title: data.title,
          preview: data.preview,
          timestamp: data.timestamp,
          status: data.status,
          deepLink: data.deepLink,
          priority: data.priority,
          tags: data.tags,
          data: data.data,
        },
        userId
      );
    });
  } else if (action === "update") {
    await step.run("update-inbox-item", async () => {
      await inboxRepo.update(
        data.id,
        {
          title: data.title,
          preview: data.preview,
          status: data.status,
          priority: data.priority,
          tags: data.tags,
          snoozedUntil: data.snoozedUntil,
          data: data.data,
        },
        userId
      );
    });
  } else if (action === "delete") {
    await step.run("delete-inbox-item", async () => {
      await inboxRepo.delete(data.id, userId);
    });
  }

  return { success: true, action };
};

export const inboxExecutor = inngest.createFunction(
  {
    id: "inbox-executor",
    name: "Execute Inbox Operations",
    concurrency: { limit: 50 },
  },
  { event: "inbox.*.validated" },
  inboxHandler
);
