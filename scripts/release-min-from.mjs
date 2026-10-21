#!/usr/bin/env node
/**
 * release-min-from.mjs — the `minFrom` of a release manifest, DERIVED.
 * ===========================================================================
 *
 * Why: a failed `synap update` rolls back IMAGES ONLY (`_ue_rollback` in
 * `synap`), so the release a pod rolls back to runs on the newer schema. A
 * CONTRACT migration (`-- synap:contract-of <expand>.sql`, see
 * check-migrations-forward-only.mjs) is safe on rollback only if the pod
 * already ran a release that shipped its EXPAND step — the release whose code
 * stopped using what the contract removes. A pod older than that, jumping
 * straight to a release carrying the contract, would roll back onto a schema
 * its code cannot run on. So the manifest names a floor:
 *
 *   minFrom         the newest migration (by name) of the newest release that
 *                   first shipped an expand any contract marker in this tree
 *                   names — a pod whose ledger (or running release) is below
 *                   it is refused by the engine;
 *   minFromRelease  that release's tag — what the refusal tells the operator
 *                   to update to first.
 *
 * No marker in the tree → both null, without touching git. A marker naming an
 * expand that no earlier release shipped → exit 2: a manifest is never
 * published with a floor that cannot be right (the forward-only guard refuses
 * such a tree too).
 *
 * Releases are the v* tags (origin's, else local — the guard's own door), in
 * VERSION order, minus --exclude (the release being built). A tag missing from
 * a shallow, tagless CI clone is fetched shallowly.
 *
 * Usage: node scripts/release-min-from.mjs [--repo .] [--exclude <release id>]
 * Prints {"minFrom": …, "minFromRelease": …, "expands": [...]} on stdout.
 * Exit: 0 · 2 cannot derive.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  MIGRATIONS_DIR,
  contractMarkers,
  ensureTagTree,
  releaseTags,
  shippedMigrations,
} from "./check-migrations-forward-only.mjs";

/** The expand files named by any contract marker in the tree, sorted. */
export function markedExpands(repo) {
  const dir = join(repo, MIGRATIONS_DIR);
  const expands = new Set();
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")))
    for (const e of contractMarkers(readFileSync(join(dir, f), "utf8")))
      expands.add(e);
  return [...expands].sort();
}

/**
 * The migrations a release shipped. A release whose (readable) tree has no
 * migrations dir predates it (v1.0.x) and shipped none of these — that is
 * not a failed read, which throws.
 */
function releaseMigrations(repo, ref) {
  const has = (spec) => {
    try {
      execFileSync("git", ["-C", repo, "cat-file", "-e", spec], {
        stdio: "ignore",
      });
      return true;
    } catch {
      return false;
    }
  };
  if (has(`${ref}:${MIGRATIONS_DIR}`)) return shippedMigrations(repo, ref);
  if (has(`${ref}^{tree}`)) return [];
  throw new Error(`cannot read the tree of ${ref}`);
}

/** { minFrom, minFromRelease, expands } — throws when it cannot be derived. */
export function deriveMinFrom(repo, { exclude } = {}) {
  const expands = markedExpands(repo);
  if (expands.length === 0)
    return { minFrom: null, minFromRelease: null, expands };
  const { tags, source } = releaseTags(repo);
  const pending = new Set(expands);
  let floor = null;
  // Oldest → newest: the first release holding an expand is the one that
  // shipped it; the newest such release is the floor.
  for (const tag of tags.filter((t) => t !== exclude)) {
    const shipped = releaseMigrations(repo, ensureTagTree(repo, tag)).sort();
    const found = shipped.filter((f) => pending.has(f));
    if (found.length) {
      floor = { minFrom: shipped.at(-1), minFromRelease: tag };
      for (const f of found) pending.delete(f);
    }
    if (pending.size === 0) break;
  }
  if (pending.size)
    throw new Error(
      `contract-of names ${[...pending].join(", ")}, which no release (${source}${exclude ? `, excluding ${exclude}` : ""}) shipped`
    );
  return { ...floor, expands };
}

if (process.argv[1]?.endsWith("release-min-from.mjs")) {
  const args = process.argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf(name);
    return i === -1 ? undefined : args[i + 1];
  };
  try {
    const r = deriveMinFrom(resolve(opt("--repo") ?? process.cwd()), {
      exclude: opt("--exclude"),
    });
    console.log(JSON.stringify(r));
  } catch (e) {
    console.error(
      `cannot derive minFrom: ${
        String(e.stderr || e.message)
          .trim()
          .split("\n")[0]
      }`
    );
    process.exit(2);
  }
}
