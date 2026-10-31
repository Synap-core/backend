import { defineConfig } from "tsup";

/**
 * The api-types schema hash /health serves, as the api `build` script passed it
 * (scripts/print-schema-hash.mjs). This config never reads generated.d.ts: the
 * CI test selection treats a package's tsup config as a dependency of every
 * test of every importer, so a config that read it sent every type-changing PR
 * to ~2,170 api tests. A bundle without the hash would read the file at run
 * time, and the image does not carry it: refuse to build instead.
 */
export function bakedSchemaHash(env: NodeJS.ProcessEnv = process.env): string {
  const hash = env.API_TYPES_SCHEMA_HASH;
  if (!hash || !/^[0-9a-f]{16}$/.test(hash))
    throw new Error(
      `API_TYPES_SCHEMA_HASH is ${hash ? `"${hash}", not a 16-hex schema hash` : "unset"}: build @synap/api with its build script (pnpm --filter @synap/api build), which passes \`node scripts/print-schema-hash.mjs\` to tsup`
    );
  return hash;
}

// A function, so the hash is read when tsup builds, not when a test imports
// this file.
export default defineConfig(() => ({
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
    // /trpc refusals as tRPC errors, and the adapter's path rule — hono and
    // @trpc/server only, read by `apps/api` via `@synap/api/trpc-refusal`.
    "trpc-refusal": "src/middleware/trpc-refusal.ts",
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
    __API_TYPES_SCHEMA_HASH__: JSON.stringify(bakedSchemaHash()),
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
}));
