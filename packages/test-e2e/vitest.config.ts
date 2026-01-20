/**
 * Vitest Configuration
 */
import { defineConfig } from "vitest/config";
import dotenv from "dotenv";

// Load env vars
dotenv.config({ path: "../../.env.test" });

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    testTimeout: 60000,
    hookTimeout: 60000,
    setupFiles: ["./src/setup.ts"],
  },
});
