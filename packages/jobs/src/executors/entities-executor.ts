
import { inngest } from "../client.js";
import { getDb, EventRepository, EntityRepository } from "@synap/database";

export const entitiesHandler = async ({ step, event }: { step: any, event: any }) => {
  const db = await getDb();
  const eventRepo = new EventRepository(db as any);
  const entityRepo = new EntityRepository(db, eventRepo);
  
  const action = event.name.split('.')[1] as 'create' | 'update' | 'delete';
  const { userId } = event.user;
  const data = event.data;

  // Use step functionality
  return await step.run("process-entity", async () => {
    switch (action) {
      case 'create':
        await entityRepo.create({
          entityType: data.entityType,
          title: data.title,
          userId,
        }, userId);
        break;
        
      case 'update':
        await entityRepo.update(data.id, {
          title: data.title,
        }, userId);
        break;
        
      case 'delete':
        await entityRepo.delete(data.id, userId);
        break;
    }
    return { success: true, action };
  });
};

export const entitiesExecutor = inngest.createFunction(
  {
    id: "entities-executor",
    name: "Execute Entity Operations",
    concurrency: { limit: 10 },
  },
  { event: "entities.*.validated" },
  entitiesHandler
);
