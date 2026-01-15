
import { inngest } from "../client.js";
import { getDb, EventRepository, DocumentRepository } from "@synap/database";

export const documentsHandler = async ({ event, step }: { event: any, step: any }) => {
  const action = event.name.split('.')[1] as 'create' | 'update' | 'delete';
  const { userId } = event.user;
  const data = event.data;
  
  const db = await getDb();
  const eventRepo = new EventRepository(db as any);
  const docRepo = new DocumentRepository(db, eventRepo);
  
  if (action === 'create') {
    // Step 1: Upload file
    const uploadResult = await step.run('upload-file', async () => {
      // TODO: Implement actual file upload to R2/S3
      const key = `documents/${userId}/${Date.now()}.${data.type}`;
      return {
        url: `https://storage.synap.app/${key}`,
        key,
        size: data.content?.length || 0,
      };
    });
    
    // Step 2: Create document
    await step.run('create-document', async () => {
      await docRepo.create({
        title: data.title,
        type: data.type,
        language: data.language,
        storageUrl: uploadResult.url,
        storageKey: uploadResult.key,
        size: uploadResult.size,
        mimeType: data.mimeType || 'text/plain',
        projectId: data.projectId,
        metadata: data.metadata,
        userId,
      }, userId);
    });
  } else if (action === 'update') {
    await step.run('update-document', async () => {
      await docRepo.update(data.id, {
        title: data.title,
        currentVersion: data.currentVersion,
        size: data.size,
        metadata: data.metadata,
      }, userId);
    });
  } else if (action === 'delete') {
    await step.run('delete-document', async () => {
      await docRepo.delete(data.id, userId);
    });
  }
  
  return { success: true, action };
};

export const documentsExecutor = inngest.createFunction(
  {
    id: "documents-executor",
    name: "Execute Document Operations",
    concurrency: { limit: 10 }, // Lower concurrency for complex operations
  },
  { event: "documents.*.validated" },
  documentsHandler
);
