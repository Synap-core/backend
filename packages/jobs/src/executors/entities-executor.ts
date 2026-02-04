import { inngest } from "../client.js";
import {
  getDb,
  EventRepository,
  EntityRepository,
  DocumentRepository,
  sql,
  eq,
  and,
  entities,
  documents,
  EntityType,
} from "@synap/database";
import { randomUUID } from "crypto";
import {
  extractEventInfo,
  type UnifiedEventData,
} from "../types/unified-events.js";

export const entitiesHandler = async ({
  event,
  step,
}: {
  event: { name: string; data: UnifiedEventData; user: { id: string } };
  step: any;
}) => {
  // Extract event info using unified event system
  const eventInfo = extractEventInfo(event.name);
  const { action, phase } = eventInfo;

  // Ensure we're handling a validated event
  if (phase !== "validated") {
    console.warn(
      `[entitiesExecutor] Received non-validated event: ${event.name}`
    );
    return { success: false, reason: "Not a validated event" };
  }

  const userId = event.user.id;
  const data = event.data;

  const db = await getDb();
  const eventRepo = new EventRepository(sql);
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

        const entityId = (data.id as string) || randomUUID();
        const content = (data.content as string) || "";
        const key = storage.buildPath(userId, "entity", entityId, "md");
        const metadata = await storage.upload(key, content, {
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
            title: (data.title as string) || "Untitled",
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
        // Handle both 'type' (from API) and 'entityType' (from repository interface)
        // Standardize on entityType for consistency
        const entityTypeValue =
          (data.entityType as string) || (data.type as string);
        if (!entityTypeValue) {
          throw new Error(
            "Entity type is required (must provide either 'type' or 'entityType')"
          );
        }

        // Validate and cast to EntityType enum
        const entityType = Object.values(EntityType).includes(
          entityTypeValue as EntityType
        )
          ? (entityTypeValue as EntityType)
          : EntityType.NOTE; // Default fallback

        await entityRepo.create(
          {
            entityType,
            title: (data.title as string) || undefined,
            preview: (data.preview as string) || undefined,
            documentId: docId, // Link to document
            metadata: (data.metadata as Record<string, unknown>) || {},
            userId,
          },
          userId
        );
      });
    } else {
      // Simple entity creation without document
      await step.run("create-entity", async () => {
        // Handle both 'type' (from API) and 'entityType' (from repository interface)
        // Standardize on entityType for consistency
        const entityTypeValue =
          (data.entityType as string) || (data.type as string);
        if (!entityTypeValue) {
          throw new Error(
            "Entity type is required (must provide either 'type' or 'entityType')"
          );
        }

        // Validate and cast to EntityType enum
        const entityType = Object.values(EntityType).includes(
          entityTypeValue as EntityType
        )
          ? (entityTypeValue as EntityType)
          : EntityType.NOTE; // Default fallback

        await entityRepo.create(
          {
            entityType,
            title: (data.title as string) || undefined,
            preview: (data.preview as string) || undefined,
            documentId: (data.documentId as string) || undefined, // Use provided documentId if any
            metadata: (data.metadata as Record<string, unknown>) || {},
            userId,
          },
          userId
        );
      });
    }
  } else if (action === "update") {
    await step.run("update-entity", async () => {
      await entityRepo.update(
        data.id as string,
        {
          title: (data.title as string) || undefined,
          preview: (data.preview as string) || undefined,
          content: (data.content as string) || undefined,
          metadata: (data.metadata as Record<string, unknown>) || undefined,
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
          where: and(
            eq(entities.id, data.id as string),
            eq(entities.userId, userId)
          ),
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
            // Delete storage file (all documents use MinIO)
            const { storage } = await import("@synap/storage");
            try {
              if (document.storageKey) {
                await storage.delete(document.storageKey);
              }
            } catch (error) {
              console.warn(
                `Failed to delete storage file ${document.storageKey || "unknown"}:`,
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
      await entityRepo.delete(data.id as string, userId, { deleteDocument });
      // BaseRepository.emitCompleted() automatically emits "entities.delete.completed"
    });
  }

  // Note: Completed events are automatically emitted by BaseRepository
  // when calling repo.create(), repo.update(), or repo.delete()
  // No need to manually emit here

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
