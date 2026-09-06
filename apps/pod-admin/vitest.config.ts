import { defineConfig } from "vitest/config";

/**
 * pod-admin's own vitest project.
 *
 * Before 2026-09-05 this file did not exist and the package had no `test`
 * script, so `lib/public-pod-url.test.ts` and `app/open/open-params.test.ts`
 * never ran in CI — and the `typecheck` task resolved to `<NONEXISTENT>`
 * because the script was named `type-check`. The whole app sat outside both
 * repo gates. Keep both script names aligned with `turbo.json`'s task names.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["app/**/*.test.ts", "lib/**/*.test.ts"],
  },
});
