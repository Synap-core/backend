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
    },
  },
];
