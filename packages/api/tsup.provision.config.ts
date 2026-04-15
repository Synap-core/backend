import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    "scripts/provision-agent": "src/scripts/provision-agent.ts",
    "scripts/create-admin-cli": "src/scripts/create-admin-cli.ts",
    "scripts/user-admin-cli": "src/scripts/user-admin-cli.ts",
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
    "@synap/database/schema",
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
