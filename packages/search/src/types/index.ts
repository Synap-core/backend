/**
 * Search Document Types
 */

export interface SearchDocument {
  id: string;
  [key: string]: any;
}

export interface IndexingQueueItem {
  collection: string;
  operation: "upsert" | "delete";
  documentId: string;
  timestamp: number;
}

export interface SearchResult {
  id: string;
  collection: string;
  document: any;
  highlights?: any;
  textMatch: number;
}
