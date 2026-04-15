/**
 * Import Domain Types
 *
 * Canonical contracts for import sources, lifecycle state, and
 * progress/result payloads across frontend + backend surfaces.
 */

export const IMPORT_SOURCE_VALUES = [
  "csv",
  "json",
  "markdown",
  "bookmarks_html",
  "contacts_device",
  "telegram_archive",
  "linkedin_archive",
  "connector_sync",
  "local_migration",
] as const;

export type ImportSource = (typeof IMPORT_SOURCE_VALUES)[number];

export const IMPORT_LIFECYCLE_VALUES = [
  "queued",
  "parsing",
  "normalizing",
  "merging",
  "writing",
  "completed",
  "failed",
] as const;

export type ImportLifecycleStatus = (typeof IMPORT_LIFECYCLE_VALUES)[number];

export interface ImportProgressSnapshot {
  status: ImportLifecycleStatus;
  totalItems: number;
  processedItems: number;
  createdItems: number;
  updatedItems: number;
  skippedItems: number;
  failedItems: number;
  message?: string;
  updatedAt: string;
}

export interface ImportRunResult {
  runId: string;
  source: ImportSource;
  status: Extract<ImportLifecycleStatus, "completed" | "failed">;
  startedAt: string;
  finishedAt: string;
  summary: Omit<ImportProgressSnapshot, "status" | "message" | "updatedAt">;
  errors: Array<{ path?: string; message: string }>;
}

export interface ImportJobPayload<TPayload = Record<string, unknown>> {
  runId: string;
  source: ImportSource;
  workspaceId: string;
  userId: string;
  payload: TPayload;
}

export interface ImportModelingSuggestion {
  profileSlug: string;
  profileLabel: string;
  confidence: number;
  suggestedProperties: Array<{
    slug: string;
    label: string;
    valueType:
      | "string"
      | "number"
      | "boolean"
      | "date"
      | "entity_id"
      | "array"
      | "object";
    reason?: string;
  }>;
  suggestedViews: Array<{
    type: "table" | "kanban" | "list" | "calendar";
    title: string;
    reason?: string;
  }>;
}
