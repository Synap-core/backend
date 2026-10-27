// Declaration only: the value is written to dist/build-schema-hash.js when this
// package is built (scripts/write-schema-hash.mjs), derived from
// generated.d.ts. Never commit a hash here: every type-changing PR would
// rewrite it, and open PRs would conflict on it.
export declare const API_TYPES_SCHEMA_HASH: string;
