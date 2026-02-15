import { inngest } from "../client.js";
import {
  getDb,
  EventRepository,
  ViewRepository,
  sql,
  type ViewType,
} from "@synap/database";
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
          type: data.type as string as ViewType,
          name: (data.name as string) || "Untitled",
          description: (data.description as string) || undefined,
          documentId: (data.documentId as string) || undefined,
          workspaceId: (data.workspaceId as string) || "",
          scopeProfileIds: (data.scopeProfileIds as string[]) || undefined,
          scopeMode: (data.scopeMode as "explicit" | "observed") || undefined,
          query: (data.query as Record<string, unknown>) || undefined,
          config: (data.config as Record<string, unknown>) || undefined,
          embeddedViewIds: (data.embeddedViewIds as string[]) || undefined,
          metadata: (data.metadata as Record<string, unknown>) || undefined,
          userId,
        },
        userId
      );
      // BaseRepository.emitCompleted() automatically emits "view.create.completed"
      break;

    case "update":
      await viewRepo.update(
        data.id as string,
        {
          name: (data.name as string) || undefined,
          description: (data.description as string) || undefined,
          scopeProfileIds: (data.scopeProfileIds as string[]) || undefined,
          scopeMode: (data.scopeMode as "explicit" | "observed") || undefined,
          query: (data.query as Record<string, unknown>) || undefined,
          config: (data.config as Record<string, unknown>) || undefined,
          embeddedViewIds: (data.embeddedViewIds as string[]) || undefined,
          schemaSnapshot:
            (data.schemaSnapshot as Record<string, unknown>) || undefined,
          snapshotUpdatedAt: (data.snapshotUpdatedAt as Date) || undefined,
        },
        userId
      );
      // BaseRepository.emitCompleted() automatically emits "view.update.completed"
      break;

    case "delete":
      await viewRepo.delete(data.id as string, userId);
      // BaseRepository.emitCompleted() automatically emits "view.delete.completed"
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
  { event: "view.*" },
  viewsHandler
);
