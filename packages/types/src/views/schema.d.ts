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
    scopeProfileIds: string[] | null;
    scopeMode: "explicit" | "observed" | null;
    query: Record<string, unknown>;
    config: Record<string, unknown>;
    schemaSnapshot: Record<string, unknown> | null;
    snapshotUpdatedAt: Date | null;
    embeddedViewIds: string[] | null;
    documentId: string | null;
    yjsRoomId: string | null;
    thumbnailUrl: string | null;
    metadata: Record<string, unknown>;
    createdAt: Date;
    updatedAt: Date;
}
export type NewView = Omit<View, "id" | "createdAt" | "updatedAt"> & {
    id?: string;
    createdAt?: Date;
    updatedAt?: Date;
};
//# sourceMappingURL=schema.d.ts.map