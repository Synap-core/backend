import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-plugin-prettier/recommended";
import globals from "globals";

export default [
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/.turbo/**",
      "**/.next/**",
      "**/coverage/**",
      "**/.docusaurus/**",
      "**/.wrangler/**",
      "**/generated.d.ts", // Generated files from Drizzle ORM
      "**/*.generated.ts",
      "**/*.generated.d.ts",
      "**/*.d.ts", // Declaration files (auto-generated, not hand-written)
      "**/.claude/**",
      "**/deploy/pod-agent/**", // Standalone Node.js agent (not part of TS build)
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.es2021,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": [
        "warn",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-empty-object-type": "warn", // Downgrade to warn (generated files use {})
      "no-undef": "off", // TypeScript handles this better
      "no-case-declarations": "warn", // Downgrade to warn (common pattern in switch statements)
      "react-hooks/exhaustive-deps": "off", // Plugin not installed for root (Next.js apps handle this differently)
    },
  },
  // ── Tripwire: raw `entities` inserts must go through the governed materializer ──
  // Direct `db.insert(entities)` / `tx.insert(entities)` bypasses the five
  // invariants owned by `materializeEntity()` (relation-slug guard, dedup,
  // project-link, provenance, completeness). New entity writes MUST funnel
  // through `materializeEntity` (or the `EntityRepository` it wraps). This rule
  // catches new raw inserts at review time.
  {
    files: ["packages/**/*.ts", "packages/**/*.tsx"],
    // Tests + standalone scripts legitimately seed raw rows — the tripwire only
    // governs production write paths.
    ignores: [
      "packages/**/*.test.ts",
      "packages/**/*.spec.ts",
      "packages/**/tests/**",
      "packages/**/__tests__/**",
      "packages/**/scripts/**",
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.property.name='insert'][arguments.0.name='entities']",
          message:
            "Raw `.insert(entities)` bypasses the governed entity materializer. Use `materializeEntity()` from @synap/database (it wraps EntityRepository.create and owns provenance/dedup/project-link/relation-slug invariants). If this is a sanctioned low-level site, add it to the allowlist in eslint.config.mjs.",
        },
      ],
    },
  },
  {
    // Allowlist — sites sanctioned to perform a raw entity insert.
    //   • materialize-entity.ts   — the materializer itself (its physical home).
    //   • entity-repository.ts    — the canonical create the materializer wraps.
    //   • sync-materializer.ts    — replication sink (raw by design; not a create).
    // The remaining entries are Wave-2 HARD sites not yet funneled; they already
    // apply provenance/project-link via their own paths. This list SHRINKS as
    // Wave 2 funnels them through materializeEntity.
    files: [
      "packages/database/src/utils/materialize-entity.ts",
      "packages/database/src/repositories/entity-repository.ts",
      "packages/database/src/utils/sync-materializer.ts",
      // Wave-2 (temporary):
      "packages/api/src/routers/entities.ts",
      "packages/jobs/src/workers/materializer.ts",
      "packages/api/src/routers/capture.ts",
    ],
    rules: {
      "no-restricted-syntax": "off",
    },
  },
];
