import { defineConfig } from "tsup";

import { schemaHashOfFile } from "./scripts/schema-hash.mjs";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    // The document read/edit floor for the realtime (Yjs) room gate — the ONE
    // predicate, consumed by `@synap/realtime` via `@synap/api/document-access`.
    "document-access": "src/utils/document-edit-access.ts",
    // THE access door (Principal, canRead, assertCanWrite, canJoinRoom) — the
    // same vendoring into realtime, via `@synap/api/access-door`.
    "access-door": "src/access/door.ts",
    // The public-door namespace predicate (Sites W3) — zero imports, read by
    // `apps/api` (CORS, rate class) via `@synap/api/public-doors`.
    "public-doors": "src/public-doors.ts",
    // The path-secret redactor — zero imports, shared by the 5xx error-egress
    // sanitizer here and `apps/api`'s request logger / error handler.
    "redact-secret-path": "src/middleware/redact-secret-path.ts",
    // The page extractor's worker thread — spawned by
    // services/capabilities/web-read/extract-pool.ts as `./extract-worker.js`
    // NEXT TO the bundle (dist root), so it must be its own entry here.
    "extract-worker": "src/services/capabilities/web-read/extract-worker.ts",
    // The code-skill runner process — forked by
    // services/skills/runner/process-pool.ts as `./skill-runner-child.js` NEXT
    // TO the bundle (dist root), so it must be its own entry here.
    "skill-runner-child": "src/services/skills/runner/skill-runner-child.ts",
  },
  format: ["esm"],
  // /health serves the hash of the committed api-types contract; bake it in so
  // the shipped bundle never reads the file (the image does not carry it).
  define: {
    __API_TYPES_SCHEMA_HASH__: JSON.stringify(schemaHashOfFile()),
  },
  sourcemap: true,
  clean: false,
  external: [
    "@synap/database",
    "@synap/storage",
    "@synap/jobs",
    "@synap/auth",
    "@synap/events",
    "@trpc/server",
    "drizzle-orm",
    "bcrypt",
  ],
});
