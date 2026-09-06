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
    // Broad on purpose. A narrow include is how a newly-added suite silently
    // never runs — the __tripwires__ dir was invisible to the first version of
    // this config, so the exit-door tripwire passed by not existing.
    include: ["**/*.test.ts", "**/*.test.tsx"],
    exclude: ["node_modules/**", ".next/**"],
  },
});
