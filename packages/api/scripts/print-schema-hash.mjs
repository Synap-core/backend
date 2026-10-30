// Prints the api-types schema hash. The api `build` script passes it to tsup as
// API_TYPES_SCHEMA_HASH (tsup.config.ts bakes it into the bundle), so the tsup
// config itself never reads generated.d.ts: a config that read it was a build
// edge from generated.d.ts to every test of every importer of @synap/api in the
// CI test selection (scripts/ci/import-graph.mjs), ~2,170 test files.

import { schemaHashOfFile } from "./schema-hash.mjs";

console.log(schemaHashOfFile());
