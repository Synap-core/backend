import js from "@eslint/js";

export default [
  {
    files: ["**/*.{ts,tsx}"],
    rules: {
      // Next.js bundles react-hooks plugin but pod-admin doesn't have it as a dep.
      // Disable exhaustive-deps so eslint-disable comments don't throw errors.
      "react-hooks/exhaustive-deps": "off",
    },
  },
  js.configs.recommended,
];
