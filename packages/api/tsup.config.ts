import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    // The document read/edit floor for the realtime (Yjs) room gate — the ONE
    // predicate, consumed by `@synap/realtime` via `@synap/api/document-access`.
    "document-access": "src/utils/document-edit-access.ts",
    // The public-door namespace predicate (Sites W3) — zero imports, read by
    // `apps/api` (CORS, rate class) via `@synap/api/public-doors`.
    "public-doors": "src/public-doors.ts",
  },
  format: ["esm"],
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
