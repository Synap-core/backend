/**
 * Thread Entities Schema
 *
 * Tracks which entities are used/updated/referenced by chat threads.
 * Enables context inheritance in Git-like branching system.
 */
/**
 * Thread Entity Relationship Types
 *
 * How an entity relates to a thread.
 */
export declare enum ThreadEntityRelationshipType {
  USED_AS_CONTEXT = "used_as_context",
  CREATED = "created",
  UPDATED = "updated",
  REFERENCED = "referenced",
  INHERITED_FROM_PARENT = "inherited_from_parent",
}
/**
 * Thread Entity Conflict Status
 */
export declare enum ThreadEntityConflictStatus {
  NONE = "none",
  PENDING = "pending",
  RESOLVED = "resolved",
}
export declare const threadEntities: import("drizzle-orm/pg-core").PgTableWithColumns<{
  name: "thread_entities";
  schema: undefined;
  columns: {
    id: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "id";
        tableName: "thread_entities";
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
        tableName: "thread_entities";
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
    entityId: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "entity_id";
        tableName: "thread_entities";
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
        tableName: "thread_entities";
        dataType: "string";
        columnType: "PgText";
        data: ThreadEntityRelationshipType;
        driverParam: string;
        notNull: true;
        hasDefault: false;
        isPrimaryKey: false;
        isAutoincrement: false;
        hasRuntimeDefault: false;
        enumValues: [
          ThreadEntityRelationshipType.USED_AS_CONTEXT,
          ThreadEntityRelationshipType.CREATED,
          ThreadEntityRelationshipType.UPDATED,
          ThreadEntityRelationshipType.REFERENCED,
          ThreadEntityRelationshipType.INHERITED_FROM_PARENT,
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
        tableName: "thread_entities";
        dataType: "string";
        columnType: "PgText";
        data: ThreadEntityConflictStatus;
        driverParam: string;
        notNull: true;
        hasDefault: true;
        isPrimaryKey: false;
        isAutoincrement: false;
        hasRuntimeDefault: false;
        enumValues: [
          ThreadEntityConflictStatus.NONE,
          ThreadEntityConflictStatus.PENDING,
          ThreadEntityConflictStatus.RESOLVED,
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
        tableName: "thread_entities";
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
        tableName: "thread_entities";
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
        tableName: "thread_entities";
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
        tableName: "thread_entities";
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
        tableName: "thread_entities";
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
export type ThreadEntity = typeof threadEntities.$inferSelect;
export type NewThreadEntity = typeof threadEntities.$inferInsert;
/**
 * @internal For monorepo usage - enables schema composition in API layer
 */
export declare const insertThreadEntitySchema: import("drizzle-zod").BuildSchema<
  "insert",
  {
    id: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "id";
        tableName: "thread_entities";
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
        tableName: "thread_entities";
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
    entityId: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "entity_id";
        tableName: "thread_entities";
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
        tableName: "thread_entities";
        dataType: "string";
        columnType: "PgText";
        data: ThreadEntityRelationshipType;
        driverParam: string;
        notNull: true;
        hasDefault: false;
        isPrimaryKey: false;
        isAutoincrement: false;
        hasRuntimeDefault: false;
        enumValues: [
          ThreadEntityRelationshipType.USED_AS_CONTEXT,
          ThreadEntityRelationshipType.CREATED,
          ThreadEntityRelationshipType.UPDATED,
          ThreadEntityRelationshipType.REFERENCED,
          ThreadEntityRelationshipType.INHERITED_FROM_PARENT,
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
        tableName: "thread_entities";
        dataType: "string";
        columnType: "PgText";
        data: ThreadEntityConflictStatus;
        driverParam: string;
        notNull: true;
        hasDefault: true;
        isPrimaryKey: false;
        isAutoincrement: false;
        hasRuntimeDefault: false;
        enumValues: [
          ThreadEntityConflictStatus.NONE,
          ThreadEntityConflictStatus.PENDING,
          ThreadEntityConflictStatus.RESOLVED,
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
        tableName: "thread_entities";
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
        tableName: "thread_entities";
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
        tableName: "thread_entities";
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
        tableName: "thread_entities";
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
        tableName: "thread_entities";
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
export declare const selectThreadEntitySchema: import("drizzle-zod").BuildSchema<
  "select",
  {
    id: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "id";
        tableName: "thread_entities";
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
        tableName: "thread_entities";
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
    entityId: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "entity_id";
        tableName: "thread_entities";
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
        tableName: "thread_entities";
        dataType: "string";
        columnType: "PgText";
        data: ThreadEntityRelationshipType;
        driverParam: string;
        notNull: true;
        hasDefault: false;
        isPrimaryKey: false;
        isAutoincrement: false;
        hasRuntimeDefault: false;
        enumValues: [
          ThreadEntityRelationshipType.USED_AS_CONTEXT,
          ThreadEntityRelationshipType.CREATED,
          ThreadEntityRelationshipType.UPDATED,
          ThreadEntityRelationshipType.REFERENCED,
          ThreadEntityRelationshipType.INHERITED_FROM_PARENT,
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
        tableName: "thread_entities";
        dataType: "string";
        columnType: "PgText";
        data: ThreadEntityConflictStatus;
        driverParam: string;
        notNull: true;
        hasDefault: true;
        isPrimaryKey: false;
        isAutoincrement: false;
        hasRuntimeDefault: false;
        enumValues: [
          ThreadEntityConflictStatus.NONE,
          ThreadEntityConflictStatus.PENDING,
          ThreadEntityConflictStatus.RESOLVED,
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
        tableName: "thread_entities";
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
        tableName: "thread_entities";
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
        tableName: "thread_entities";
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
        tableName: "thread_entities";
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
        tableName: "thread_entities";
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
//# sourceMappingURL=thread-entities.d.ts.map
