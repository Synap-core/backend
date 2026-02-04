import { inngest } from "../client.js";
import {
  getDb,
  EventRepository,
  WorkspaceRepository,
  sql,
} from "@synap/database";
import { randomUUID } from "crypto";
import {
  extractEventInfo,
  type UnifiedEventData,
} from "../types/unified-events.js";

export const workspacesHandler = async ({
  event,
  step,
}: {
  event: { name: string; data: UnifiedEventData; user: { id: string } };
  step: any;
}) => {
  // Extract event info using unified event system
  const eventInfo = extractEventInfo(event.name);
  const { action, phase } = eventInfo;

  // Ensure we're handling a validated event
  if (phase !== "validated") {
    console.warn(
      `[workspacesExecutor] Received non-validated event: ${event.name}`
    );
    return { success: false, reason: "Not a validated event" };
  }

  const userId = event.user.id;
  const data = event.data;

  const db = await getDb();
  const eventRepo = new EventRepository(sql);
  const workspaceRepo = new WorkspaceRepository(db, eventRepo);

  if (action === "create") {
    await step.run("create-workspace", async () => {
      console.log(
        `[workspacesExecutor] Creating workspace:`,
        data.id,
        data.name,
        userId
      );
      const created = await workspaceRepo.create(
        {
          id: (data.id as string) || randomUUID(),
          name: data.name as string,
          ownerId: (data.ownerId as string) || userId,
          settings: (data.settings as Record<string, unknown>) || {},
        },
        userId
      );
      console.log(
        `[workspacesExecutor] Workspace created successfully:`,
        created.id
      );
      // BaseRepository.emitCompleted() automatically emits "workspaces.create.completed"
      return created;
    });
  } else if (action === "update") {
    await step.run("update-workspace", async () => {
      return await workspaceRepo.update(
        data.id as string,
        {
          name: (data.name as string) || undefined,
          settings: (data.settings as Record<string, unknown>) || undefined,
        },
        userId
      );
    });

    // BaseRepository.emitCompleted() automatically emits "workspaces.update.completed"
  } else if (action === "delete") {
    await step.run("delete-workspace", async () => {
      await workspaceRepo.delete(data.id as string, userId);
    });

    // BaseRepository.emitCompleted() automatically emits "workspaces.delete.completed"
  }

  return { success: true, action };
};

export const workspacesExecutor = inngest.createFunction(
  {
    id: "workspaces-executor",
    name: "Execute Workspace Operations",
    concurrency: { limit: 20 }, // Moderate concurrency
  },
  { event: "workspaces.*.validated" },
  workspacesHandler
);
