/**
 * User Preferences Schema - UI and application settings
 *
 * Stores user-specific preferences that persist across sessions
 */
export interface CustomTheme {
    colors?: {
        primary?: string;
        accent?: string;
        background?: string;
        border?: string;
        text?: string;
    };
    spacing?: {
        small?: string;
        medium?: string;
        large?: string;
    };
    radii?: {
        small?: string;
        medium?: string;
        large?: string;
    };
    animations?: {
        enabled?: boolean;
        speed?: "slow" | "normal" | "fast";
    };
}
export interface DefaultTemplates {
    [entityType: string]: string;
}
export interface CustomEntityType {
    id: string;
    name: string;
    icon: string;
    color: string;
    metadataSchema: Record<string, any>;
}
export interface EntityMetadataSchemas {
    [entityType: string]: Record<string, any>;
}
/** How to open entity detail when user clicks an entity (workspace-wide) */
export type EntityOpenMode = "floating" | "side" | "modal";
export interface UIPreferences {
    sidebarCollapsed?: boolean;
    panelPositions?: Record<string, {
        x: number;
        y: number;
    }>;
    lastActiveView?: string;
    compactMode?: boolean;
    fontSize?: string;
    animations?: boolean;
    defaultView?: "list" | "grid" | "timeline";
    /** Where to open entity detail: floating panel (default), side panel, or modal */
    entityOpenMode?: EntityOpenMode;
}
export interface GraphPreferences {
    forceSettings?: {
        linkDistance?: number;
        chargeStrength?: number;
        alphaDecay?: number;
        velocityDecay?: number;
    };
    defaultFilters?: {
        entityTypes?: string[];
        relationTypes?: string[];
    };
    zoom?: number;
    pan?: {
        x: number;
        y: number;
    };
    showMinimap?: boolean;
}
export declare const userPreferences: import("drizzle-orm/pg-core").PgTableWithColumns<{
    name: "user_preferences";
    schema: undefined;
    columns: {
        userId: import("drizzle-orm/pg-core").PgColumn<{
            name: "user_id";
            tableName: "user_preferences";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: true;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        theme: import("drizzle-orm/pg-core").PgColumn<{
            name: "theme";
            tableName: "user_preferences";
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
        }, {}, {}>;
        customTheme: import("drizzle-orm/pg-core").PgColumn<{
            name: "custom_theme";
            tableName: "user_preferences";
            dataType: "json";
            columnType: "PgJsonb";
            data: CustomTheme;
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
        }, {}, {
            $type: CustomTheme;
        }>;
        defaultTemplates: import("drizzle-orm/pg-core").PgColumn<{
            name: "default_templates";
            tableName: "user_preferences";
            dataType: "json";
            columnType: "PgJsonb";
            data: DefaultTemplates;
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
        }, {}, {
            $type: DefaultTemplates;
        }>;
        customEntityTypes: import("drizzle-orm/pg-core").PgColumn<{
            name: "custom_entity_types";
            tableName: "user_preferences";
            dataType: "json";
            columnType: "PgJsonb";
            data: CustomEntityType[];
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
        }, {}, {
            $type: CustomEntityType[];
        }>;
        entityMetadataSchemas: import("drizzle-orm/pg-core").PgColumn<{
            name: "entity_metadata_schemas";
            tableName: "user_preferences";
            dataType: "json";
            columnType: "PgJsonb";
            data: EntityMetadataSchemas;
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
        }, {}, {
            $type: EntityMetadataSchemas;
        }>;
        uiPreferences: import("drizzle-orm/pg-core").PgColumn<{
            name: "ui_preferences";
            tableName: "user_preferences";
            dataType: "json";
            columnType: "PgJsonb";
            data: UIPreferences;
            driverParam: unknown;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            $type: UIPreferences;
        }>;
        graphPreferences: import("drizzle-orm/pg-core").PgColumn<{
            name: "graph_preferences";
            tableName: "user_preferences";
            dataType: "json";
            columnType: "PgJsonb";
            data: GraphPreferences;
            driverParam: unknown;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            $type: GraphPreferences;
        }>;
        intelligenceServicePreferences: import("drizzle-orm/pg-core").PgColumn<{
            name: "intelligence_service_preferences";
            tableName: "user_preferences";
            dataType: "json";
            columnType: "PgJsonb";
            data: {
                default?: string;
                chat?: string;
                analysis?: string;
            };
            driverParam: unknown;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            $type: {
                default?: string;
                chat?: string;
                analysis?: string;
            };
        }>;
        onboardingCompleted: import("drizzle-orm/pg-core").PgColumn<{
            name: "onboarding_completed";
            tableName: "user_preferences";
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
        }, {}, {}>;
        onboardingStep: import("drizzle-orm/pg-core").PgColumn<{
            name: "onboarding_step";
            tableName: "user_preferences";
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
        }, {}, {}>;
        updatedAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "updated_at";
            tableName: "user_preferences";
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
        }, {}, {}>;
    };
    dialect: "pg";
}>;
export type UserPreference = typeof userPreferences.$inferSelect;
export type NewUserPreference = typeof userPreferences.$inferInsert;
/**
 * @internal For monorepo usage - enables schema composition in API layer
 */
export declare const insertUserPreferenceSchema: import("drizzle-zod").BuildSchema<"insert", {
    userId: import("drizzle-orm/pg-core").PgColumn<{
        name: "user_id";
        tableName: "user_preferences";
        dataType: "string";
        columnType: "PgText";
        data: string;
        driverParam: string;
        notNull: true;
        hasDefault: false;
        isPrimaryKey: true;
        isAutoincrement: false;
        hasRuntimeDefault: false;
        enumValues: [string, ...string[]];
        baseColumn: never;
        identity: undefined;
        generated: undefined;
    }, {}, {}>;
    theme: import("drizzle-orm/pg-core").PgColumn<{
        name: "theme";
        tableName: "user_preferences";
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
    }, {}, {}>;
    customTheme: import("drizzle-orm/pg-core").PgColumn<{
        name: "custom_theme";
        tableName: "user_preferences";
        dataType: "json";
        columnType: "PgJsonb";
        data: CustomTheme;
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
    }, {}, {
        $type: CustomTheme;
    }>;
    defaultTemplates: import("drizzle-orm/pg-core").PgColumn<{
        name: "default_templates";
        tableName: "user_preferences";
        dataType: "json";
        columnType: "PgJsonb";
        data: DefaultTemplates;
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
    }, {}, {
        $type: DefaultTemplates;
    }>;
    customEntityTypes: import("drizzle-orm/pg-core").PgColumn<{
        name: "custom_entity_types";
        tableName: "user_preferences";
        dataType: "json";
        columnType: "PgJsonb";
        data: CustomEntityType[];
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
    }, {}, {
        $type: CustomEntityType[];
    }>;
    entityMetadataSchemas: import("drizzle-orm/pg-core").PgColumn<{
        name: "entity_metadata_schemas";
        tableName: "user_preferences";
        dataType: "json";
        columnType: "PgJsonb";
        data: EntityMetadataSchemas;
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
    }, {}, {
        $type: EntityMetadataSchemas;
    }>;
    uiPreferences: import("drizzle-orm/pg-core").PgColumn<{
        name: "ui_preferences";
        tableName: "user_preferences";
        dataType: "json";
        columnType: "PgJsonb";
        data: UIPreferences;
        driverParam: unknown;
        notNull: true;
        hasDefault: true;
        isPrimaryKey: false;
        isAutoincrement: false;
        hasRuntimeDefault: false;
        enumValues: undefined;
        baseColumn: never;
        identity: undefined;
        generated: undefined;
    }, {}, {
        $type: UIPreferences;
    }>;
    graphPreferences: import("drizzle-orm/pg-core").PgColumn<{
        name: "graph_preferences";
        tableName: "user_preferences";
        dataType: "json";
        columnType: "PgJsonb";
        data: GraphPreferences;
        driverParam: unknown;
        notNull: true;
        hasDefault: true;
        isPrimaryKey: false;
        isAutoincrement: false;
        hasRuntimeDefault: false;
        enumValues: undefined;
        baseColumn: never;
        identity: undefined;
        generated: undefined;
    }, {}, {
        $type: GraphPreferences;
    }>;
    intelligenceServicePreferences: import("drizzle-orm/pg-core").PgColumn<{
        name: "intelligence_service_preferences";
        tableName: "user_preferences";
        dataType: "json";
        columnType: "PgJsonb";
        data: {
            default?: string;
            chat?: string;
            analysis?: string;
        };
        driverParam: unknown;
        notNull: true;
        hasDefault: true;
        isPrimaryKey: false;
        isAutoincrement: false;
        hasRuntimeDefault: false;
        enumValues: undefined;
        baseColumn: never;
        identity: undefined;
        generated: undefined;
    }, {}, {
        $type: {
            default?: string;
            chat?: string;
            analysis?: string;
        };
    }>;
    onboardingCompleted: import("drizzle-orm/pg-core").PgColumn<{
        name: "onboarding_completed";
        tableName: "user_preferences";
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
    }, {}, {}>;
    onboardingStep: import("drizzle-orm/pg-core").PgColumn<{
        name: "onboarding_step";
        tableName: "user_preferences";
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
    }, {}, {}>;
    updatedAt: import("drizzle-orm/pg-core").PgColumn<{
        name: "updated_at";
        tableName: "user_preferences";
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
    }, {}, {}>;
}, undefined, undefined>;
/**
 * @internal For monorepo usage - enables schema composition in API layer
 */
export declare const selectUserPreferenceSchema: import("drizzle-zod").BuildSchema<"select", {
    userId: import("drizzle-orm/pg-core").PgColumn<{
        name: "user_id";
        tableName: "user_preferences";
        dataType: "string";
        columnType: "PgText";
        data: string;
        driverParam: string;
        notNull: true;
        hasDefault: false;
        isPrimaryKey: true;
        isAutoincrement: false;
        hasRuntimeDefault: false;
        enumValues: [string, ...string[]];
        baseColumn: never;
        identity: undefined;
        generated: undefined;
    }, {}, {}>;
    theme: import("drizzle-orm/pg-core").PgColumn<{
        name: "theme";
        tableName: "user_preferences";
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
    }, {}, {}>;
    customTheme: import("drizzle-orm/pg-core").PgColumn<{
        name: "custom_theme";
        tableName: "user_preferences";
        dataType: "json";
        columnType: "PgJsonb";
        data: CustomTheme;
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
    }, {}, {
        $type: CustomTheme;
    }>;
    defaultTemplates: import("drizzle-orm/pg-core").PgColumn<{
        name: "default_templates";
        tableName: "user_preferences";
        dataType: "json";
        columnType: "PgJsonb";
        data: DefaultTemplates;
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
    }, {}, {
        $type: DefaultTemplates;
    }>;
    customEntityTypes: import("drizzle-orm/pg-core").PgColumn<{
        name: "custom_entity_types";
        tableName: "user_preferences";
        dataType: "json";
        columnType: "PgJsonb";
        data: CustomEntityType[];
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
    }, {}, {
        $type: CustomEntityType[];
    }>;
    entityMetadataSchemas: import("drizzle-orm/pg-core").PgColumn<{
        name: "entity_metadata_schemas";
        tableName: "user_preferences";
        dataType: "json";
        columnType: "PgJsonb";
        data: EntityMetadataSchemas;
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
    }, {}, {
        $type: EntityMetadataSchemas;
    }>;
    uiPreferences: import("drizzle-orm/pg-core").PgColumn<{
        name: "ui_preferences";
        tableName: "user_preferences";
        dataType: "json";
        columnType: "PgJsonb";
        data: UIPreferences;
        driverParam: unknown;
        notNull: true;
        hasDefault: true;
        isPrimaryKey: false;
        isAutoincrement: false;
        hasRuntimeDefault: false;
        enumValues: undefined;
        baseColumn: never;
        identity: undefined;
        generated: undefined;
    }, {}, {
        $type: UIPreferences;
    }>;
    graphPreferences: import("drizzle-orm/pg-core").PgColumn<{
        name: "graph_preferences";
        tableName: "user_preferences";
        dataType: "json";
        columnType: "PgJsonb";
        data: GraphPreferences;
        driverParam: unknown;
        notNull: true;
        hasDefault: true;
        isPrimaryKey: false;
        isAutoincrement: false;
        hasRuntimeDefault: false;
        enumValues: undefined;
        baseColumn: never;
        identity: undefined;
        generated: undefined;
    }, {}, {
        $type: GraphPreferences;
    }>;
    intelligenceServicePreferences: import("drizzle-orm/pg-core").PgColumn<{
        name: "intelligence_service_preferences";
        tableName: "user_preferences";
        dataType: "json";
        columnType: "PgJsonb";
        data: {
            default?: string;
            chat?: string;
            analysis?: string;
        };
        driverParam: unknown;
        notNull: true;
        hasDefault: true;
        isPrimaryKey: false;
        isAutoincrement: false;
        hasRuntimeDefault: false;
        enumValues: undefined;
        baseColumn: never;
        identity: undefined;
        generated: undefined;
    }, {}, {
        $type: {
            default?: string;
            chat?: string;
            analysis?: string;
        };
    }>;
    onboardingCompleted: import("drizzle-orm/pg-core").PgColumn<{
        name: "onboarding_completed";
        tableName: "user_preferences";
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
    }, {}, {}>;
    onboardingStep: import("drizzle-orm/pg-core").PgColumn<{
        name: "onboarding_step";
        tableName: "user_preferences";
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
    }, {}, {}>;
    updatedAt: import("drizzle-orm/pg-core").PgColumn<{
        name: "updated_at";
        tableName: "user_preferences";
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
    }, {}, {}>;
}, undefined, undefined>;
//# sourceMappingURL=user-preferences.d.ts.map