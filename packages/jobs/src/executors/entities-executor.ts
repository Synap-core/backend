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

      const workspaceId = (data.workspaceId as string) || "";
      if (!workspaceId) {
        throw new Error("workspaceId is required for entity creation");
      }

      // Step 2: Create document (with workspaceId for schema)
      const createdDocument = await step.run("create-document", async () => {
        return docRepo.create(
          {
            title: (data.title as string) || "Untitled",
            type: "markdown",
            storageUrl: uploadResult.url,
            storageKey: uploadResult.key,
            size: uploadResult.size,
            mimeType: "text/markdown",
            userId,
            workspaceId,
          },
          userId
        );
      });

      // Step 3: Create entity with documentId, then set document.entity_id (Option B)
      const createdEntity = await step.run("create-entity", async () => {
        const entityInput: Parameters<typeof entityRepo.create>[0] = {
          workspaceId,
          userId,
          title: (data.title as string) || undefined,
          preview: (data.preview as string) || undefined,
          documentId: createdDocument.id,
          properties: (data.properties as Record<string, unknown>) || undefined,
        };

        if (data.profileId) {
          entityInput.profileId = data.profileId as string;
        } else if (data.profileSlug) {
          entityInput.profileSlug = data.profileSlug as string;
        } else if (data.type) {
          entityInput.profileSlug = data.type as string;
        } else {
          throw new Error(
            "Either profileId, profileSlug, or type must be provided"
          );
        }

        const entity = await entityRepo.create(entityInput, userId);
        return entity;
      });

      // Step 4: Link document to entity (Option B symmetric link)
      await step.run("link-document-to-entity", async () => {
        await docRepo.update(
          createdDocument.id,
          {
            entityId: createdEntity.id,
          },
          userId
        );
      });
    } else {
      // Simple entity creation without document
      await step.run("create-entity", async () => {
        const workspaceId = (data.workspaceId as string) || "";
        if (!workspaceId) {
          throw new Error("workspaceId is required for entity creation");
        }

        // Prepare entity input (profile-based)
        const entityInput: Parameters<typeof entityRepo.create>[0] = {
          workspaceId,
          userId,
          title: (data.title as string) || undefined,
          preview: (data.preview as string) || undefined,
          documentId: (data.documentId as string) || undefined,
          properties: (data.properties as Record<string, unknown>) || undefined,
        };

        // Prefer profile-based, fallback to legacy type
        if (data.profileId) {
          entityInput.profileId = data.profileId as string;
        } else if (data.profileSlug) {
          entityInput.profileSlug = data.profileSlug as string;
        } else if (data.type) {
          // Legacy: use type as profileSlug
          entityInput.profileSlug = data.type as string;
        } else {
          throw new Error(
            "Either profileId, profileSlug, or type must be provided"
          );
        }

        await entityRepo.create(entityInput, userId);
      });
    }
  } else if (action === "update") {
    const entityId = data.id as string;
    const newDocumentId = data.documentId as string | null | undefined;

    const previousEntity = await step.run("get-entity-for-update", async () => {
      return db.query.entities.findFirst({
        where: and(eq(entities.id, entityId), eq(entities.userId, userId)),
        columns: { documentId: true },
      });
    });

    await step.run("update-entity", async () => {
      await entityRepo.update(
        entityId,
        {
          title: (data.title as string) || undefined,
          preview: (data.preview as string) || undefined,
          documentId: newDocumentId,
          properties: (data.properties as Record<string, unknown>) || undefined,
        },
        userId
      );
    });

    // Option B: sync document.entity_id when entity.documentId changes
    const oldDocumentId = previousEntity?.documentId ?? null;
    if (oldDocumentId !== (newDocumentId ?? null)) {
      await step.run("sync-document-entity-link", async () => {
        if (oldDocumentId) {
          await docRepo.update(oldDocumentId, { entityId: null }, userId);
        }
        if (newDocumentId) {
          await docRepo.update(newDocumentId, { entityId: entityId }, userId);
        }
      });
    }
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
      // BaseRepository.emitCompleted() automatically emits "entity.delete.completed"
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
  { event: "entity.*" },
  entitiesHandler
);
