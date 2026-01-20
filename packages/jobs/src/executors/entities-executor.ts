import { inngest } from "../client.js";
import {
  getDb,
  EventRepository,
  EntityRepository,
  DocumentRepository,
  eq,
  and,
  entities,
  documents,
} from "@synap/database";
import { randomUUID } from "crypto";

export const entitiesHandler = async ({
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
  const entityRepo = new EntityRepository(db, eventRepo);
  const docRepo = new DocumentRepository(db, eventRepo);

  if (action === "create") {
    // Check if content is provided for atomic creation
    if (data.content) {
      // Atomic entity + document creation
      const docId = randomUUID();

      // Step 1: Upload content to storage
      const uploadResult = await step.run("upload-content", async () => {
        const { storage } = await import("@synap/storage");

        const key = storage.buildPath(userId, "entity", data.id, "md");
        const metadata = await storage.upload(key, data.content, {
          contentType: "text/markdown",
        });

        return {
          url: metadata.url,
          key: metadata.path,
          size: metadata.size,
        };
      });

      // Step 2: Create document
      await step.run("create-document", async () => {
        await docRepo.create(
          {
            title: data.title || "Untitled",
            type: "markdown",
            storageUrl: uploadResult.url,
            storageKey: uploadResult.key,
            size: uploadResult.size,
            mimeType: "text/markdown",
            userId,
          },
          userId
        );
      });

      // Step 3: Create entity with documentId
      await step.run("create-entity", async () => {
        await entityRepo.create(
          {
            entityType: data.entityType,
            title: data.title,
            preview: data.preview,
            documentId: docId, // Link to document
            metadata: data.metadata,
            userId,
          },
          userId
        );
      });
    } else {
      // Simple entity creation without document
      await step.run("create-entity", async () => {
        await entityRepo.create(
          {
            entityType: data.entityType,
            title: data.title,
            preview: data.preview,
            documentId: data.documentId, // Use provided documentId if any
            metadata: data.metadata,
            userId,
          },
          userId
        );
      });
    }
  } else if (action === "update") {
    await step.run("update-entity", async () => {
      await entityRepo.update(
        data.id,
        {
          title: data.title,
          preview: data.preview,
          content: data.content,
          metadata: data.metadata,
        },
        userId
      );
    });
  } else if (action === "delete") {
    // Get user's preference for cascading document deletion
    const { getUserPreference } = await import("@synap/database");
    const userPref = await getUserPreference(userId, "entity.deleteDocument");

    // Allow override via event data, fall back to user preference
    const deleteDocument = data.deleteDocument ?? userPref;

    if (deleteDocument) {
      // Get entity to find linked document
      const entity = await step.run("get-entity", async () => {
        return db.query.entities.findFirst({
          where: and(eq(entities.id, data.id), eq(entities.userId, userId)),
        });
      });

      // Delete linked document (which will also delete storage)
      if (entity?.documentId) {
        await step.run("delete-linked-document", async () => {
          // Get document for storage key
          const document = await db.query.documents.findFirst({
            where: and(
              eq(documents.id, entity.documentId!),
              eq(documents.userId, userId)
            ),
          });

          if (document) {
            // Delete storage file
            const { storage } = await import("@synap/storage");
            try {
              await storage.delete(document.storageKey);
            } catch (error) {
              console.warn(
                `Failed to delete storage file ${document.storageKey}:`,
                error
              );
            }

            // Delete document from DB
            await docRepo.delete(entity.documentId!, userId);
          }
        });
      }
    }

    // Delete entity
    await step.run("delete-entity", async () => {
      await entityRepo.delete(data.id, userId, { deleteDocument });
    });
  }

  return { success: true, action };
};

export const entitiesExecutor = inngest.createFunction(
  {
    id: "entities-executor",
    name: "Execute Entity Operations",
    concurrency: { limit: 20 },
  },
  { event: "entities.*.validated" },
  entitiesHandler
);
