/**
 * Document Indexer
 */

import { BaseIndexer } from "./base-indexer.js";
import type { SearchDocument } from "../types/index.js";
import { toSearchWorkspaceScope } from "../utils/workspace-scope.js";

interface Document {
  id: string;
  title: string;
  content: string | null;
  userId: string;
  workspaceId: string | null;
  type: string | null;
  projectId: string | null;
  createdAt: Date;
  updatedAt: Date;
  /** The row's metadata: a Library item carries `importItem`. */
  metadata?: unknown;
}

/** The Library marker of a documents row: `{libraryItem, libraryGroupId?}` or nothing. */
export function libraryMarkerOf(
  metadata: unknown
): { libraryItem: true; libraryGroupId?: string } | Record<string, never> {
  const m = metadata as {
    importItem?: unknown;
    importCuration?: { groupIds?: unknown };
  } | null;
  if (!m || typeof m !== "object" || !m.importItem) return {};
  const ids = Array.isArray(m.importCuration?.groupIds)
    ? m.importCuration!.groupIds.filter(
        (g): g is string => typeof g === "string"
      )
    : [];
  return { libraryItem: true, ...(ids[0] ? { libraryGroupId: ids[0] } : {}) };
}

export class DocumentIndexer extends BaseIndexer<Document> {
  collectionName = "documents";

  async toSearchDocument(document: Document): Promise<SearchDocument> {
    const doc: SearchDocument = {
      id: document.id,
      title: document.title,
      content: document.content || undefined,
      userId: document.userId,
      workspaceId: toSearchWorkspaceScope(document.workspaceId),
      documentType: document.type || undefined,
      projectId: document.projectId || undefined,
      ...libraryMarkerOf(document.metadata),
      createdAt: this.toTimestamp(document.createdAt),
      updatedAt: this.toTimestamp(document.updatedAt),
      viewCount: 0,
      lastAccessedAt: undefined,
    };

    this.validateDocument(doc);
    return doc;
  }
}
