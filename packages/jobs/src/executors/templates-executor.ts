
import { inngest } from "../client.js";
import { getDb, EventRepository, TemplateRepository } from "@synap/database";

export const templatesHandler = async ({ event, step }: { event: any, step: any }) => {
  const action = event.name.split('.')[1] as 'create' | 'update' | 'delete';
  const { userId } = event.user;
  const data = event.data;
  
  const db = await getDb();
  const eventRepo = new EventRepository(db as any);
  const templateRepo = new TemplateRepository(db, eventRepo);
  
  if (action === 'create') {
    await step.run('create-template', async () => {
      await templateRepo.create({
        id: data.id,
        name: data.name,
        description: data.description,
        targetType: data.targetType,
        entityType: data.entityType,
        inboxItemType: data.inboxItemType,
        config: data.config,
        isPublic: data.isPublic,
        userId,
      }, userId);
    });
  } else if (action === 'update') {
    await step.run('update-template', async () => {
      await templateRepo.update(data.id, {
        name: data.name,
        description: data.description,
        config: data.config,
        isPublic: data.isPublic,
      }, userId);
    });
  } else if (action === 'delete') {
    await step.run('delete-template', async () => {
      await templateRepo.delete(data.id, userId);
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
  { event: "templates.*.validated" },
  templatesHandler
);
