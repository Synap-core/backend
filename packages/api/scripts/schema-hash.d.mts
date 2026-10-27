// Types for schema-hash.mjs, so src/ (health.ts) and tsup.config.ts can import it.
export declare const GENERATED_TYPES_PATH: string;
export declare function schemaHashOf(text: string): string;
export declare function schemaHashOfFile(path?: string): string;
