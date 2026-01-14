/**
 * Vitest Configuration for E2E Tests
 */

import { defineConfig } from "vitest/config";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default defineConfig({
  test: {
    name: "e2e",
    globals: true,
    environment: "node",
    include: ["tests/e2e/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    testTimeout: 120000, // 2 minutes for E2E tests
    hookTimeout: 300000, // 5 minutes for setup/teardown
    setupFiles: ["./tests/e2e/setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      exclude: [
        "node_modules/",
        "dist/",
        "tests/",
        "**/*.test.ts",
        "**/__tests__/**",
      ],
    },
  },
  resolve: {
    alias: {
      "@synap-core/core": resolve(__dirname, "../../packages/core/src"),
      "@synap/api": resolve(__dirname, "../../packages/api/src"),
      "@synap/database": resolve(__dirname, "../../packages/database/src"),
      "@synap/domain": resolve(__dirname, "../../packages/domain/src"),
      "@synap/types": resolve(__dirname, "../../packages/types/src"),
      "@synap/auth": resolve(__dirname, "../../packages/auth/src"),
      "@synap/hub-protocol": resolve(
        __dirname,
        "../../packages/hub-protocol/src",
      ),
      "@synap/hub-protocol-client": resolve(
        __dirname,
        "../../packages/hub-protocol-client/src",
      ),
    },
  },
});
