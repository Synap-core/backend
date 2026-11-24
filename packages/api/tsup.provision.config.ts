import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    "scripts/create-admin-cli": "src/scripts/create-admin-cli.ts",
    "scripts/user-admin-cli": "src/scripts/user-admin-cli.ts",
    "scripts/field-crypto": "src/scripts/field-crypto-cli.ts",
    "scripts/run-conversions": "src/scripts/run-conversions-cli.ts",
    "scripts/backfill-session-spaces":
      "src/scripts/backfill-session-spaces-cli.ts",
    "scripts/backfill-app-access": "src/scripts/backfill-app-access-cli.ts",
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
