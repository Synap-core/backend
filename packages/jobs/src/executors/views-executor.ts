import { inngest } from "../client.js";
import { getDb, EventRepository, ViewRepository, sql } from "@synap/database";
import {
  extractEventInfo,
  type UnifiedEventData,
} from "../types/unified-events.js";

export const viewsHandler = async ({
  event,
}: {
  event: { name: string; data: UnifiedEventData; user: { id: string } };
}) => {
  const eventInfo = extractEventInfo(event.name);
  const { action, phase } = eventInfo;

  if (phase !== "validated") {
    console.warn(`[viewsExecutor] Received non-validated event: ${event.name}`);
    return { success: false, reason: "Not a validated event" };
  }

  const db = await getDb();
  const eventRepo = new EventRepository(sql);
  const viewRepo = new ViewRepository(db, eventRepo);

  const userId = event.user.id;
  const data = event.data;

  switch (action) {
    case "create":
      await viewRepo.create(
        {
          id: data.id as string,
          type: data.type as string as
            | "whiteboard"
            | "timeline"
            | "kanban"
            | "table"
            | "calendar",
          name: (data.name as string) || "Untitled",
          documentId: (data.documentId as string) || undefined,
          workspaceId: (data.workspaceId as string) || "",
          config: (data.config as Record<string, unknown>) || {},
          userId,
        },
        userId
      );
      // BaseRepository.emitCompleted() automatically emits "views.create.completed"
      break;

    case "update":
      await viewRepo.update(
        data.id as string,
        {
          name: (data.name as string) || undefined,
          config: (data.config as Record<string, unknown>) || undefined,
        },
        userId
      );
      // BaseRepository.emitCompleted() automatically emits "views.update.completed"
      break;

    case "delete":
      await viewRepo.delete(data.id as string, userId);
      // BaseRepository.emitCompleted() automatically emits "views.delete.completed"
      break;
  }

  return { success: true, action };
};

export const viewsExecutor = inngest.createFunction(
  {
    id: "views-executor",
    name: "Execute View Operations",
    concurrency: { limit: 100 }, // High concurrency for fast operations
  },
  { event: "views.*.validated" },
  viewsHandler
);
