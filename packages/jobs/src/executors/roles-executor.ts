import { inngest } from "../client.js";
import { getDb, EventRepository, RoleRepository, sql } from "@synap/database";
import {
  extractEventInfo,
  type UnifiedEventData,
} from "../types/unified-events.js";

export const rolesHandler = async ({
  event,
  step,
}: {
  event: { name: string; data: UnifiedEventData; user: { id: string } };
  step: any;
}) => {
  const eventInfo = extractEventInfo(event.name);
  const { action, phase } = eventInfo;

  if (phase !== "validated") {
    console.warn(`[rolesExecutor] Received non-validated event: ${event.name}`);
    return { success: false, reason: "Not a validated event" };
  }

  const db = await getDb();
  const eventRepo = new EventRepository(sql);
  const roleRepo = new RoleRepository(db, eventRepo);

  const userId = event.user.id;
  const data = event.data;

  if (action === "create") {
    await step.run("create-role", async () => {
      // BaseRepository.emitCompleted() automatically emits "roles.create.completed"
      return roleRepo.create(
        {
          name: (data.name as string) || "Untitled",
          description: (data.description as string) || undefined,
          workspaceId: (data.workspaceId as string) || undefined,
          permissions: (data.permissions as Record<string, unknown>) || {},
          filters: (data.filters as Record<string, unknown>) || {},
          createdBy: userId,
        },
        userId
      );
    });
  } else if (action === "update") {
    await step.run("update-role", async () => {
      // BaseRepository.emitCompleted() automatically emits "roles.update.completed"
      return roleRepo.update(
        data.id as string,
        {
          name: (data.name as string) || undefined,
          description: (data.description as string) || undefined,
          permissions:
            (data.permissions as Record<string, unknown>) || undefined,
          filters: (data.filters as Record<string, unknown>) || undefined,
        },
        userId
      );
    });
  } else if (action === "delete") {
    await step.run("delete-role", async () => {
      // BaseRepository.emitCompleted() automatically emits "roles.delete.completed"
      return roleRepo.delete(data.id as string, userId);
    });
  }

  return { success: true, action };
};

export const rolesExecutor = inngest.createFunction(
  {
    id: "roles-executor",
    name: "Execute Role Operations",
    concurrency: { limit: 20 },
  },
  { event: "roles.*.validated" },
  rolesHandler
);
