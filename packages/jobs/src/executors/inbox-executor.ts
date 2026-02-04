import { inngest } from "../client.js";
import { getDb, EventRepository, InboxRepository, sql } from "@synap/database";
import {
  extractEventInfo,
  type UnifiedEventData,
} from "../types/unified-events.js";

export const inboxHandler = async ({
  event,
  step,
}: {
  event: { name: string; data: UnifiedEventData; user: { id: string } };
  step: any;
}) => {
  const eventInfo = extractEventInfo(event.name);
  const { action, phase } = eventInfo;

  if (phase !== "validated") {
    console.warn(`[inboxExecutor] Received non-validated event: ${event.name}`);
    return { success: false, reason: "Not a validated event" };
  }

  const db = await getDb();
  const eventRepo = new EventRepository(sql);
  const inboxRepo = new InboxRepository(db, eventRepo);

  const userId = event.user.id;
  const data = event.data;

  if (action === "create") {
    await step.run("create-inbox-item", async () => {
      await inboxRepo.create(
        {
          id: data.id as string,
          userId: (data.userId as string) || userId,
          provider: data.provider as string,
          account: (data.account as string) || "",
          externalId: (data.externalId as string) || "",
          type: data.type as string,
          title: (data.title as string) || "Untitled",
          preview: (data.preview as string) || undefined,
          timestamp: data.timestamp
            ? new Date(data.timestamp as string)
            : new Date(),
          status: ((data.status as string) || "unread") as
            | "unread"
            | "read"
            | "archived"
            | "snoozed",
          deepLink: (data.deepLink as string) || undefined,
          priority: ((data.priority as string) || "normal") as
            | "urgent"
            | "high"
            | "normal"
            | "low"
            | undefined,
          tags: (data.tags as string[]) || [],
          data: (data.data as Record<string, unknown>) || {},
        },
        userId
      );
      // BaseRepository.emitCompleted() automatically emits "inboxItems.create.completed"
    });
  } else if (action === "update") {
    await step.run("update-inbox-item", async () => {
      await inboxRepo.update(
        data.id as string,
        {
          title: (data.title as string) || undefined,
          preview: (data.preview as string) || undefined,
          status: data.status
            ? (data.status as "unread" | "read" | "archived" | "snoozed")
            : undefined,
          priority: data.priority
            ? (data.priority as "urgent" | "high" | "normal" | "low")
            : undefined,
          tags: (data.tags as string[]) || undefined,
          snoozedUntil: data.snoozedUntil
            ? new Date(data.snoozedUntil as string)
            : undefined,
          data: (data.data as Record<string, unknown>) || undefined,
        },
        userId
      );
      // BaseRepository.emitCompleted() automatically emits "inboxItems.update.completed"
    });
  } else if (action === "delete") {
    await step.run("delete-inbox-item", async () => {
      await inboxRepo.delete(data.id as string, userId);
      // BaseRepository.emitCompleted() automatically emits "inboxItems.delete.completed"
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
