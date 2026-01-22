import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
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
