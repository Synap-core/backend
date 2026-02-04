/**
 * Pure View Types
 *
 * Decoupled from Drizzle schema to allow usage in frontend bundles
 * without pulling in database dependencies.
 */

export interface View {
  id: string;
  workspaceId: string | null;
  userId: string;
  type: string;
  category: string;
  name: string;
  description: string | null;

  // NEW: Scope profiles (declared schema scope for structured views)
  scopeProfileIds: string[] | null;
  scopeMode: "explicit" | "observed" | null;

  // NEW: Consolidated query structure
  query: Record<string, unknown>; // EntityQuery: { filters, sorts, search, limit, offset, groupBy }

  // NEW: Render config (overrides only)
  config: Record<string, unknown>; // { hiddenColumns, visibleColumns, columnOrder, columnWidths, ... }

  // Optional: Schema snapshot cache (performance optimization)
  schemaSnapshot: Record<string, unknown> | null;
  snapshotUpdatedAt: Date | null;

  // Content references
  documentId: string | null;

  // Real-time
  yjsRoomId: string | null;
  thumbnailUrl: string | null;

  // Metadata (for entity orders, etc.)
  metadata: Record<string, unknown>;

  // Timestamps
  createdAt: Date;
  updatedAt: Date;
}

export type NewView = Omit<View, "id" | "createdAt" | "updatedAt"> & {
  id?: string;
  createdAt?: Date;
  updatedAt?: Date;
};
