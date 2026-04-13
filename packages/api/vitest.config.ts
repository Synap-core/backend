import { defineConfig } from "vitest/config";
import { loadEnv } from "vite";
import path from "path";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, path.resolve(__dirname, "../.."), "");

  return {
    test: {
      globals: true,
      environment: "node",
      exclude: ["**/node_modules/**", "**/dist/**"],
      env: {
        DATABASE_URL: (
          process.env.DATABASE_URL ||
          env.DATABASE_URL ||
          "postgresql://postgres:synap_dev_password@localhost:5432/synap"
        ).replace(/^'|'$/g, ""),
        NODE_ENV: "test",
      },
      coverage: {
        provider: "v8",
        reporter: ["text", "json", "html"],
        exclude: ["node_modules/", "dist/", "**/*.test.ts", "**/__tests__/**"],
      },
      testTimeout: 30000,
      hookTimeout: 30000,
    },
  };
});
