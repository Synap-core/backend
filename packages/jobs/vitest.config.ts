import { defineConfig } from "vitest/config";
import { loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  // Load .env.test for test environment
  const env = loadEnv(mode, process.cwd(), "");

  return {
    test: {
      globals: true,
      environment: "node",
      // Only collect tests that live under src/ (covers src/**/__tests__/ and
      // co-located src/**/*.test.ts). Prevents a stale/misplaced top-level file
      // from silently failing collection and rotting the gate.
      include: ["src/**/*.test.ts"],
      exclude: ["**/node_modules/**", "**/dist/**"],
      env: {
        // Ensure environment variables available for tests
        DATABASE_URL:
          env.DATABASE_URL ||
          "postgresql://postgres:postgres@localhost:5432/synap",
        INNGEST_EVENT_KEY: env.INNGEST_EVENT_KEY || "test-event-key",
        INNGEST_SIGNING_KEY: env.INNGEST_SIGNING_KEY || "test-signing-key",
        NODE_ENV: "test",
      },
      coverage: {
        provider: "v8",
        reporter: ["text", "json", "html"],
        exclude: ["node_modules/", "dist/", "**/*.test.ts", "**/tests/**"],
      },
    },
  };
});
