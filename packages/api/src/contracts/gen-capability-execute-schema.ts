/**
 * Emits the capability-execute input contract as a COMMITTED JSON Schema.
 *
 * The Intelligence Service is pinned to zod 3 and cannot import
 * `contracts/capability-execute.ts` (zod 4). Rather than let it hand-maintain a
 * fourth copy of the same shape — which is how the tRPC door came to declare
 * four of twelve parameters — it consumes THIS artifact, which is generated
 * from the one contract and nothing else.
 *
 * Committed on purpose: a build-time artifact could not be diffed in review,
 * and `capability-execute-schema-freshness.test.ts` is what makes the commit
 * honest — it regenerates in memory and fails when the file has drifted.
 *
 * Run: `pnpm --filter @synap/api gen:capability-schema`.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import prettier from "prettier";
import { buildCapabilityExecuteJsonSchema } from "./capability-execute-schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = resolve(__dirname, "generated/capability-execute.schema.json");

async function main() {
  const raw =
    JSON.stringify(buildCapabilityExecuteJsonSchema(), null, 2) + "\n";
  const config = await prettier.resolveConfig(OUT_PATH);
  const formatted = await prettier.format(raw, { ...config, parser: "json" });
  writeFileSync(OUT_PATH, formatted, "utf8");
  // eslint-disable-next-line no-console
  console.log(`Wrote ${OUT_PATH}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
