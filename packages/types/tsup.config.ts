import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/entities/index.ts",
    "src/documents/index.ts",
    "src/users/index.ts",
    "src/inbox/index.ts",
    "src/workspaces/index.ts",
    "src/views/index.ts",
    "src/relations/index.ts",
    "src/preferences/index.ts",
    "src/realtime/index.ts",
    "src/events/index.ts",
    "src/proposals/index.ts",
  ],
  format: ["esm"],
  dts: {
    resolve: true,
  },
  clean: true,
  external: ["yjs"],
});
