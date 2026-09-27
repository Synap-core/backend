import { defineConfig } from "vitest/config";

// The service imports `@synap/database`, whose config module validates
// DATABASE_URL at import time. Nothing here connects; a placeholder satisfies
// the validation (same default the api package's vitest config uses).
export default defineConfig({
  test: {
    environment: "node",
    exclude: ["**/node_modules/**", "**/dist/**"],
    env: {
      DATABASE_URL:
        process.env.DATABASE_URL ||
        "postgresql://postgres:synap_dev_password@localhost:5432/synap",
      NODE_ENV: "test",
    },
  },
});
