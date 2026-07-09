import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // No setupFiles for unit tests to avoid DB connection
    setupFiles: [],
    exclude: ["**/node_modules/**", "**/dist/**", "**/__tests__/setup.ts"],
    include: [
      "src/repositories/**/__tests__/*.test.ts",
      "src/__tests__/channel-type-canon.test.ts",
      "src/__tests__/mirror-to-external.test.ts",
      "src/utils/set-channel-branch-purpose.test.ts",
      "src/utils/open-run-session.test.ts",
      "src/conversions/*.test.ts",
      "src/services/identity-resolution-service.test.ts",
    ],
    env: {
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/synap_test", // Dummy URL for config validation
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
    },
  },
});
