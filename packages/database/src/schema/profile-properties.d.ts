/**
 * Profile Properties Junction Table
 *
 * Links profiles to property definitions.
 * Defines which properties are available for each profile, with requirements and defaults.
 */
export declare const profileProperties: import("drizzle-orm/pg-core").PgTableWithColumns<{
    name: "profile_properties";
    schema: undefined;
    columns: {
        profileId: import("drizzle-orm/pg-core").PgColumn<{
            name: "profile_id";
            tableName: "profile_properties";
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
        }, {}, {}>;
        propertyDefId: import("drizzle-orm/pg-core").PgColumn<{
            name: "property_def_id";
            tableName: "profile_properties";
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
        }, {}, {}>;
        required: import("drizzle-orm/pg-core").PgColumn<{
            name: "required";
            tableName: "profile_properties";
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
        defaultValue: import("drizzle-orm/pg-core").PgColumn<{
            name: "default_value";
            tableName: "profile_properties";
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
        }, {}, {}>;
        displayOrder: import("drizzle-orm/pg-core").PgColumn<{
            name: "display_order";
            tableName: "profile_properties";
            dataType: "number";
            columnType: "PgInteger";
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
        }, {}, {}>;
    };
    dialect: "pg";
}>;
export type ProfileProperty = typeof profileProperties.$inferSelect;
export type NewProfileProperty = typeof profileProperties.$inferInsert;
/**
 * @internal For monorepo usage - enables schema composition in API layer
 */
export declare const insertProfilePropertySchema: import("drizzle-zod").BuildSchema<"insert", {
    profileId: import("drizzle-orm/pg-core").PgColumn<{
        name: "profile_id";
        tableName: "profile_properties";
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
    }, {}, {}>;
    propertyDefId: import("drizzle-orm/pg-core").PgColumn<{
        name: "property_def_id";
        tableName: "profile_properties";
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
    }, {}, {}>;
    required: import("drizzle-orm/pg-core").PgColumn<{
        name: "required";
        tableName: "profile_properties";
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
    defaultValue: import("drizzle-orm/pg-core").PgColumn<{
        name: "default_value";
        tableName: "profile_properties";
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
    }, {}, {}>;
    displayOrder: import("drizzle-orm/pg-core").PgColumn<{
        name: "display_order";
        tableName: "profile_properties";
        dataType: "number";
        columnType: "PgInteger";
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
    }, {}, {}>;
}, undefined, undefined>;
export declare const selectProfilePropertySchema: import("drizzle-zod").BuildSchema<"select", {
    profileId: import("drizzle-orm/pg-core").PgColumn<{
        name: "profile_id";
        tableName: "profile_properties";
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
    }, {}, {}>;
    propertyDefId: import("drizzle-orm/pg-core").PgColumn<{
        name: "property_def_id";
        tableName: "profile_properties";
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
    }, {}, {}>;
    required: import("drizzle-orm/pg-core").PgColumn<{
        name: "required";
        tableName: "profile_properties";
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
    defaultValue: import("drizzle-orm/pg-core").PgColumn<{
        name: "default_value";
        tableName: "profile_properties";
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
    }, {}, {}>;
    displayOrder: import("drizzle-orm/pg-core").PgColumn<{
        name: "display_order";
        tableName: "profile_properties";
        dataType: "number";
        columnType: "PgInteger";
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
    }, {}, {}>;
}, undefined, undefined>;
//# sourceMappingURL=profile-properties.d.ts.map