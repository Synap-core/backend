import { inngest } from "../client.js";
import {
  getDb,
  EventRepository,
  ProjectRepository,
  sql,
} from "@synap/database";
import {
  extractEventInfo,
  type UnifiedEventData,
} from "../types/unified-events.js";

export const projectsHandler = async ({
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
      `[projectsExecutor] Received non-validated event: ${event.name}`
    );
    return { success: false, reason: "Not a validated event" };
  }

  const db = await getDb();
  const eventRepo = new EventRepository(sql);
  const projectRepo = new ProjectRepository(db, eventRepo);

  const userId = event.user.id;
  const data = event.data;

  if (action === "create") {
    await step.run("create-project", async () => {
      await projectRepo.create(
        {
          id: data.id as string,
          name: (data.name as string) || "Untitled",
          description: (data.description as string) || undefined,
          status: ((data.status as string) || "active") as
            | "active"
            | "archived"
            | "completed",
          settings: (data.settings as Record<string, unknown>) || {},
          metadata: (data.metadata as Record<string, unknown>) || {},
          userId,
        },
        userId
      );
      // BaseRepository.emitCompleted() automatically emits "projects.create.completed"
    });
  } else if (action === "update") {
    await step.run("update-project", async () => {
      await projectRepo.update(
        data.id as string,
        {
          name: (data.name as string) || undefined,
          description: (data.description as string) || undefined,
          status: data.status
            ? (data.status as "active" | "archived" | "completed")
            : undefined,
          settings: (data.settings as Record<string, unknown>) || undefined,
          metadata: (data.metadata as Record<string, unknown>) || undefined,
        },
        userId
      );
      // BaseRepository.emitCompleted() automatically emits "projects.update.completed"
    });
  } else if (action === "delete") {
    await step.run("delete-project", async () => {
      await projectRepo.delete(data.id as string, userId);
      // BaseRepository.emitCompleted() automatically emits "projects.delete.completed"
    });
  }

  return { success: true, action };
};

export const projectsExecutor = inngest.createFunction(
  {
    id: "projects-executor",
    name: "Execute Project Operations",
    concurrency: { limit: 20 },
  },
  { event: "projects.*.validated" },
  projectsHandler
);
