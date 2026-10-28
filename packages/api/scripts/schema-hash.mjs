// The api-types schema hash: the first 16 hex chars of sha256(generated.d.ts).
//
// DERIVED wherever it is needed, never committed: a committed hash is a
// one-line file that every type-changing PR rewrites, so any two such PRs
// conflicted on it, while generated.d.ts itself merges cleanly. Every producer
// goes through this one function: the pod bundle (tsup.config.ts `define`),
// /health under tsx/vitest (health.ts), the api-types build
// (dist/build-schema-hash.js) and CI's check of the booted pod's /health.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The committed contract this hash identifies. */
export const GENERATED_TYPES_PATH = fileURLToPath(
  new URL("../../api-types/src/generated.d.ts", import.meta.url)
);

/** @param {string} text */
export function schemaHashOf(text) {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** Throws when the file cannot be read: a missing contract has no hash. */
export function schemaHashOfFile(path = GENERATED_TYPES_PATH) {
  return schemaHashOf(readFileSync(path, "utf-8"));
}
