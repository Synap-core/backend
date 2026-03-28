import { defineConfig } from "tsup";

export default defineConfig({
  // Node platform so require() of built-ins (e.g. "os" in pino) works when any dep is bundled.
  // peerDependencies (@synap/database, @synap-core/core) are excluded by tsup so pino is not bundled.
  platform: "node",
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
    "src/vault/index.ts",
    "src/notifications/index.ts",
    "src/proactive/index.ts",
  ],
  format: ["esm"],
  dts: false,
  clean: true,
  external: [
    "yjs",
    "@synap/database",
    "@synap-core/core",
    "pino",
    "pino-pretty",
    "os",
    /^node:/,
  ],
});
