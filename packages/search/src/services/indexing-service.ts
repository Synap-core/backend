/**
 * Indexing Service
 * Handles queue management and bulk imports to Typesense
 */

import { getTypesenseAdminClient } from "../client.js";
import {
  getDb,
  inArray,
  loadAllFacetSlugsBatchForTrustedIndexing,
  and,
  eq,
  desc,
  isNull,
} from "@synap/database";
import * as schema from "@synap/database/schema";
import type { IndexingQueueItem } from "../types/index.js";
import {
  EntityIndexer,
  DocumentIndexer,
  ViewIndexer,
  ChannelIndexer,
  AgentIndexer,
  MessageIndexer,
} from "../indexers/index.js";

export class IndexingService {
  private queue: Map<string, IndexingQueueItem[]> = new Map();

  private indexers = {
    entities: new EntityIndexer(),
    documents: new DocumentIndexer(),
    views: new ViewIndexer(),
    channels: new ChannelIndexer(),
    agents: new AgentIndexer(),
    messages: new MessageIndexer(),
  };

  /**
   * Add item to indexing queue
   */
  async queueIndexing(item: IndexingQueueItem): Promise<void> {
    const key = item.collection;
    if (!this.queue.has(key)) {
      this.queue.set(key, []);
    }
    this.queue.get(key)!.push(item);

    // Auto-flush if queue gets too large
    const totalSize = Array.from(this.queue.values()).reduce(
      (sum, items) => sum + items.length,
      0
    );
    if (totalSize > 1000) {
      console.warn("Queue size exceeded 1000, auto-flushing...");
      await this.flushQueue();
    }
  }

  /**
   * Flush queue and perform bulk import
   * Called by scheduled Inngest function every 10 seconds
   */
  async flushQueue(): Promise<Record<string, any>> {
    const client = getTypesenseAdminClient();
    const results: Record<string, any> = {};

    for (const [collection, items] of this.queue.entries()) {
      if (items.length === 0) continue;

      try {
        // Separate upserts and deletes
        const upserts = items.filter((i) => i.operation === "upsert");
        const deletes = items.filter((i) => i.operation === "delete");

        // Perform bulk upsert
        if (upserts.length > 0) {
          const indexer =
            this.indexers[collection as keyof typeof this.indexers];
          if (!indexer) {
            console.error(`No indexer found for collection: ${collection}`);
            continue;
          }

          const documents = await this.fetchDocuments(
            collection,
            upserts.map((i) => i.documentId)
          );
          const searchDocs = await indexer.toSearchDocuments(documents);

          const importResult = await client
            .collections(collection)
            .documents()
            .import(searchDocs, { action: "upsert" });

          const successCount = importResult.filter(
            (r: any) => r.success
          ).length;
          const failedCount = importResult.filter(
            (r: any) => !r.success
          ).length;

          results[collection] = {
            upserted: successCount,
            failed: failedCount,
          };

          if (failedCount > 0) {
            console.error(
              `Failed to index ${failedCount} documents in ${collection}`
            );
          }
        }

        // Perform bulk delete
        if (deletes.length > 0) {
          const deleteIds = deletes.map((d) => d.documentId);

          // Delete one by one (Typesense doesn't have bulk delete by ID)
          let deletedCount = 0;
          for (const id of deleteIds) {
            try {
              await client.collections(collection).documents(id).delete();
              deletedCount++;
            } catch (error) {
              // Document might not exist, ignore
              console.warn(
                `Failed to delete document ${id} from ${collection}:`,
                error
              );
            }
          }

          results[collection] = {
            ...results[collection],
            deleted: deletedCount,
          };
        }

        // Clear queue for this collection
        this.queue.set(collection, []);
      } catch (error) {
        console.error(`Error flushing queue for ${collection}:`, error);
        results[collection] = {
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    }

    return results;
  }

  /**
   * Fetch documents from database
   */
  private async fetchDocuments(
    collection: string,
    ids: string[]
  ): Promise<any[]> {
    const db = await getDb();

    switch (collection) {
      case "entities": {
        const entityRows = await db.query.entities.findMany({
          where: inArray(schema.entities.id, ids),
        });
        const withFacets = await this.attachFacetSlugs(db, entityRows);
        // Fold the linked document body into `content` so an entity is
        // keyword-searchable by its attached document's text — the search
        // counterpart of the entity-embedding wire-cut. The entities table has
        // NO `content` column; the body lives in document_versions via
        // entities.documentId. Without this, entity-indexer's `entity.content`
        // read is always undefined.
        const docIds = withFacets
          .map((e) => e.documentId as string | null)
          .filter((d): d is string => !!d);
        const contentByDoc = await this.loadLatestVersionContent(db, docIds);
        for (const e of withFacets) {
          const docId = e.documentId as string | null;
          if (docId && contentByDoc.has(docId)) {
            e.content = contentByDoc.get(docId);
          }
        }
        return withFacets;
      }

      case "documents": {
        const docRows = await db.query.documents.findMany({
          where: inArray(schema.documents.id, ids),
        });
        // The documents table has NO `content` column (body text lives in
        // document_versions). Enrich each row with its latest version's content
        // so DocumentIndexer indexes real body text, not undefined.
        const contentByDoc = await this.loadLatestVersionContent(
          db,
          docRows.map((d) => d.id)
        );
        return docRows.map((d) => ({
          ...d,
          content: contentByDoc.get(d.id) ?? null,
        }));
      }

      case "views":
        return db.query.views.findMany({
          where: inArray(schema.views.id, ids),
        });

      case "channels":
        return db.query.channels.findMany({
          where: inArray(schema.channels.id, ids),
        });

      case "agents":
        return db.query.agents.findMany({
          where: inArray(schema.agents.id, ids),
        });

      case "messages":
        return this.fetchMessageRows(db, ids);

      default:
        throw new Error(`Unknown collection: ${collection}`);
    }
  }

  /**
   * Fetch message rows joined with their channel's workspaceId for indexing.
   *
   * Two hard exclusions are applied at the source so they never reach Typesense:
   *   - soft-deleted messages (`deletedAt IS NOT NULL`)
   *   - ephemeral recap messages (`ephemeral = true`) — live-only, must NEVER be
   *     indexed or searchable.
   *
   * When `ids` is omitted, ALL live/non-ephemeral messages are returned (full
   * reindex). The `channels` INNER JOIN supplies `workspaceId` (absent from the
   * `messages` table).
   */
  private async fetchMessageRows(
    db: Awaited<ReturnType<typeof getDb>>,
    ids?: string[]
  ): Promise<any[]> {
    const conditions = [
      isNull(schema.messages.deletedAt),
      eq(schema.messages.ephemeral, false),
    ];
    if (ids) {
      conditions.push(inArray(schema.messages.id, ids));
    }

    return db
      .select({
        id: schema.messages.id,
        channelId: schema.messages.channelId,
        userId: schema.messages.userId,
        content: schema.messages.content,
        role: schema.messages.role,
        timestamp: schema.messages.timestamp,
        editedAt: schema.messages.editedAt,
        workspaceId: schema.channels.workspaceId,
      })
      .from(schema.messages)
      .innerJoin(
        schema.channels,
        eq(schema.channels.id, schema.messages.channelId)
      )
      .where(and(...conditions));
  }

  /**
   * Immediately index a single item without queuing.
   *
   * Used by the per-item search-index job handler so newly created/updated
   * entities, documents, and views appear in Typesense within seconds rather
   * than waiting for the 30-minute bulk flush cron.
   */
  async indexNow(item: IndexingQueueItem): Promise<void> {
    const client = getTypesenseAdminClient();

    if (item.operation === "delete") {
      try {
        await client
          .collections(item.collection)
          .documents(item.documentId)
          .delete();
      } catch {
        // Document may not exist in Typesense — not an error
      }
      return;
    }

    const indexer =
      this.indexers[item.collection as keyof typeof this.indexers];
    if (!indexer) {
      console.error(`[indexNow] No indexer for collection: ${item.collection}`);
      return;
    }

    const records = await this.fetchDocuments(item.collection, [
      item.documentId,
    ]);
    if (records.length === 0) {
      // Record was deleted before indexing — remove from Typesense if present
      try {
        await client
          .collections(item.collection)
          .documents(item.documentId)
          .delete();
      } catch {
        // Not found — fine
      }
      return;
    }

    const searchDocs = await indexer.toSearchDocuments(records);
    if (searchDocs.length === 0) return;

    await client
      .collections(item.collection)
      .documents()
      .import(searchDocs, { action: "upsert" });
  }

  /**
   * Full reindex: fetch all live records from DB, upsert into Typesense,
   * then delete Typesense docs that no longer exist in DB.
   *
   * Called by the `search-reindex` pg-boss job (admin-triggered or startup).
   * Safe to run at any time — uses upsert so no data is lost on partial runs.
   */
  async fullReindex(
    collections?: string[]
  ): Promise<
    Record<string, { upserted: number; deleted: number; error?: string }>
  > {
    const client = getTypesenseAdminClient();
    const db = await getDb();
    const targetCollections = collections ?? Object.keys(this.indexers);
    const results: Record<
      string,
      { upserted: number; deleted: number; error?: string }
    > = {};

    for (const collection of targetCollections) {
      const indexer = this.indexers[collection as keyof typeof this.indexers];
      if (!indexer) continue;

      try {
        // 1. Fetch all live records from DB
        let dbRecords: any[] = [];
        switch (collection) {
          case "entities":
            dbRecords = await this.attachFacetSlugs(
              db,
              await db.query.entities.findMany({
                where: (e, { isNull }) => isNull(e.deletedAt),
              })
            );
            break;
          case "documents":
            dbRecords = await db.query.documents.findMany({
              where: (d, { isNull }) => isNull(d.deletedAt),
            });
            break;
          case "views":
            dbRecords = await db.query.views.findMany();
            break;
          case "channels":
            dbRecords = await db.query.channels.findMany();
            break;
          case "agents":
            dbRecords = await db.query.agents.findMany();
            break;
          case "messages":
            dbRecords = await this.fetchMessageRows(db);
            break;
          default:
            continue;
        }

        // 2. Convert and upsert into Typesense
        const searchDocs = await indexer.toSearchDocuments(dbRecords);
        let upserted = 0;
        if (searchDocs.length > 0) {
          const importResult = await client
            .collections(collection)
            .documents()
            .import(searchDocs, { action: "upsert" });
          upserted = importResult.filter((r: any) => r.success).length;
          const failed = importResult.filter((r: any) => !r.success).length;
          if (failed > 0) {
            console.error(
              `[fullReindex] ${failed} docs failed in ${collection}`
            );
          }
        }

        // 3. Delete Typesense docs that no longer exist in DB
        // Use the export endpoint to stream all document IDs from Typesense
        const liveIds = new Set(dbRecords.map((r: any) => r.id));
        let deleted = 0;
        try {
          const exported = await client
            .collections(collection)
            .documents()
            .export({ include_fields: "id" } as any);
          const lines = (exported as string).split("\n").filter(Boolean);
          for (const line of lines) {
            try {
              const doc = JSON.parse(line);
              if (doc.id && !liveIds.has(doc.id)) {
                try {
                  await client
                    .collections(collection)
                    .documents(doc.id)
                    .delete();
                  deleted++;
                } catch {
                  // already gone
                }
              }
            } catch {
              // malformed line — skip
            }
          }
        } catch {
          // export may fail for empty collections — fine
        }

        results[collection] = { upserted, deleted };
        console.log(
          `[fullReindex] ${collection}: upserted=${upserted}, deleted=${deleted}`
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[fullReindex] Error in collection ${collection}:`, err);
        results[collection] = { upserted: 0, deleted: 0, error: msg };
      }
    }

    return results;
  }

  /**
   * Batch-attach live facet (role-profile) slugs to entity rows for indexing.
   * Uses the explicitly trusted unfiltered wrapper. Search documents are
   * per-entity; user visibility is enforced by the query path.
   */
  private async attachFacetSlugs(
    db: Awaited<ReturnType<typeof getDb>>,
    entityRows: any[]
  ): Promise<any[]> {
    if (entityRows.length === 0) return entityRows;

    const slugsByEntity = await loadAllFacetSlugsBatchForTrustedIndexing(
      db,
      entityRows.map((e) => e.id)
    );

    return entityRows.map((e) => ({
      ...e,
      facetSlugs: slugsByEntity.get(e.id) ?? [],
    }));
  }

  /**
   * Batch-load each document's LATEST version body text (the `documents` table
   * has no `content` column — it lives in `document_versions`). Returns a map
   * documentId → content. `DISTINCT ON (document_id) … ORDER BY version DESC`
   * loads only the newest version per document (not every version's blob).
   */
  private async loadLatestVersionContent(
    db: Awaited<ReturnType<typeof getDb>>,
    documentIds: string[]
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (documentIds.length === 0) return out;
    const rows = await db
      .selectDistinctOn([schema.documentVersions.documentId], {
        documentId: schema.documentVersions.documentId,
        content: schema.documentVersions.content,
      })
      .from(schema.documentVersions)
      .where(inArray(schema.documentVersions.documentId, documentIds))
      .orderBy(
        schema.documentVersions.documentId,
        desc(schema.documentVersions.version)
      );
    for (const r of rows) {
      if (r.content) out.set(r.documentId, r.content);
    }
    return out;
  }

  /**
   * Get queue status
   */
  getQueueStatus(): Record<string, number> {
    const status: Record<string, number> = {};
    for (const [collection, items] of this.queue.entries()) {
      status[collection] = items.length;
    }
    return status;
  }
}

export const indexingService = new IndexingService();
