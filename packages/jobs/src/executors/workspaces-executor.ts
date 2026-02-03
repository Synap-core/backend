import { inngest } from "../client.js";
import { getDb, EventRepository, WorkspaceRepository } from "@synap/database";
import type { Workspace } from "@synap/database/schema";

export const workspacesHandler = async ({
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
  const workspaceRepo = new WorkspaceRepository(db, eventRepo);

  let workspace: Workspace | undefined;

  if (action === "create") {
    workspace = await step.run("create-workspace", async () => {
      console.log(
        `[workspacesExecutor] Creating workspace:`,
        data.id,
        data.name,
        userId
      );
      const created = await workspaceRepo.create(
        {
          id: data.id,
          name: data.name,
          ownerId: data.ownerId || userId,
          settings: data.settings,
        },
        userId
      );
      console.log(
        `[workspacesExecutor] Workspace created successfully:`,
        created.id
      );
      return created;
    });

    // Emit completed event to Inngest so other functions (like whiteboard creation) can react
    await step.run("emit-completed-event", async () => {
      console.log(
        `[workspacesExecutor] Emitting workspaces.create.completed for workspace:`,
        workspace?.id
      );
      await inngest.send({
        name: "workspaces.create.completed",
        data: workspace,
        user: { id: userId },
      });
      console.log(`[workspacesExecutor] Completed event emitted successfully`);
    });
  } else if (action === "update") {
    workspace = await step.run("update-workspace", async () => {
      return await workspaceRepo.update(
        data.id,
        {
          name: data.name,
          settings: data.settings,
        },
        userId
      );
    });

    // Emit completed event to Inngest
    await step.run("emit-completed-event", async () => {
      await inngest.send({
        name: "workspaces.update.completed",
        data: workspace,
        user: { id: userId },
      });
    });
  } else if (action === "delete") {
    await step.run("delete-workspace", async () => {
      await workspaceRepo.delete(data.id, userId);
    });

    // Emit completed event to Inngest
    await step.run("emit-completed-event", async () => {
      await inngest.send({
        name: "workspaces.delete.completed",
        data: { id: data.id },
        user: { id: userId },
      });
    });
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
