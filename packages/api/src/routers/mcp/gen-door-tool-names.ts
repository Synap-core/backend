/**
 * Generate `door-tool-names.generated.ts` from the three door manifests.
 *
 *   cd packages/api && npx tsx src/routers/mcp/gen-door-tool-names.ts          # write
 *   cd packages/api && npx tsx src/routers/mcp/gen-door-tool-names.ts --check  # exit 1 if stale
 *
 * Reads the SIBLING repos (`synap-control-plane-api`, `synap-raycast`) at
 * generation time only — the pod never imports them at runtime. Regenerate after
 * the pod manifest (`pnpm gen:mcp-manifest`), the CP curated catalog
 * (`gen-pod-tools.ts`) or the Raycast catalog changes.
 *
 * Freshness compares the TABLE VALUE, not file bytes: a formatter reflows the
 * written module, and a byte compare would then read stale forever.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

import {
  buildDoorToolNames,
  renderDoorToolNamesModule,
  type DoorToolNameRow,
} from "./door-tool-names.build.js";

const HERE = dirname(fileURLToPath(import.meta.url));
/** `<monorepo>/synap-backend/packages/api/src/routers/mcp` → `<monorepo>`. */
const MONOREPO = resolve(HERE, "../../../../../..");

export const DOOR_TOOL_NAME_PATHS = {
  podManifest: resolve(HERE, "tools/mcp-tools.manifest.json"),
  cpCurated: resolve(
    MONOREPO,
    "synap-control-plane-api/src/routes/mcp-pod-tools.ts"
  ),
  raycastCatalog: resolve(
    MONOREPO,
    "synap-raycast/scripts/mcp-raycast-catalog.json"
  ),
  generated: resolve(HERE, "door-tool-names.generated.ts"),
} as const;

/** The table a fresh generation would commit, built from the manifests on disk. */
export function buildDoorToolNamesFromManifests(): Record<
  string,
  DoorToolNameRow
> {
  const manifest = JSON.parse(
    readFileSync(DOOR_TOOL_NAME_PATHS.podManifest, "utf8")
  ) as {
    tools: Array<{ name: string }>;
  };
  return buildDoorToolNames({
    podToolNames: manifest.tools.map((t) => t.name),
    cpCuratedSource: readFileSync(DOOR_TOOL_NAME_PATHS.cpCurated, "utf8"),
    raycastCatalog: JSON.parse(
      readFileSync(DOOR_TOOL_NAME_PATHS.raycastCatalog, "utf8")
    ),
  });
}

const invokedDirectly =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const next = buildDoorToolNamesFromManifests();
  if (process.argv.includes("--check")) {
    const { DOOR_TOOL_NAMES } = (await import(
      pathToFileURL(DOOR_TOOL_NAME_PATHS.generated).href
    )) as {
      DOOR_TOOL_NAMES: Record<string, DoorToolNameRow>;
    };
    if (!isDeepStrictEqual(DOOR_TOOL_NAMES, next)) {
      console.error(
        "door-tool-names.generated.ts is STALE — rerun without --check."
      );
      process.exit(1);
    }
    console.log("door-tool-names.generated.ts is fresh.");
  } else {
    writeFileSync(
      DOOR_TOOL_NAME_PATHS.generated,
      renderDoorToolNamesModule(next)
    );
    console.log(`wrote ${DOOR_TOOL_NAME_PATHS.generated}`);
  }
}
