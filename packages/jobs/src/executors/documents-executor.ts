
import { inngest } from "../client.js";
import { getDb, EventRepository, DocumentRepository, eq, and, documents } from "@synap/database";

export const documentsHandler = async ({ event, step }: { event: any, step: any }) => {
  const action = event.name.split('.')[1] as 'create' | 'update' | 'delete';
  const { userId } = event.user;
  const data = event.data;
  
  const db = await getDb();
  const eventRepo = new EventRepository(db as any);
  const docRepo = new DocumentRepository(db, eventRepo);
  
  if (action === 'create') {
    // Step 1: Upload file to storage
    const uploadResult = await step.run('upload-file', async () => {
      const { storage } = await import('@synap/storage');
      
      // Build standardized storage path
      const extension = data.type === 'markdown' ? 'md' : data.type;
      const key = storage.buildPath(userId, 'document', data.id, extension);
      
      // Upload content to storage
      const metadata = await storage.upload(
        key,
        data.content || '',
        { contentType: data.mimeType || 'text/markdown' }
      );
      
      return {
        url: metadata.url,
        key: metadata.path,
        size: metadata.size,
        checksum: metadata.checksum,
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
    await step.run('delete-storage-file', async () => {
      // Get document to retrieve storage key
      const document = await db.query.documents.findFirst({
        where: and(eq(documents.id, data.id), eq(documents.userId, userId))
      });
      
      if (document?.storageKey) {
        const { storage } = await import('@synap/storage');
        try {
          await storage.delete(document.storageKey);
        } catch (error) {
          console.warn(`Failed to delete storage file ${document.storageKey}:`, error);
        }
      }
    });
    
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
