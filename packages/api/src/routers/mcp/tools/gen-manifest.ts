/**
 * Emits the pod's MCP tool set as a COMMITTED JSON manifest — the canonical
 * artifact `synap-control-plane-api/scripts/gen-pod-tools.ts` reads to
 * regenerate its curated `pod__*` surface (`src/routes/mcp-pod-tools.ts`).
 *
 * `tools/index.ts` (`export const tools`) is the pod's real SSOT; this script
 * only serializes what it already returns — it changes zero pod runtime
 * behavior. `tools.list()` is called with NO ctx, so the result is the base
 * tool set with no per-session teaching brief spliced in (see the `if (!ctx)
 * return toolDefs;` early return in `tools.list`) — deterministic across runs
 * for the same source, which is what a committed diff needs.
 *
 * `instructions` mirrors what `createMCPServer()` (../index.ts) puts on the
 * pod's own live MCP session, MINUS the per-request `grounding` snapshot
 * (a live one-line pod summary resolved per authed user — not something a
 * static manifest can carry).
 *
 * Run: `pnpm --filter @synap/api gen:mcp-manifest`.
 *
 * Output formatting: the raw `JSON.stringify(manifest, null, 2)` does not
 * match this repo's committed style (prettier reflows short arrays like
 * `["query"]` onto one line; `stringify` never does) — running the plain
 * serializer produces a huge, purely-cosmetic diff that buries the real
 * change. So the output is run through prettier itself, using THIS repo's
 * own `.prettierrc.json` (via `resolveConfig`) rather than a hand-matched
 * set of options here that could drift from it.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import prettier from "prettier";
import { tools } from "./index.js";
import { SYNAP_INSTRUCTIONS } from "../index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = resolve(__dirname, "mcp-tools.manifest.json");

async function main() {
  const toolDefs = await tools.list();
  const manifest = {
    tools: toolDefs,
    instructions: SYNAP_INSTRUCTIONS,
  };
  const raw = JSON.stringify(manifest, null, 2) + "\n";
  const config = await prettier.resolveConfig(OUT_PATH);
  const formatted = await prettier.format(raw, {
    ...config,
    parser: "json",
  });
  writeFileSync(OUT_PATH, formatted, "utf8");
  // eslint-disable-next-line no-console
  console.log(`Wrote ${toolDefs.length} tools + instructions to ${OUT_PATH}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
