import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: {
    compilerOptions: {
      incremental: false,
    },
  },
  sourcemap: true,
  clean: true,
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
