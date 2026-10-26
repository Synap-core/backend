import { defineConfig } from "vitest/config";

// Mirrors packages/api/vitest.config.ts (minus `.env` loading: `vite` is not a
// dependency here). Until 2026-10-26 apps/api had no `test` script, so its
// tests ran nowhere — only its tripwires, picked up by scripts/test-ratchet.mjs.
export default defineConfig({
  test: {
    environment: "node",
    // `.claude/worktrees/**` — never run stale agent-worktree copies of the
    // suite (they inflate/forge the count).
    exclude: ["**/node_modules/**", "**/dist/**", "**/.claude/worktrees/**"],
    env: {
      DATABASE_URL: (
        process.env.DATABASE_URL ||
        "postgresql://postgres:synap_dev_password@localhost:5432/synap"
      ).replace(/^'|'$/g, ""),
      NODE_ENV: "test",
    },
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
