/**
 * Document Snapshots Workers
 * Handles document version snapshots and restoration
 */

import { inngest } from '../client.js';
import { db, eq } from '@synap/database';
import { documents, documentVersions } from '@synap/database/schema';
import { storage } from '@synap/storage';
import { broadcastSuccess } from '../utils/realtime-broadcast.js';

/**
 * Document Snapshot Worker
 * Triggered by: documents.snapshot.requested
 * Purpose: Save current document state as a version snapshot
 */
export const documentSnapshotWorker = inngest.createFunction(
  {
    id: 'document-snapshots',
    name: 'Save Document Version Snapshot',
  },
  { event: 'documents.snapshot.requested' },
  async ({ event, step }) => {
    const { documentId, message, userId } = event.data;

    // 1. Fetch document metadata
    const document = await step.run('get-document', async () => {
      const doc = await db.query.documents.findFirst({
        where: eq(documents.id, documentId),
      });

      if (!doc) {
        throw new Error(`Document ${documentId} not found`);
      }

      return doc;
    });

    // 2. Fetch current content from storage
    const content = await step.run('fetch-content', async () => {
      const buffer = await storage.downloadBuffer(document.storageKey);
      return buffer.toString('utf-8');
    });

    // 3. Create version snapshot
    const newVersion = (document.currentVersion || 0) + 1;

    const version = await step.run('save-version', async () => {
      const [v] = await db.insert(documentVersions).values({
        documentId,
        version: newVersion,
        content,
        message: message || `Version ${newVersion}`,
        author: 'user',
        authorId: userId,
      }).returning();

      return v;
    });

    // 4. Update document version metadata (The +1 Logic)
    // - lastSavedVersion = newVersion (marking this snapshot as the latest save)
    // - currentVersion = newVersion + 1 (starting the new "working" version)
    await step.run('update-document-version', async () => {
      await db.update(documents)
        .set({
          lastSavedVersion: newVersion,
          currentVersion: newVersion + 1,
          updatedAt: new Date(),
        })
        .where(eq(documents.id, documentId));
    });

    // 5. Broadcast success
    await step.run('broadcast', async () => {
      await broadcastSuccess(userId, 'document.snapshot.saved', {
        documentId,
        versionId: version.id,
        version: newVersion,
        message: version.message,
      });
    });

    return {
      success: true,
      versionId: version.id,
      version: newVersion,
    };
  }
);

/**
 * Document Restore Worker
 * Triggered by: documents.restore.requested
 * Purpose: Restore document to a previous version
 */
export const documentRestoreWorker = inngest.createFunction(
  {
    id: 'document-restore',
    name: 'Restore Document to Previous Version',
  },
  { event: 'documents.restore.requested' },
  async ({ event, step }) => {
    const { documentId, versionId, userId } = event.data;

    // 1. Get target version
    const version = await step.run('get-version', async () => {
      const v = await db.query.documentVersions.findFirst({
        where: eq(documentVersions.id, versionId),
      });

      if (!v) {
        throw new Error(`Version ${versionId} not found`);
      }

      if (v.documentId !== documentId) {
        throw new Error('Version does not belong to this document');
      }

      return v;
    });

    // 2. Get document metadata
    const document = await step.run('get-document', async () => {
      const doc = await db.query.documents.findFirst({
        where: eq(documents.id, documentId),
      });

      if (!doc) {
        throw new Error(`Document ${documentId} not found`);
      }

      return doc;
    });

    // 3. Upload restored content to storage
    await step.run('restore-storage', async () => {
      await storage.upload(
        document.storageKey,
        Buffer.from(version.content, 'utf-8'),
        { contentType: document.mimeType || 'text/plain' }
      );
    });

    // 4. Create new version marking the restoration
    // We treat the restore itself as a new state.
    // Basically: Content is reverted to vOld.
    // The "Working Version" resumes from there.
    // So currentVersion is purely incremental (doesn't jump back).
    const newVersion = (document.currentVersion || 0) + 1;

    await step.run('create-restore-record', async () => {
      // Optional: Log the restore event in versions history if desired, 
      // but purely we just need to reset the state.
      // Ideally we might want a snapshot of "just before restore" if proper safety is needed.
      
      await db.update(documents)
        .set({
          // Reset working state to the restored content (done via storage upload above)
          // We mark the document as "dirty" starting from this restored point
          currentVersion: newVersion,
          // lastSavedVersion remains at whatever it was (or we could say this restore is unsaved changes)
          // Ideally, a restore is an "unsaved change" on top of the old version.
          // BUT - simplest model: Restore puts you in a fresh "Working" state.
          updatedAt: new Date(),
        })
        .where(eq(documents.id, documentId));
    });

    // 5. Broadcast success
    await step.run('broadcast', async () => {
      await broadcastSuccess(userId, 'document.restored', {
        documentId,
        restoredFromVersion: version.version,
        currentVersion: newVersion,
      });
    });

    return {
      success: true,
      restoredFromVersion: version.version,
      currentVersion: newVersion,
    };
  }
);

/**
 * Document Auto-Save Worker (Cron)
 * Triggered by: Cron schedule (every 30 minutes)
 * Purpose: Auto-save snapshots for active documents
 */
export const documentAutoSaveWorker = inngest.createFunction(
  {
    id: 'document-auto-save',
    name: 'Auto-save Document Snapshots',
  },
  { cron: '*/30 * * * *' }, // Every 30 minutes
  async ({ step }) => {
    // Get active document sessions (documents being actively edited)
    const activeSessions = await step.run('get-active-sessions', async () => {
      const { documentSessions } = await import('@synap/database/schema');
      
      return db.query.documentSessions.findMany({
        where: eq(documentSessions.isActive, true),
        limit: 100,
      });
    });

    if (activeSessions.length === 0) {
      return { message: 'No active sessions to auto-save' };
    }

    // For each active session, create a snapshot
    const results = await Promise.all(
      activeSessions.map(async (session) => {
        try {
          const document = await db.query.documents.findFirst({
            where: eq(documents.id, session.documentId),
          });

          if (!document) return { documentId: session.documentId, error: 'Document not found' };

          const content = await storage.downloadBuffer(document.storageKey);
          const newVersion = (document.currentVersion || 0) + 1;

          await db.insert(documentVersions).values({
            documentId: session.documentId,
            version: newVersion,
            content: content.toString('utf-8'),
            message: 'Auto-save checkpoint',
            author: 'system',
            authorId: 'auto-save',
          });

          await db.update(documents)
            .set({ currentVersion: newVersion })
            .where(eq(documents.id, session.documentId));

          return { documentId: session.documentId, version: newVersion, success: true };
        } catch (error) {
          return { 
            documentId: session.documentId, 
            error: error instanceof Error ? error.message : 'Unknown error' 
          };
        }
      })
    );

    return {
      totalSessions: activeSessions.length,
      results,
    };
  }
);
