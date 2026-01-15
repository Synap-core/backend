
import { inngest } from "../client.js";
import { getDb, EventRepository, RelationRepository } from "@synap/database";

export const relationsHandler = async ({ event, step }: { event: any, step: any }) => {
  const action = event.name.split('.')[1] as 'create' | 'update' | 'delete';
  const { userId } = event.user;
  const data = event.data;
  
  const db = await getDb();
  const eventRepo = new EventRepository(db as any);
  const relationRepo = new RelationRepository(db, eventRepo);
  
  if (action === 'create') {
    await step.run('create-relation', async () => {
      await relationRepo.create({
        id: data.id,
        sourceEntityId: data.sourceEntityId,
        targetEntityId: data.targetEntityId,
        type: data.type,
        userId,
      }, userId);
    });
  } else if (action === 'update') {
    await step.run('update-relation', async () => {
      await relationRepo.update(data.id, {
        type: data.type,
      }, userId);
    });
  } else if (action === 'delete') {
    await step.run('delete-relation', async () => {
      await relationRepo.delete(data.id, userId);
    });
  }
  
  return { success: true, action };
};

export const relationsExecutor = inngest.createFunction(
  {
    id: "relations-executor",
    name: "Execute Relation Operations",
    concurrency: { limit: 50 },
  },
  { event: "relations.*.validated" },
  relationsHandler
);
