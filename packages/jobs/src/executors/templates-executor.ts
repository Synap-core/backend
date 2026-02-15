import { inngest } from "../client.js";
import {
  getDb,
  EventRepository,
  TemplateRepository,
  sql,
} from "@synap/database";
import {
  extractEventInfo,
  type UnifiedEventData,
} from "../types/unified-events.js";

export const templatesHandler = async ({
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
      `[templatesExecutor] Received non-validated event: ${event.name}`
    );
    return { success: false, reason: "Not a validated event" };
  }

  const db = await getDb();
  const eventRepo = new EventRepository(sql);
  const templateRepo = new TemplateRepository(db, eventRepo);

  const userId = event.user.id;
  const data = event.data;

  if (action === "create") {
    await step.run("create-template", async () => {
      await templateRepo.create(
        {
          id: data.id as string,
          name: (data.name as string) || "Untitled",
          description: (data.description as string) || undefined,
          targetType: data.targetType as string as
            | "entity"
            | "document"
            | "project"
            | "inbox_item",
          entityType: (data.entityType as string) || undefined,
          inboxItemType: (data.inboxItemType as string) || undefined,
          config: (data.config as Record<string, unknown>) || {},
          isPublic: (data.isPublic as boolean) || false,
          userId,
        },
        userId
      );
      // BaseRepository.emitCompleted() automatically emits "template.create.completed"
    });
  } else if (action === "update") {
    await step.run("update-template", async () => {
      await templateRepo.update(
        data.id as string,
        {
          name: (data.name as string) || undefined,
          description: (data.description as string) || undefined,
          config: (data.config as Record<string, unknown>) || undefined,
          isPublic:
            (data.isPublic as boolean) !== undefined
              ? (data.isPublic as boolean)
              : undefined,
        },
        userId
      );
      // BaseRepository.emitCompleted() automatically emits "template.update.completed"
    });
  } else if (action === "delete") {
    await step.run("delete-template", async () => {
      await templateRepo.delete(data.id as string, userId);
      // BaseRepository.emitCompleted() automatically emits "template.delete.completed"
    });
  }

  return { success: true, action };
};

export const templatesExecutor = inngest.createFunction(
  {
    id: "templates-executor",
    name: "Execute Template Operations",
    concurrency: { limit: 20 },
  },
  { event: "template.*" },
  templatesHandler
);
