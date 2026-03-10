/**
 * Intelligence Commands Schema
 *
 * User-created Commands (Raycast-style): prompt template + derived inputs + permissions.
 * Single source of truth: prompt_template; compiled_template_ast and derived_inputs from parser.
 */
export declare const intelligenceCommands: import("drizzle-orm/pg-core").PgTableWithColumns<{
  name: "intelligence_commands";
  schema: undefined;
  columns: {
    id: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "id";
        tableName: "intelligence_commands";
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
    workspaceId: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "workspace_id";
        tableName: "intelligence_commands";
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
    createdBy: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "created_by";
        tableName: "intelligence_commands";
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
        tableName: "intelligence_commands";
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
    promptTemplate: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "prompt_template";
        tableName: "intelligence_commands";
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
    compiledTemplateAst: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "compiled_template_ast";
        tableName: "intelligence_commands";
        dataType: "json";
        columnType: "PgJsonb";
        data: unknown;
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
        $type: unknown;
      }
    >;
    derivedInputs: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "derived_inputs";
        tableName: "intelligence_commands";
        dataType: "json";
        columnType: "PgJsonb";
        data: DerivedInput[];
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
        $type: DerivedInput[];
      }
    >;
    inputOverrides: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "input_overrides";
        tableName: "intelligence_commands";
        dataType: "json";
        columnType: "PgJsonb";
        data: Record<string, InputOverride>;
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
        $type: Record<string, InputOverride>;
      }
    >;
    allowedTools: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "allowed_tools";
        tableName: "intelligence_commands";
        dataType: "json";
        columnType: "PgJsonb";
        data: string[];
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
        $type: string[];
      }
    >;
    allowedEntityTypes: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "allowed_entity_types";
        tableName: "intelligence_commands";
        dataType: "json";
        columnType: "PgJsonb";
        data: string[];
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
        $type: string[];
      }
    >;
    maxEntitiesCreatedPerRun: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "max_entities_created_per_run";
        tableName: "intelligence_commands";
        dataType: "number";
        columnType: "PgInteger";
        data: number;
        driverParam: string | number;
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
    canCreateViews: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "can_create_views";
        tableName: "intelligence_commands";
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
    outputMode: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "output_mode";
        tableName: "intelligence_commands";
        dataType: "string";
        columnType: "PgText";
        data: "text" | "proposal" | "view";
        driverParam: string;
        notNull: true;
        hasDefault: true;
        isPrimaryKey: false;
        isAutoincrement: false;
        hasRuntimeDefault: false;
        enumValues: ["text", "proposal", "view"];
        baseColumn: never;
        identity: undefined;
        generated: undefined;
      },
      {},
      {}
    >;
    permissionsProfile: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "permissions_profile";
        tableName: "intelligence_commands";
        dataType: "string";
        columnType: "PgText";
        data: "read_only" | "propose_writes";
        driverParam: string;
        notNull: true;
        hasDefault: true;
        isPrimaryKey: false;
        isAutoincrement: false;
        hasRuntimeDefault: false;
        enumValues: ["read_only", "propose_writes"];
        baseColumn: never;
        identity: undefined;
        generated: undefined;
      },
      {},
      {}
    >;
    sharedScope: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "shared_scope";
        tableName: "intelligence_commands";
        dataType: "string";
        columnType: "PgText";
        data: "workspace" | "user";
        driverParam: string;
        notNull: true;
        hasDefault: true;
        isPrimaryKey: false;
        isAutoincrement: false;
        hasRuntimeDefault: false;
        enumValues: ["workspace", "user"];
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
        tableName: "intelligence_commands";
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
        tableName: "intelligence_commands";
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
export interface DerivedInput {
  name: string;
  label?: string;
  type?: string;
  options?: string[];
  default?: string;
}
export interface InputOverride {
  label?: string;
  default?: string;
  options?: string[];
}
export type IntelligenceCommand = typeof intelligenceCommands.$inferSelect;
export type NewIntelligenceCommand = typeof intelligenceCommands.$inferInsert;
//# sourceMappingURL=intelligence-commands.d.ts.map
