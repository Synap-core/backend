import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: {
    resolve: ["@synap/api", "@synap-core/types", "@synap/database", "@synap/events", "@synap/jobs", "@synap/ai"],
  },
  clean: true,
  external: ["postgres", "@trpc/server", "zod", "react", "@trpc/client"],
});
