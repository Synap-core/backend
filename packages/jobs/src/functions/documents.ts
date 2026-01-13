/**
 * Documents Worker - Generic Document Handler
 *
 * Handles document lifecycle events:
 * - documents.create.validated (Executor)
 * - documents.update.validated (Executor)
 *
 * Documents have versioning and are stored as files.
 */

import { inngest } from "../client.js";
import { storage } from "@synap/storage";
import { documents, documentVersions } from "@synap/database";
import { createLogger } from "@synap-core/core";
import { randomUUID } from "crypto";

const logger = createLogger({ module: "documents-worker" });

// ============================================================================
// TYPES
// ============================================================================

interface DocumentsCreateRequestedData {
  title: string;
  type: "text" | "markdown" | "code" | "pdf" | "docx";
  content?: string;
  file?: {
    content: string;
    filename: string;
    contentType: string;
    source: "text-input" | "file-upload" | "ai-generated";
  };
  language?: string;
  projectId?: string;
  metadata?: Record<string, unknown>;
  requestId?: string;
}

// ============================================================================
// WORKER
// ============================================================================

export const documentsWorker = inngest.createFunction(
  {
    id: "documents-handler",
    name: "Documents Handler",
    retries: 3,
  },
  [
    { event: "documents.create.validated" },
    { event: "documents.update.validated" },
  ],
  async ({ event, step }) => {
    const eventName = event.name as string;
    // Extract action from "documents.{action}.validated"
    const action = eventName.split(".")[1] as "create" | "update";
    const userId = event.user?.id as string;

    if (!userId) {
      throw new Error("userId is required for documents operations");
    }

    logger.info(
      { eventName, action, userId },
      "Processing documents event (Executor)",
    );

    // ========================================================================
    // CREATE (Executed after Validation)
    // ========================================================================
    if (action === "create") {
      const data = event.data as DocumentsCreateRequestedData;
      // Use the requestId from the validator/proposal if available, else new ID
      const documentId = data.requestId || randomUUID();

      // Step 1: Upload content to storage
      // Note: In the future, content might already be in S3 (contentRef),
      // but we handle legacy "Raw Content" here for now.
      const fileInfo = await step.run("upload-document", async () => {
        const content = data.file?.content || data.content || "";
        const isBase64 = data.file?.source === "file-upload";
        const buffer = isBase64
          ? Buffer.from(content, "base64")
          : Buffer.from(content, "utf-8");

        const ext =
          data.file?.filename?.split(".").pop() ||
          (data.type === "markdown" ? "md" : data.type);
        const storagePath = `documents/${userId}/${documentId}.${ext}`;

        const result = await storage.upload(storagePath, buffer, {
          contentType: data.file?.contentType || "text/plain",
        });

        logger.debug({ storagePath, size: buffer.length }, "Uploaded document");

        return {
          url: result.url,
          path: result.path,
          size: buffer.length,
          mimeType: data.file?.contentType || "text/plain",
        };
      });

      // Step 2: Insert document record (Live Data)
      await step.run("insert-document", async () => {
        const { getDb } = await import("@synap/database");
        const db = await getDb();

        await db.insert(documents).values({
          id: documentId,
          userId,
          title: data.title,
          type: data.type,
          language: data.language,
          storageUrl: fileInfo.url,
          storageKey: fileInfo.path,
          size: fileInfo.size,
          mimeType: fileInfo.mimeType,
          projectId: data.projectId,
          metadata: data.metadata,
          currentVersion: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
        } as any);

        logger.debug({ documentId }, "Inserted document");
      });

      // Step 3: Create initial version (Snapshot)
      await step.run("create-initial-version", async () => {
        const { getDb } = await import("@synap/database");
        const db = await getDb();

        const content = data.file?.content || data.content || "";
        const textContent =
          data.file?.source === "file-upload"
            ? Buffer.from(content, "base64").toString("utf-8")
            : content;

        await db.insert(documentVersions).values({
          id: randomUUID(),
          documentId,
          version: 1,
          content: textContent,
          author: "user",
          authorId: userId,
          message: "Initial version",
          createdAt: new Date(),
        } as any);

        logger.debug({ documentId }, "Created initial document version");
      });

      // Step 4: Emit completion (Signal to UI)
      await step.run("emit-completion", async () => {
        await inngest.send({
          name: "documents.create.completed",
          data: {
            documentId,
            title: data.title,
            storageUrl: fileInfo.url,
            storageKey: fileInfo.path,
            size: fileInfo.size,
            currentVersion: 1,
          },
          user: { id: userId },
        });

        logger.info({ documentId }, "Published documents.create.completed");
      });

      return {
        success: true,
        action: "create",
        documentId,
      };
    }

    // ========================================================================
    // UPDATE (Create new version)
    // ========================================================================
    if (action === "update") {
      const { documentId, content, message } = event.data as {
        documentId: string;
        content: string;
        message?: string;
      };

      // Step 1: Get current version
      const currentVersion = await step.run("get-current-version", async () => {
        const {
          getDb,
          documents: docsTable,
          eq,
        } = await import("@synap/database");
        const db = await getDb();

        const [doc] = await db
          .select({ currentVersion: docsTable.currentVersion })
          .from(docsTable)
          .where(eq(docsTable.id, documentId))
          .limit(1);

        return doc?.currentVersion || 0;
      });

      const newVersion = currentVersion + 1;

      // Step 2: Update storage
      await step.run("update-storage", async () => {
        const {
          getDb,
          documents: docsTable,
          eq,
        } = await import("@synap/database");
        const db = await getDb();

        const [doc] = await db
          .select({ storageKey: docsTable.storageKey })
          .from(docsTable)
          .where(eq(docsTable.id, documentId))
          .limit(1);

        if (doc?.storageKey) {
          await storage.upload(doc.storageKey, Buffer.from(content, "utf-8"), {
            contentType: "text/plain",
          });
        }
      });

      // Step 3: Create new version record
      await step.run("create-version", async () => {
        const { getDb } = await import("@synap/database");
        const db = await getDb();

        await db.insert(documentVersions).values({
          id: randomUUID(),
          documentId,
          version: newVersion,
          content,
          author: "user",
          authorId: userId,
          message: message || `Version ${newVersion}`,
          createdAt: new Date(),
        } as any);
      });

      // Step 4: Update document record
      await step.run("update-document", async () => {
        const {
          getDb,
          documents: docsTable,
          eq,
          and,
        } = await import("@synap/database");
        const db = await getDb();

        await db
          .update(docsTable)
          .set({
            currentVersion: newVersion,
            size: Buffer.byteLength(content, "utf-8"),
            updatedAt: new Date(),
          } as any)
          .where(
            and(eq(docsTable.id, documentId), eq(docsTable.userId, userId)),
          );
      });

      // Step 5: Emit completion
      await step.run("emit-update-completion", async () => {
        await inngest.send({
          name: "documents.update.completed",
          data: {
            documentId,
            version: newVersion,
          },
          user: { id: userId },
        });
      });

      return {
        success: true,
        action: "update",
        documentId,
        version: newVersion,
      };
    }

    throw new Error(`Unknown action: ${action}`);
  },
);
