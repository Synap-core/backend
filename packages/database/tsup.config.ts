import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "schema/index": "src/schema/index.ts",
  },
  format: ["esm"],
  dts: false, // Disabled - using tsc instead to handle complex drizzle-zod inferred types
  sourcemap: true,
  clean: false, // Disabled - preserve tsc-generated .d.ts files
  external: ["drizzle-orm", "postgres", "pgvector", "@synap-core/core"],
});
