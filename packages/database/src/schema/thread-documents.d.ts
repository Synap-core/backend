/**
 * Thread Documents Schema
 *
 * Tracks which documents are used/updated/referenced by chat threads.
 * Enables context inheritance in Git-like branching system.
 */
/**
 * Thread Document Relationship Types
 *
 * How a document relates to a thread.
 */
export declare enum ThreadDocumentRelationshipType {
  USED_AS_CONTEXT = "used_as_context",
  CREATED = "created",
  UPDATED = "updated",
  REFERENCED = "referenced",
  INHERITED_FROM_PARENT = "inherited_from_parent",
}
/**
 * Thread Document Conflict Status
 */
export declare enum ThreadDocumentConflictStatus {
  NONE = "none",
  PENDING = "pending",
  RESOLVED = "resolved",
}
export declare const threadDocuments: import("drizzle-orm/pg-core").PgTableWithColumns<{
  name: "thread_documents";
  schema: undefined;
  columns: {
    id: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "id";
        tableName: "thread_documents";
        dataType: "string";
        columnType: "PgUUID";
        data: string;
        driverParam: string;
        notNull: true;
        hasDefault: true;
        isPrimaryKey: true;
        isAutoincrement: false;
        hasRuntimeDefault: false;
        enumValues: undefined;
        baseColumn: never;
        identity: undefined;
        generated: undefined;
      },
      {},
      {}
    >;
    threadId: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "thread_id";
        tableName: "thread_documents";
        dataType: "string";
        columnType: "PgUUID";
        data: string;
        driverParam: string;
        notNull: true;
        hasDefault: false;
        isPrimaryKey: false;
        isAutoincrement: false;
        hasRuntimeDefault: false;
        enumValues: undefined;
        baseColumn: never;
        identity: undefined;
        generated: undefined;
      },
      {},
      {}
    >;
    documentId: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "document_id";
        tableName: "thread_documents";
        dataType: "string";
        columnType: "PgUUID";
        data: string;
        driverParam: string;
        notNull: true;
        hasDefault: false;
        isPrimaryKey: false;
        isAutoincrement: false;
        hasRuntimeDefault: false;
        enumValues: undefined;
        baseColumn: never;
        identity: undefined;
        generated: undefined;
      },
      {},
      {}
    >;
    relationshipType: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "relationship_type";
        tableName: "thread_documents";
        dataType: "string";
        columnType: "PgText";
        data: ThreadDocumentRelationshipType;
        driverParam: string;
        notNull: true;
        hasDefault: false;
        isPrimaryKey: false;
        isAutoincrement: false;
        hasRuntimeDefault: false;
        enumValues: [
          ThreadDocumentRelationshipType.USED_AS_CONTEXT,
          ThreadDocumentRelationshipType.CREATED,
          ThreadDocumentRelationshipType.UPDATED,
          ThreadDocumentRelationshipType.REFERENCED,
          ThreadDocumentRelationshipType.INHERITED_FROM_PARENT,
        ];
        baseColumn: never;
        identity: undefined;
        generated: undefined;
      },
      {},
      {}
    >;
    conflictStatus: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "conflict_status";
        tableName: "thread_documents";
        dataType: "string";
        columnType: "PgText";
        data: ThreadDocumentConflictStatus;
        driverParam: string;
        notNull: true;
        hasDefault: true;
        isPrimaryKey: false;
        isAutoincrement: false;
        hasRuntimeDefault: false;
        enumValues: [
          ThreadDocumentConflictStatus.NONE,
          ThreadDocumentConflictStatus.PENDING,
          ThreadDocumentConflictStatus.RESOLVED,
        ];
        baseColumn: never;
        identity: undefined;
        generated: undefined;
      },
      {},
      {}
    >;
    sourceMessageId: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "source_message_id";
        tableName: "thread_documents";
        dataType: "string";
        columnType: "PgUUID";
        data: string;
        driverParam: string;
        notNull: false;
        hasDefault: false;
        isPrimaryKey: false;
        isAutoincrement: false;
        hasRuntimeDefault: false;
        enumValues: undefined;
        baseColumn: never;
        identity: undefined;
        generated: undefined;
      },
      {},
      {}
    >;
    sourceEventId: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "source_event_id";
        tableName: "thread_documents";
        dataType: "string";
        columnType: "PgUUID";
        data: string;
        driverParam: string;
        notNull: false;
        hasDefault: false;
        isPrimaryKey: false;
        isAutoincrement: false;
        hasRuntimeDefault: false;
        enumValues: undefined;
        baseColumn: never;
        identity: undefined;
        generated: undefined;
      },
      {},
      {}
    >;
    userId: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "user_id";
        tableName: "thread_documents";
        dataType: "string";
        columnType: "PgText";
        data: string;
        driverParam: string;
        notNull: true;
        hasDefault: false;
        isPrimaryKey: false;
        isAutoincrement: false;
        hasRuntimeDefault: false;
        enumValues: [string, ...string[]];
        baseColumn: never;
        identity: undefined;
        generated: undefined;
      },
      {},
      {}
    >;
    workspaceId: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "workspace_id";
        tableName: "thread_documents";
        dataType: "string";
        columnType: "PgUUID";
        data: string;
        driverParam: string;
        notNull: true;
        hasDefault: false;
        isPrimaryKey: false;
        isAutoincrement: false;
        hasRuntimeDefault: false;
        enumValues: undefined;
        baseColumn: never;
        identity: undefined;
        generated: undefined;
      },
      {},
      {}
    >;
    createdAt: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "created_at";
        tableName: "thread_documents";
        dataType: "date";
        columnType: "PgTimestamp";
        data: Date;
        driverParam: string;
        notNull: true;
        hasDefault: true;
        isPrimaryKey: false;
        isAutoincrement: false;
        hasRuntimeDefault: false;
        enumValues: undefined;
        baseColumn: never;
        identity: undefined;
        generated: undefined;
      },
      {},
      {}
    >;
  };
  dialect: "pg";
}>;
export type ThreadDocument = typeof threadDocuments.$inferSelect;
export type NewThreadDocument = typeof threadDocuments.$inferInsert;
/**
 * @internal For monorepo usage - enables schema composition in API layer
 */
export declare const insertThreadDocumentSchema: import("drizzle-zod").BuildSchema<
  "insert",
  {
    id: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "id";
        tableName: "thread_documents";
        dataType: "string";
        columnType: "PgUUID";
        data: string;
        driverParam: string;
        notNull: true;
        hasDefault: true;
        isPrimaryKey: true;
        isAutoincrement: false;
        hasRuntimeDefault: false;
        enumValues: undefined;
        baseColumn: never;
        identity: undefined;
        generated: undefined;
      },
      {},
      {}
    >;
    threadId: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "thread_id";
        tableName: "thread_documents";
        dataType: "string";
        columnType: "PgUUID";
        data: string;
        driverParam: string;
        notNull: true;
        hasDefault: false;
        isPrimaryKey: false;
        isAutoincrement: false;
        hasRuntimeDefault: false;
        enumValues: undefined;
        baseColumn: never;
        identity: undefined;
        generated: undefined;
      },
      {},
      {}
    >;
    documentId: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "document_id";
        tableName: "thread_documents";
        dataType: "string";
        columnType: "PgUUID";
        data: string;
        driverParam: string;
        notNull: true;
        hasDefault: false;
        isPrimaryKey: false;
        isAutoincrement: false;
        hasRuntimeDefault: false;
        enumValues: undefined;
        baseColumn: never;
        identity: undefined;
        generated: undefined;
      },
      {},
      {}
    >;
    relationshipType: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "relationship_type";
        tableName: "thread_documents";
        dataType: "string";
        columnType: "PgText";
        data: ThreadDocumentRelationshipType;
        driverParam: string;
        notNull: true;
        hasDefault: false;
        isPrimaryKey: false;
        isAutoincrement: false;
        hasRuntimeDefault: false;
        enumValues: [
          ThreadDocumentRelationshipType.USED_AS_CONTEXT,
          ThreadDocumentRelationshipType.CREATED,
          ThreadDocumentRelationshipType.UPDATED,
          ThreadDocumentRelationshipType.REFERENCED,
          ThreadDocumentRelationshipType.INHERITED_FROM_PARENT,
        ];
        baseColumn: never;
        identity: undefined;
        generated: undefined;
      },
      {},
      {}
    >;
    conflictStatus: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "conflict_status";
        tableName: "thread_documents";
        dataType: "string";
        columnType: "PgText";
        data: ThreadDocumentConflictStatus;
        driverParam: string;
        notNull: true;
        hasDefault: true;
        isPrimaryKey: false;
        isAutoincrement: false;
        hasRuntimeDefault: false;
        enumValues: [
          ThreadDocumentConflictStatus.NONE,
          ThreadDocumentConflictStatus.PENDING,
          ThreadDocumentConflictStatus.RESOLVED,
        ];
        baseColumn: never;
        identity: undefined;
        generated: undefined;
      },
      {},
      {}
    >;
    sourceMessageId: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "source_message_id";
        tableName: "thread_documents";
        dataType: "string";
        columnType: "PgUUID";
        data: string;
        driverParam: string;
        notNull: false;
        hasDefault: false;
        isPrimaryKey: false;
        isAutoincrement: false;
        hasRuntimeDefault: false;
        enumValues: undefined;
        baseColumn: never;
        identity: undefined;
        generated: undefined;
      },
      {},
      {}
    >;
    sourceEventId: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "source_event_id";
        tableName: "thread_documents";
        dataType: "string";
        columnType: "PgUUID";
        data: string;
        driverParam: string;
        notNull: false;
        hasDefault: false;
        isPrimaryKey: false;
        isAutoincrement: false;
        hasRuntimeDefault: false;
        enumValues: undefined;
        baseColumn: never;
        identity: undefined;
        generated: undefined;
      },
      {},
      {}
    >;
    userId: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "user_id";
        tableName: "thread_documents";
        dataType: "string";
        columnType: "PgText";
        data: string;
        driverParam: string;
        notNull: true;
        hasDefault: false;
        isPrimaryKey: false;
        isAutoincrement: false;
        hasRuntimeDefault: false;
        enumValues: [string, ...string[]];
        baseColumn: never;
        identity: undefined;
        generated: undefined;
      },
      {},
      {}
    >;
    workspaceId: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "workspace_id";
        tableName: "thread_documents";
        dataType: "string";
        columnType: "PgUUID";
        data: string;
        driverParam: string;
        notNull: true;
        hasDefault: false;
        isPrimaryKey: false;
        isAutoincrement: false;
        hasRuntimeDefault: false;
        enumValues: undefined;
        baseColumn: never;
        identity: undefined;
        generated: undefined;
      },
      {},
      {}
    >;
    createdAt: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "created_at";
        tableName: "thread_documents";
        dataType: "date";
        columnType: "PgTimestamp";
        data: Date;
        driverParam: string;
        notNull: true;
        hasDefault: true;
        isPrimaryKey: false;
        isAutoincrement: false;
        hasRuntimeDefault: false;
        enumValues: undefined;
        baseColumn: never;
        identity: undefined;
        generated: undefined;
      },
      {},
      {}
    >;
  },
  undefined,
  undefined
>;
/**
 * @internal For monorepo usage - enables schema composition in API layer
 */
export declare const selectThreadDocumentSchema: import("drizzle-zod").BuildSchema<
  "select",
  {
    id: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "id";
        tableName: "thread_documents";
        dataType: "string";
        columnType: "PgUUID";
        data: string;
        driverParam: string;
        notNull: true;
        hasDefault: true;
        isPrimaryKey: true;
        isAutoincrement: false;
        hasRuntimeDefault: false;
        enumValues: undefined;
        baseColumn: never;
        identity: undefined;
        generated: undefined;
      },
      {},
      {}
    >;
    threadId: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "thread_id";
        tableName: "thread_documents";
        dataType: "string";
        columnType: "PgUUID";
        data: string;
        driverParam: string;
        notNull: true;
        hasDefault: false;
        isPrimaryKey: false;
        isAutoincrement: false;
        hasRuntimeDefault: false;
        enumValues: undefined;
        baseColumn: never;
        identity: undefined;
        generated: undefined;
      },
      {},
      {}
    >;
    documentId: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "document_id";
        tableName: "thread_documents";
        dataType: "string";
        columnType: "PgUUID";
        data: string;
        driverParam: string;
        notNull: true;
        hasDefault: false;
        isPrimaryKey: false;
        isAutoincrement: false;
        hasRuntimeDefault: false;
        enumValues: undefined;
        baseColumn: never;
        identity: undefined;
        generated: undefined;
      },
      {},
      {}
    >;
    relationshipType: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "relationship_type";
        tableName: "thread_documents";
        dataType: "string";
        columnType: "PgText";
        data: ThreadDocumentRelationshipType;
        driverParam: string;
        notNull: true;
        hasDefault: false;
        isPrimaryKey: false;
        isAutoincrement: false;
        hasRuntimeDefault: false;
        enumValues: [
          ThreadDocumentRelationshipType.USED_AS_CONTEXT,
          ThreadDocumentRelationshipType.CREATED,
          ThreadDocumentRelationshipType.UPDATED,
          ThreadDocumentRelationshipType.REFERENCED,
          ThreadDocumentRelationshipType.INHERITED_FROM_PARENT,
        ];
        baseColumn: never;
        identity: undefined;
        generated: undefined;
      },
      {},
      {}
    >;
    conflictStatus: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "conflict_status";
        tableName: "thread_documents";
        dataType: "string";
        columnType: "PgText";
        data: ThreadDocumentConflictStatus;
        driverParam: string;
        notNull: true;
        hasDefault: true;
        isPrimaryKey: false;
        isAutoincrement: false;
        hasRuntimeDefault: false;
        enumValues: [
          ThreadDocumentConflictStatus.NONE,
          ThreadDocumentConflictStatus.PENDING,
          ThreadDocumentConflictStatus.RESOLVED,
        ];
        baseColumn: never;
        identity: undefined;
        generated: undefined;
      },
      {},
      {}
    >;
    sourceMessageId: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "source_message_id";
        tableName: "thread_documents";
        dataType: "string";
        columnType: "PgUUID";
        data: string;
        driverParam: string;
        notNull: false;
        hasDefault: false;
        isPrimaryKey: false;
        isAutoincrement: false;
        hasRuntimeDefault: false;
        enumValues: undefined;
        baseColumn: never;
        identity: undefined;
        generated: undefined;
      },
      {},
      {}
    >;
    sourceEventId: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "source_event_id";
        tableName: "thread_documents";
        dataType: "string";
        columnType: "PgUUID";
        data: string;
        driverParam: string;
        notNull: false;
        hasDefault: false;
        isPrimaryKey: false;
        isAutoincrement: false;
        hasRuntimeDefault: false;
        enumValues: undefined;
        baseColumn: never;
        identity: undefined;
        generated: undefined;
      },
      {},
      {}
    >;
    userId: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "user_id";
        tableName: "thread_documents";
        dataType: "string";
        columnType: "PgText";
        data: string;
        driverParam: string;
        notNull: true;
        hasDefault: false;
        isPrimaryKey: false;
        isAutoincrement: false;
        hasRuntimeDefault: false;
        enumValues: [string, ...string[]];
        baseColumn: never;
        identity: undefined;
        generated: undefined;
      },
      {},
      {}
    >;
    workspaceId: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "workspace_id";
        tableName: "thread_documents";
        dataType: "string";
        columnType: "PgUUID";
        data: string;
        driverParam: string;
        notNull: true;
        hasDefault: false;
        isPrimaryKey: false;
        isAutoincrement: false;
        hasRuntimeDefault: false;
        enumValues: undefined;
        baseColumn: never;
        identity: undefined;
        generated: undefined;
      },
      {},
      {}
    >;
    createdAt: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "created_at";
        tableName: "thread_documents";
        dataType: "date";
        columnType: "PgTimestamp";
        data: Date;
        driverParam: string;
        notNull: true;
        hasDefault: true;
        isPrimaryKey: false;
        isAutoincrement: false;
        hasRuntimeDefault: false;
        enumValues: undefined;
        baseColumn: never;
        identity: undefined;
        generated: undefined;
      },
      {},
      {}
    >;
  },
  undefined,
  undefined
>;
//# sourceMappingURL=thread-documents.d.ts.map
