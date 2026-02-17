/**
 * API Keys Schema - Drizzle ORM
 *
 * Hub Protocol V1.0 - Phase 2
 *
 * API keys for Hub authentication with bcrypt hashing and complete audit trail.
 * Based on industry best practices from GitHub, Stripe, and AWS.
 */
/**
 * API Keys Table
 *
 * Stores API keys with bcrypt hashing for security.
 * Supports key rotation, expiration, and complete audit trail.
 */
export declare const apiKeys: import("drizzle-orm/pg-core").PgTableWithColumns<{
  name: "api_keys";
  schema: undefined;
  columns: {
    id: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "id";
        tableName: "api_keys";
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
    userId: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "user_id";
        tableName: "api_keys";
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
    keyName: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "key_name";
        tableName: "api_keys";
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
    keyPrefix: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "key_prefix";
        tableName: "api_keys";
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
    keyHash: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "key_hash";
        tableName: "api_keys";
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
    hubId: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "hub_id";
        tableName: "api_keys";
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
    scope: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "scope";
        tableName: "api_keys";
        dataType: "array";
        columnType: "PgArray";
        data: string[];
        driverParam: string | string[];
        notNull: true;
        hasDefault: true;
        isPrimaryKey: false;
        isAutoincrement: false;
        hasRuntimeDefault: false;
        enumValues: [string, ...string[]];
        baseColumn: import("drizzle-orm").Column<
          {
            name: "scope";
            tableName: "api_keys";
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
        identity: undefined;
        generated: undefined;
      },
      {},
      {
        size: undefined;
        baseBuilder: import("drizzle-orm/pg-core").PgColumnBuilder<
          {
            name: "scope";
            dataType: "string";
            columnType: "PgText";
            data: string;
            enumValues: [string, ...string[]];
            driverParam: string;
          },
          {},
          {},
          import("drizzle-orm").ColumnBuilderExtraConfig
        >;
      }
    >;
    expiresAt: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "expires_at";
        tableName: "api_keys";
        dataType: "date";
        columnType: "PgTimestamp";
        data: Date;
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
    isActive: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "is_active";
        tableName: "api_keys";
        dataType: "boolean";
        columnType: "PgBoolean";
        data: boolean;
        driverParam: boolean;
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
    lastUsedAt: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "last_used_at";
        tableName: "api_keys";
        dataType: "date";
        columnType: "PgTimestamp";
        data: Date;
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
    usageCount: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "usage_count";
        tableName: "api_keys";
        dataType: "number";
        columnType: "PgBigInt53";
        data: number;
        driverParam: string | number;
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
    rotatedFromId: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "rotated_from_id";
        tableName: "api_keys";
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
    rotationScheduledAt: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "rotation_scheduled_at";
        tableName: "api_keys";
        dataType: "date";
        columnType: "PgTimestamp";
        data: Date;
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
    createdAt: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "created_at";
        tableName: "api_keys";
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
    createdBy: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "created_by";
        tableName: "api_keys";
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
    revokedAt: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "revoked_at";
        tableName: "api_keys";
        dataType: "date";
        columnType: "PgTimestamp";
        data: Date;
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
    revokedBy: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "revoked_by";
        tableName: "api_keys";
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
    revokedReason: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "revoked_reason";
        tableName: "api_keys";
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
  };
  dialect: "pg";
}>;
/**
 * TypeScript type for API Key record
 */
export type ApiKeyRecord = typeof apiKeys.$inferSelect;
/**
 * TypeScript type for API Key insert
 */
export type ApiKeyInsert = typeof apiKeys.$inferInsert;
/**
 * Valid key prefixes
 */
export declare const KEY_PREFIXES: {
  readonly HUB_LIVE: "synap_hub_live_";
  readonly HUB_TEST: "synap_hub_test_";
  readonly USER: "synap_user_";
};
/**
 * Valid scopes for API keys
 */
export declare const API_KEY_SCOPES: readonly [
  "preferences",
  "calendar",
  "notes",
  "tasks",
  "projects",
  "conversations",
  "entities",
  "relations",
  "knowledge_facts",
  "write:entities",
  "read:entities",
  "ai:analyze",
  "webhook:manage",
  "hub-protocol.read",
  "hub-protocol.write",
  "mcp.read",
  "mcp.write",
];
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];
/**
 * Helper to check if a scope is valid
 */
export declare function isValidScope(scope: string): scope is ApiKeyScope;
export declare const apiKeysRelations: import("drizzle-orm").Relations<
  "api_keys",
  {
    user: import("drizzle-orm").One<"users", true>;
  }
>;
//# sourceMappingURL=api-keys.d.ts.map
