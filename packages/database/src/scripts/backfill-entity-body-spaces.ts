/**
 * Backfill — file in its entity's space every pod-wide document that is the
 * body of a live entity stored in a space (a part follows its whole, founder
 * decision 22226da5). The rule and what it leaves alone:
 * `utils/file-space-entity-bodies.ts`.
 *
 * DRY RUN BY DEFAULT: prints the counts and writes nothing. Idempotent.
 *
 *   DATABASE_URL=… pnpm --filter @synap/database backfill:entity-body-spaces
 *   DATABASE_URL=… pnpm --filter @synap/database backfill:entity-body-spaces --apply
 */

import { db } from "../client-pg.js";
import { fileSpaceEntityBodies } from "../utils/file-space-entity-bodies.js";

const apply = process.argv.slice(2).includes("--apply");

async function main(): Promise<void> {
  console.log(
    `Backfill: entity bodies follow their entity's space — ${apply ? "APPLY" : "DRY RUN (no writes)"}\n`
  );
  const counts = await fileSpaceEntityBodies(db, { apply });
  console.log(
    `Pod-wide bodies of entities in one space: ${counts.fileable} (${apply ? "filed" : "to file"}: ${apply ? counts.filed : counts.fileable})`
  );
  console.log(
    `Pod-wide bodies of entities in two or more spaces (left pod-wide): ${counts.ambiguous}`
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Backfill failed:", err);
    process.exit(1);
  });
