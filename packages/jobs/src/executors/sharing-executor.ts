
import { inngest } from "../client.js";
import { getDb, EventRepository, SharingRepository } from "@synap/database";

export const sharingHandler = async ({ event, step }: { event: any, step: any }) => {
  const action = event.name.split('.')[1] as 'create' | 'update' | 'delete';
  const { userId } = event.user;
  const data = event.data;
  
  const db = await getDb();
  const eventRepo = new EventRepository(db as any);
  const sharingRepo = new SharingRepository(db, eventRepo);
  
  if (action === 'create') {
    await step.run('create-sharing', async () => {
      await sharingRepo.create({
        id: data.id,
        resourceType: data.resourceType,
        resourceId: data.resourceId,
        sharedByUserId: data.sharedByUserId,
        sharedWithUserId: data.sharedWithUserId,
        sharedWithEmail: data.sharedWithEmail,
        permission: data.permission,
        metadata: data.metadata,
      }, userId);
    });
  } else if (action === 'update') {
    await step.run('update-sharing', async () => {
      await sharingRepo.update(data.id, {
        permission: data.permission,
        metadata: data.metadata,
      }, userId);
    });
  } else if (action === 'delete') {
    await step.run('delete-sharing', async () => {
      await sharingRepo.delete(data.id, userId);
    });
  }
  
  return { success: true, action };
};

export const sharingExecutor = inngest.createFunction(
  {
    id: "sharing-executor",
    name: "Execute Sharing Operations",
    concurrency: { limit: 30 },
  },
  { event: "sharing.*.validated" },
  sharingHandler
);
