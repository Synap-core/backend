/**
 * Base Indexer
 * Abstract class for all indexers
 */

import type { SearchDocument } from "../types/index.js";

export abstract class BaseIndexer<T = any> {
  abstract collectionName: string;

  /**
   * Convert database record to search document
   */
  abstract toSearchDocument(record: T): Promise<SearchDocument>;

  /**
   * Batch convert multiple records
   */
  async toSearchDocuments(records: T[]): Promise<SearchDocument[]> {
    return Promise.all(records.map((r) => this.toSearchDocument(r)));
  }

  /**
   * Validate document before indexing
   */
  protected validateDocument(doc: SearchDocument): void {
    if (!doc.id) {
      throw new Error("Document must have an id field");
    }
  }

  /**
   * Convert Date to Unix timestamp
   */
  protected toTimestamp(date: Date | string): number {
    return Math.floor(new Date(date).getTime() / 1000);
  }
}
