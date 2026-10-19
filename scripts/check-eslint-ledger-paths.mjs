#!/usr/bin/env node
/**
 * EVERY PATH IN AN ESLINT ALLOWLIST MUST EXIST.
 *
 * eslint.config.mjs carries allowlists (the access-convergence ledger, its
 * unenforced-period debt block, the materializer sites): blocks that turn
 * `no-restricted-syntax` OFF for a hand-listed set of files. ESLint matches
 * `files` silently — a path that no longer exists matches nothing and raises
 * nothing. That is how the ledger rotted between 2026-07 and 2026-10: routers
 * were split into folders, the ledger kept naming the deleted parents, and the
 * split files (with the same raw access) were never listed. Nobody noticed
 * because CI was dark, and a dead entry is invisible even when CI is green.
 *
 * So: every literal (non-glob) path in the `files` of a block that switches
 * `no-restricted-syntax` off must exist. The set is DERIVED from the live
 * config, never a copy of it.
 *
 * Does NOT cover: an entry that exists but no longer needs the exemption (the
 * file stopped doing raw access). Finding those needs a lint run with the
 * allowlist removed; see the ledger header for how it was done on 2026-10-19.
 *
 * Usage: node scripts/check-eslint-ledger-paths.mjs
 */

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { default: config } = await import(
  pathToFileURL(resolve(root, "eslint.config.mjs")).href
);

const GLOB = /[*?{}[\]!]/;
const paths = config
  .filter((block) => block.rules?.["no-restricted-syntax"] === "off")
  .flatMap((block) => block.files ?? [])
  .filter((p) => typeof p === "string" && !GLOB.test(p));

// Non-vacuity: 2026-10-19 the allowlists held 162 literal paths. A config
// reshaped so this filter sees none must fail, not pass.
if (paths.length < 50) {
  console.error(
    `check-eslint-ledger-paths: only ${paths.length} allowlisted paths found — the filter no longer sees the ledger.`
  );
  process.exit(1);
}

const missing = paths.filter((p) => !existsSync(resolve(root, p)));
if (missing.length) {
  console.error(
    `check-eslint-ledger-paths: ${missing.length} allowlisted path(s) do not exist. Remove them from eslint.config.mjs (a split file goes in under its own name):`
  );
  for (const p of missing) console.error(`  ${p}`);
  process.exit(1);
}
console.log(
  `check-eslint-ledger-paths: ${paths.length} allowlisted paths, all present.`
);
