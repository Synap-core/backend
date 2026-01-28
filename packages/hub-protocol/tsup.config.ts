import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs", "esm"],
  dts: false,
  splitting: false,
  sourcemap: true,
  clean: true,
  // Bundle internal dependencies so consumers don't need them
  noExternal: ["@synap-core/types"],
  external: ["zod", "drizzle-orm", "drizzle-zod", "@trpc/client"],
});
