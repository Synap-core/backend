/**
 * Entity Vectors Schema - Separate Embeddings Table
 *
 * Embeddings moved out of entities table for better performance.
 *
 * Why separate table?
 * - Large vectors slow down entity queries
 * - Different indexing strategy (HNSW with pgvector)
 * - Can rebuild embeddings without touching entities
 * - Supports multiple embedding models per entity
 *
 * PostgreSQL-only schema with pgvector extension for semantic search.
 */
export declare const entityVectors: import("drizzle-orm/pg-core").PgTableWithColumns<{
  name: "entity_vectors";
  schema: undefined;
  columns: {
    entityId: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "entity_id";
        tableName: "entity_vectors";
        dataType: "string";
        columnType: "PgUUID";
        data: string;
        driverParam: string;
        notNull: true;
        hasDefault: false;
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
    userId: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "user_id";
        tableName: "entity_vectors";
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
    embedding: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "embedding";
        tableName: "entity_vectors";
        dataType: "array";
        columnType: "PgVector";
        data: number[];
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
      {
        dimensions: 1536;
      }
    >;
    embeddingModel: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "embedding_model";
        tableName: "entity_vectors";
        dataType: "string";
        columnType: "PgText";
        data: string;
        driverParam: string;
        notNull: true;
        hasDefault: true;
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
    entityType: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "entity_type";
        tableName: "entity_vectors";
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
    title: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "title";
        tableName: "entity_vectors";
        dataType: "string";
        columnType: "PgText";
        data: string;
        driverParam: string;
        notNull: false;
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
    preview: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "preview";
        tableName: "entity_vectors";
        dataType: "string";
        columnType: "PgText";
        data: string;
        driverParam: string;
        notNull: false;
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
    fileUrl: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "file_url";
        tableName: "entity_vectors";
        dataType: "string";
        columnType: "PgText";
        data: string;
        driverParam: string;
        notNull: false;
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
    indexedAt: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "indexed_at";
        tableName: "entity_vectors";
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
    updatedAt: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "updated_at";
        tableName: "entity_vectors";
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
export type EntityVector = typeof entityVectors.$inferSelect;
export type NewEntityVector = typeof entityVectors.$inferInsert;
//# sourceMappingURL=entity-vectors.d.ts.map
