import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    "scripts/provision-agent": "src/scripts/provision-agent.ts",
  },
  format: ["esm"],
  sourcemap: true,
  outDir: "dist",
  splitting: false,
  noExternal: [
    "@synap-core/types",
    "@synap-core/core",
    "@synap-core/hub-protocol",
  ],
  external: [
    "@synap/database",
    "@synap/storage",
    "@synap/jobs",
    "@synap/auth",
    "@synap/events",
    "drizzle-orm",
    "bcrypt",
    "dotenv",
    "dotenv/config",
  ],
});
