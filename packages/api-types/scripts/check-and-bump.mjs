#!/usr/bin/env node
/**
 * check-and-bump — the `@synap-core/api-types` release gate.
 *
 * Regenerates the router type surface, detects whether it changed versus the
 * committed `src/generated.d.ts`, and — when it did — bumps the package version
 * and keeps every place that hard-codes that version in lock-step:
 *   1. packages/api-types/package.json          → "version"
 *   2. packages/api-types/src/version.ts         → API_TYPES_VERSION
 *   3. apps/api/src/index.ts                      → /health `apiTypesVersion`
 *
 * It NEVER publishes. The founder (or CI) runs `npm publish` afterwards.
 *
 * Usage (from packages/api-types/):
 *   node scripts/check-and-bump.mjs            # regen + diff; bump patch if changed
 *   node scripts/check-and-bump.mjs --minor    # bump minor instead of patch when changed
 *   node scripts/check-and-bump.mjs --major    # bump major (breaking router change)
 *   node scripts/check-and-bump.mjs --check    # CI mode: regen + diff only.
 *                                              #   exit 1 if surface changed but
 *                                              #   version was NOT bumped (drift).
 *   node scripts/check-and-bump.mjs --dry-run  # report what it WOULD do, write nothing
 *
 * Typical flow:
 *   - Locally before release:  node scripts/check-and-bump.mjs [--minor|--major]
 *                              then  npm publish  (from packages/api-types/)
 *   - In CI on every PR:       node scripts/check-and-bump.mjs --check
 *                              fails the build if the router surface drifted
 *                              from the committed generated.d.ts / version.
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_DIR = resolve(__dirname, "..");
const BACKEND_ROOT = resolve(PKG_DIR, "..", "..");
const API_DIR = join(BACKEND_ROOT, "packages", "api");

const GENERATED = join(PKG_DIR, "src", "generated.d.ts");
const PKG_JSON = join(PKG_DIR, "package.json");
const VERSION_TS = join(PKG_DIR, "src", "version.ts");
const HEALTH_TS = join(BACKEND_ROOT, "apps", "api", "src", "index.ts");

const args = new Set(process.argv.slice(2));
const CHECK = args.has("--check");
const DRY_RUN = args.has("--dry-run");
const BUMP_KIND = args.has("--major")
  ? "major"
  : args.has("--minor")
    ? "minor"
    : "patch";

function log(msg) {
  console.log(msg);
}
function fail(msg) {
  console.error(`\n❌ ${msg}`);
  process.exit(1);
}

/** Read the committed generated surface (empty string if absent). */
function readGenerated() {
  return existsSync(GENERATED) ? readFileSync(GENERATED, "utf-8") : "";
}

/** Bump a semver string by kind. Drops any pre-release/build suffix. */
function bumpSemver(version, kind) {
  const core = version.trim().replace(/^v/i, "").split(/[-+]/)[0];
  const parts = core.split(".").map((n) => Number.parseInt(n, 10));
  while (parts.length < 3) parts.push(0);
  let [major, minor, patch] = parts;
  if (parts.some((n) => Number.isNaN(n))) {
    fail(`Cannot parse semver from "${version}".`);
  }
  if (kind === "major") {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (kind === "minor") {
    minor += 1;
    patch = 0;
  } else {
    patch += 1;
  }
  return `${major}.${minor}.${patch}`;
}

/**
 * Regenerate src/generated.d.ts via the api package's existing gen-types
 * pipeline. We do NOT reimplement dts-bundle-generator — single source of truth.
 */
function regenerateTypes() {
  log("🛠  Regenerating router types (api → gen-types)…");
  execSync("pnpm gen-types", {
    cwd: API_DIR,
    stdio: "inherit",
    env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=4096" },
  });
}

function replaceInFile(file, pattern, replacement, label) {
  const before = readFileSync(file, "utf-8");
  if (!pattern.test(before)) {
    fail(`Could not find ${label} to update in ${file}`);
  }
  const after = before.replace(pattern, replacement);
  if (after === before) {
    fail(`No-op replacing ${label} in ${file} (value already current?)`);
  }
  if (!DRY_RUN) writeFileSync(file, after);
  log(`   ${DRY_RUN ? "would update" : "updated"} ${label} in ${file}`);
}

function main() {
  if (!existsSync(API_DIR)) {
    fail(`api package not found at ${API_DIR}`);
  }

  const pkg = JSON.parse(readFileSync(PKG_JSON, "utf-8"));
  const currentVersion = pkg.version;
  log(`📦 @synap-core/api-types current version: ${currentVersion}`);

  const previous = readGenerated();
  regenerateTypes();
  const next = readGenerated();

  const surfaceChanged = previous !== next;

  if (!surfaceChanged) {
    log(
      "✅ Router surface unchanged vs committed generated.d.ts. Nothing to bump."
    );
    return;
  }

  log("⚠️  Router surface CHANGED vs committed generated.d.ts.");

  if (CHECK) {
    fail(
      "Router surface drifted but @synap-core/api-types version was not bumped.\n" +
        "   Run `node scripts/check-and-bump.mjs [--minor|--major]` and commit the\n" +
        "   regenerated generated.d.ts + version bump before merging."
    );
  }

  const nextVersion = bumpSemver(currentVersion, BUMP_KIND);
  log(`⬆️  Bumping (${BUMP_KIND}): ${currentVersion} → ${nextVersion}`);

  // 1. package.json
  if (!DRY_RUN) {
    pkg.version = nextVersion;
    writeFileSync(PKG_JSON, JSON.stringify(pkg, null, 2) + "\n");
  }
  log(`   ${DRY_RUN ? "would update" : "updated"} version in ${PKG_JSON}`);

  // 2. src/version.ts — API_TYPES_VERSION constant
  replaceInFile(
    VERSION_TS,
    /export const API_TYPES_VERSION = "[^"]*";/,
    `export const API_TYPES_VERSION = "${nextVersion}";`,
    "API_TYPES_VERSION"
  );

  // 3. apps/api/src/index.ts — /health apiTypesVersion literal
  replaceInFile(
    HEALTH_TS,
    /apiTypesVersion: "[^"]*",/,
    `apiTypesVersion: "${nextVersion}",`,
    "/health apiTypesVersion"
  );

  log(
    `\n✅ Bumped to ${nextVersion}. Review the diff, commit, then publish:\n` +
      `     cd packages/api-types && npm publish`
  );
}

main();
