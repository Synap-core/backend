
import { inngest } from "../client.js";
import { getDb, EventRepository, WorkspaceRepository } from "@synap/database";

export const workspacesHandler = async ({ event, step }: { event: any, step: any }) => {
  const action = event.name.split('.')[1] as 'create' | 'update' | 'delete';
  const { userId } = event.user;
  const data = event.data;
  
  const db = await getDb();
  const eventRepo = new EventRepository(db as any);
  const workspaceRepo = new WorkspaceRepository(db, eventRepo);
  
  if (action === 'create') {
    await step.run('create-workspace', async () => {
      await workspaceRepo.create({
        id: data.id,
        name: data.name,
        slug: data.slug,
        ownerId: data.ownerId || userId,
        settings: data.settings,
      }, userId);
    });
  } else if (action === 'update') {
    await step.run('update-workspace', async () => {
      await workspaceRepo.update(data.id, {
        name: data.name,
        slug: data.slug,
        settings: data.settings,
      }, userId);
    });
  } else if (action === 'delete') {
    await step.run('delete-workspace', async () => {
      await workspaceRepo.delete(data.id, userId);
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
