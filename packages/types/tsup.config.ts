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
    "src/relations/index.ts", // NEW: Knowledge graph edges
    "src/preferences/index.ts",
    "src/realtime/index.ts",
    "src/events/index.ts",
    "src/proposals/index.ts", // NEW: Universal Proposals
  ],
  format: ["esm"],
  dts: true,
  clean: true,
  external: ["@synap/database", "yjs"],
});
