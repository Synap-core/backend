import { defineConfig } from "vitest/config";
import { loadEnv } from "vite";
import path from "path";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, path.resolve(__dirname, "../.."), "");

  return {
    test: {
      globals: true,
      environment: "node",
      // `.claude/worktrees/**` — never run stale agent-worktree copies of the
      // suite (they inflate/forge the count). The backend worktree lives above
      // this package's root so it's usually out of scope already; exclude it
      // explicitly so the invariant holds no matter where vitest is invoked.
      exclude: ["**/node_modules/**", "**/dist/**", "**/.claude/worktrees/**"],
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
