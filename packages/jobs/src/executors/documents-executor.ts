import { inngest } from "../client.js";
import {
  getDb,
  EventRepository,
  DocumentRepository,
  sql,
  eq,
  and,
  documents,
} from "@synap/database";
import { randomUUID } from "crypto";
import {
  extractEventInfo,
  type UnifiedEventData,
} from "../types/unified-events.js";
import { normalizeDocumentType } from "@synap/database";

export const documentsHandler = async ({
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
      `[documentsExecutor] Received non-validated event: ${event.name}`
    );
    return { success: false, reason: "Not a validated event" };
  }

  const userId = event.user.id;
  const data = event.data;

  const db = await getDb();
  const eventRepo = new EventRepository(sql);
  const docRepo = new DocumentRepository(db, eventRepo);

  if (action === "create") {
    const docId = (data.id as string) || randomUUID();
    const docType = normalizeDocumentType(data.type, "markdown");

    // Step 1: Upload file to storage
    const uploadResult = await step.run("upload-file", async () => {
      const { storage } = await import("@synap/storage");

      // Build standardized storage path
      const extension = docType === "markdown" ? "md" : docType;
      const key = storage.buildPath(userId, "document", docId, extension);

      // Upload content to storage
      const content = (data.content as string) || "";
      const metadata = await storage.upload(key, content, {
        contentType: (data.mimeType as string) || "text/markdown",
      });

      return {
        url: metadata.url,
        key: metadata.path,
        size: metadata.size,
        checksum: metadata.checksum,
      };
    });

    // Step 2: Create document
    await step.run("create-document", async () => {
      await docRepo.create(
        {
          title: (data.title as string) || "Untitled",
          type: docType as "text" | "markdown" | "code" | "pdf" | "docx", // DocumentRepository doesn't support whiteboard yet
          language: (data.language as string) || undefined,
          storageUrl: uploadResult.url,
          storageKey: uploadResult.key,
          size: uploadResult.size,
          mimeType: (data.mimeType as string) || "text/plain",
          projectId: (data.projectId as string) || undefined,
          metadata: (data.metadata as Record<string, unknown>) || {},
          userId,
        },
        userId
      );
    });
  } else if (action === "update") {
    await step.run("update-document", async () => {
      await docRepo.update(
        data.id as string,
        {
          title: (data.title as string) || undefined,
          currentVersion: (data.currentVersion as number) || undefined,
          size: (data.size as number) || undefined,
          metadata: (data.metadata as Record<string, unknown>) || undefined,
        },
        userId
      );
    });
  } else if (action === "delete") {
    await step.run("delete-storage-file", async () => {
      // Get document to retrieve storage key
      const document = await db.query.documents.findFirst({
        where: and(
          eq(documents.id, data.id as string),
          eq(documents.userId, userId)
        ),
      });

      // All documents use MinIO storage (unified approach)
      if (document?.storageKey) {
        const { storage } = await import("@synap/storage");
        try {
          await storage.delete(document.storageKey);
        } catch (error) {
          console.warn(
            `Failed to delete storage file ${document.storageKey}:`,
            error
          );
        }
      }
    });

    await step.run("delete-document", async () => {
      await docRepo.delete(data.id as string, userId);
      // BaseRepository.emitCompleted() automatically emits "document.delete.completed"
    });
  }

  // Note: Completed events are automatically emitted by BaseRepository
  // when calling repo.create(), repo.update(), or repo.delete()
  // No need to manually emit here

  return { success: true, action };
};

export const documentsExecutor = inngest.createFunction(
  {
    id: "documents-executor",
    name: "Execute Document Operations",
    concurrency: { limit: 10 }, // Lower concurrency for complex operations
  },
  { event: "document.*" },
  documentsHandler
);
