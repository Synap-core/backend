// Writes dist/build-schema-hash.{js,d.ts} from src/generated.d.ts at build
// time, over tsc's empty emit of the declaration-only src/build-schema-hash.ts.
// The hash is never committed (a one-line file every type change rewrote, so
// open PRs conflicted on it); it is derived through the one function in
// @synap/api's scripts/schema-hash.mjs.

import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { schemaHashOfFile } from "../../api/scripts/schema-hash.mjs";

const SRC = fileURLToPath(new URL("../src/generated.d.ts", import.meta.url));
const DIST = fileURLToPath(new URL("../dist/", import.meta.url));

const hash = schemaHashOfFile(SRC);
const header =
  "// Generated at build from src/generated.d.ts — do not commit.\n";
mkdirSync(DIST, { recursive: true });
writeFileSync(
  `${DIST}build-schema-hash.js`,
  `${header}export const API_TYPES_SCHEMA_HASH = "${hash}";\n`
);
writeFileSync(
  `${DIST}build-schema-hash.d.ts`,
  `${header}export declare const API_TYPES_SCHEMA_HASH: string;\n`
);
console.log(`api-types schema ${hash}`);
