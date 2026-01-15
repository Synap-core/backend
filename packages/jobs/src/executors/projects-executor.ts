
import { inngest } from "../client.js";
import { getDb, EventRepository, ProjectRepository } from "@synap/database";

export const projectsHandler = async ({ event, step }: { event: any, step: any }) => {
  const action = event.name.split('.')[1] as 'create' | 'update' | 'delete';
  const { userId } = event.user;
  const data = event.data;
  
  const db = await getDb();
  const eventRepo = new EventRepository(db as any);
  const projectRepo = new ProjectRepository(db, eventRepo);
  
  if (action === 'create') {
    await step.run('create-project', async () => {
      await projectRepo.create({
        id: data.id,
        name: data.name,
        description: data.description,
        status: data.status,
        settings: data.settings,
        metadata: data.metadata,
        userId,
      }, userId);
    });
  } else if (action === 'update') {
    await step.run('update-project', async () => {
      await projectRepo.update(data.id, {
        name: data.name,
        description: data.description,
        status: data.status,
        settings: data.settings,
        metadata: data.metadata,
      }, userId);
    });
  } else if (action === 'delete') {
    await step.run('delete-project', async () => {
      await projectRepo.delete(data.id, userId);
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
