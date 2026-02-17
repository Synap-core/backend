/**
 * Conversation Messages Schema
 *
 * Stores conversation messages with hash chain for integrity.
 *
 * PostgreSQL-only schema with Row-Level Security (RLS) for multi-user support.
 */
export declare const conversationMessages: import("drizzle-orm/pg-core").PgTableWithColumns<{
  name: "conversation_messages";
  schema: undefined;
  columns: {
    id: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "id";
        tableName: "conversation_messages";
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
        tableName: "conversation_messages";
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
    parentId: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "parent_id";
        tableName: "conversation_messages";
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
    role: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "role";
        tableName: "conversation_messages";
        dataType: "string";
        columnType: "PgText";
        data: "user" | "assistant" | "system";
        driverParam: string;
        notNull: true;
        hasDefault: false;
        isPrimaryKey: false;
        isAutoincrement: false;
        hasRuntimeDefault: false;
        enumValues: ["user", "assistant", "system"];
        baseColumn: never;
        identity: undefined;
        generated: undefined;
      },
      {},
      {}
    >;
    content: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "content";
        tableName: "conversation_messages";
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
    metadata: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "metadata";
        tableName: "conversation_messages";
        dataType: "json";
        columnType: "PgJsonb";
        data: {
          agentState?:
            | {
                plan: {
                  tool: string;
                  params: Record<string, unknown>;
                  reasoning: string;
                }[];
                executionSummaries: {
                  tool: string;
                  status: "success" | "error" | "skipped";
                  result?: unknown;
                  error?: string | undefined;
                }[];
                finalResponse: string;
                intentAnalysis?:
                  | {
                      label: string;
                      confidence: number;
                      reasoning?: string | undefined;
                      needsFollowUp?: boolean | undefined;
                    }
                  | undefined;
                context?:
                  | {
                      retrievedNotesCount: number;
                      retrievedFactsCount: number;
                    }
                  | undefined;
                suggestedActions?:
                  | {
                      type: string;
                      description: string;
                      params: Record<string, unknown>;
                    }[]
                  | undefined;
                model?: string | undefined;
                tokens?: number | undefined;
                latency?: number | undefined;
              }
            | undefined;
          suggestedActions?:
            | {
                type: string;
                description: string;
                params: Record<string, unknown>;
              }[]
            | undefined;
          executedAction?:
            | {
                type: string;
                result: unknown;
              }
            | undefined;
          attachments?:
            | {
                type: string;
                url: string;
              }[]
            | undefined;
          model?: string | undefined;
          tokens?: number | undefined;
          latency?: number | undefined;
        } | null;
        driverParam: unknown;
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
        $type: {
          agentState?:
            | {
                plan: {
                  tool: string;
                  params: Record<string, unknown>;
                  reasoning: string;
                }[];
                executionSummaries: {
                  tool: string;
                  status: "success" | "error" | "skipped";
                  result?: unknown;
                  error?: string | undefined;
                }[];
                finalResponse: string;
                intentAnalysis?:
                  | {
                      label: string;
                      confidence: number;
                      reasoning?: string | undefined;
                      needsFollowUp?: boolean | undefined;
                    }
                  | undefined;
                context?:
                  | {
                      retrievedNotesCount: number;
                      retrievedFactsCount: number;
                    }
                  | undefined;
                suggestedActions?:
                  | {
                      type: string;
                      description: string;
                      params: Record<string, unknown>;
                    }[]
                  | undefined;
                model?: string | undefined;
                tokens?: number | undefined;
                latency?: number | undefined;
              }
            | undefined;
          suggestedActions?:
            | {
                type: string;
                description: string;
                params: Record<string, unknown>;
              }[]
            | undefined;
          executedAction?:
            | {
                type: string;
                result: unknown;
              }
            | undefined;
          attachments?:
            | {
                type: string;
                url: string;
              }[]
            | undefined;
          model?: string | undefined;
          tokens?: number | undefined;
          latency?: number | undefined;
        } | null;
      }
    >;
    userId: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "user_id";
        tableName: "conversation_messages";
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
    timestamp: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "timestamp";
        tableName: "conversation_messages";
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
    previousHash: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "previous_hash";
        tableName: "conversation_messages";
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
    hash: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "hash";
        tableName: "conversation_messages";
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
    deletedAt: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "deleted_at";
        tableName: "conversation_messages";
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
  };
  dialect: "pg";
}>;
export type ConversationMessageRow = typeof conversationMessages.$inferSelect;
export type NewConversationMessageRow =
  typeof conversationMessages.$inferInsert;
//# sourceMappingURL=conversation-messages.d.ts.map
