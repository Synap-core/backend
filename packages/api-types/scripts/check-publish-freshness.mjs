#!/usr/bin/env node
/**
 * check-publish-freshness — CI drift tripwire for the PUBLISHED
 * `@synap-core/api-types` tarball (not just the committed source).
 *
 * `pnpm --filter @synap/api gen-types:check` (already wired into ci.yml) only
 * proves the COMMITTED `packages/api-types/src/generated.d.ts` is fresh versus
 * the router source. It says NOTHING about whether that fresh surface ever
 * reached the npm tarball consumers actually `pnpm install` — a `check-and-bump`
 * that ran locally but was never followed by `npm publish` (or a
 * `publish-types.yml` run that failed silently) leaves CI green while every
 * consumer keeps installing a stale package. This closes that gap. Two checks:
 *
 *   1. STALENESS — local `package.json` version is ahead of the published npm
 *      version by more than a trivial in-flight gap. "Too long" is measured as
 *      a PATCH-DISTANCE threshold (`API_TYPES_MAX_PATCH_DRIFT`, default 1),
 *      not wall-clock time: a git-log timestamp check would need a full
 *      (non-shallow) checkout to be reliable, which is not "cheap" for a CI
 *      job that otherwise only needs the working tree. Any un-published
 *      MINOR/MAJOR bump fails immediately (never "grace" — those can carry
 *      breaking surface); a same-minor PATCH gap fails only once it exceeds
 *      the threshold (a single patch ahead is the normal, expected state for
 *      the few minutes between a merge landing and `publish-types.yml`
 *      finishing on the SAME push).
 *
 *   2. CONSUMER RANGE — synap-app's declared `@synap-core/api-types` semver
 *      range (fetched as a single raw-content GET — no full checkout) must
 *      still be satisfied by the currently-PUBLISHED version. If a major/minor
 *      shipped and synap-app's pin was never bumped to follow, this fails
 *      loudly instead of synap-app silently drifting onto the OLD published
 *      contract forever.
 *
 * Network-degradation policy: registry/GitHub unreachable → WARN and skip
 * (never fail CI on a transient network blip); a genuine version/range
 * mismatch → FAIL.
 *
 * Usage: node scripts/check-publish-freshness.mjs   (run from packages/api-types/)
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_DIR = resolve(__dirname, "..");
const PKG_JSON = join(PKG_DIR, "package.json");
const PKG_NAME = "@synap-core/api-types";

const MAX_PATCH_DRIFT = Number(process.env.API_TYPES_MAX_PATCH_DRIFT ?? 1);
const SYNAP_APP_REPO = process.env.SYNAP_APP_REPO ?? "Synap-core/first-app";
const SYNAP_APP_BRANCH = process.env.SYNAP_APP_BRANCH ?? "main";
const SYNAP_APP_TOKEN = process.env.CROSS_REPO_TOKEN;

let hadFailure = false;

function fail(msg) {
  console.error(`\n❌ ${msg}`);
  hadFailure = true;
}
function warn(msg) {
  console.warn(`⚠️  ${msg}`);
}
function log(msg) {
  console.log(msg);
}

function localVersion() {
  return JSON.parse(readFileSync(PKG_JSON, "utf-8")).version;
}

function parseSemver(v) {
  const [major, minor, patch] = v
    .trim()
    .replace(/^v/i, "")
    .split(".")
    .map((n) => Number.parseInt(n, 10));
  return { major, minor, patch };
}

function publishedVersion() {
  try {
    return execSync(`npm view ${PKG_NAME} version`, {
      encoding: "utf-8",
    }).trim();
  } catch (err) {
    warn(
      `Could not reach the npm registry for ${PKG_NAME} — skipping the staleness ` +
        `check (${err.message}).`
    );
    return null;
  }
}

/** True iff `version` satisfies `range`, via the `semver` CLI (npx-fetched —
 * not added as a repo dependency, this script is the only caller). */
function satisfiesRange(version, range) {
  try {
    execSync(`npx --yes semver@7 "${version}" -r "${range}"`, {
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

async function checkSynapAppRange(publishedVer) {
  const url = `https://raw.githubusercontent.com/${SYNAP_APP_REPO}/${SYNAP_APP_BRANCH}/package.json`;
  let res;
  try {
    res = await fetch(url, {
      headers: SYNAP_APP_TOKEN
        ? { Authorization: `token ${SYNAP_APP_TOKEN}` }
        : {},
    });
  } catch (err) {
    warn(`synap-app range check skipped — fetch failed (${err.message}).`);
    return;
  }
  if (!res.ok) {
    warn(
      `synap-app range check skipped — could not fetch ${url} (HTTP ${res.status}). ` +
        `Set CROSS_REPO_TOKEN if ${SYNAP_APP_REPO} is private.`
    );
    return;
  }
  const pkg = await res.json();
  const range =
    pkg.dependencies?.[PKG_NAME] ??
    pkg.devDependencies?.[PKG_NAME] ??
    pkg.pnpm?.overrides?.[PKG_NAME];
  if (!range) {
    warn(
      `synap-app range check skipped — ${SYNAP_APP_REPO}'s package.json does not ` +
        `declare ${PKG_NAME}.`
    );
    return;
  }
  if (!satisfiesRange(publishedVer, range)) {
    fail(
      `synap-app pins ${PKG_NAME}@"${range}" — the currently-PUBLISHED ${publishedVer} ` +
        `does NOT satisfy that range.\n` +
        `   Either synap-app's pin is stale (bump it to follow the new release) or a ` +
        `breaking version shipped without warning consumers.`
    );
    return;
  }
  log(
    `✅ synap-app's ${PKG_NAME}@"${range}" is satisfied by published ${publishedVer}.`
  );
}

async function main() {
  const local = localVersion();
  log(`📦 local ${PKG_NAME} version: ${local}`);

  const published = publishedVersion();
  if (published) {
    log(`📦 published ${PKG_NAME} version: ${published}`);
    if (local === published) {
      log(`✅ local matches published — nothing pending.`);
    } else {
      const l = parseSemver(local);
      const p = parseSemver(published);
      if (
        l.major < p.major ||
        (l.major === p.major && l.minor < p.minor) ||
        (l.major === p.major && l.minor === p.minor && l.patch < p.patch)
      ) {
        fail(
          `local ${PKG_NAME} version ${local} is BEHIND the published ${published}.\n` +
            `   This should never happen — pull main, or check for an out-of-band publish.`
        );
      } else if (l.major !== p.major || l.minor !== p.minor) {
        fail(
          `${PKG_NAME} has an un-published MAJOR/MINOR bump: local ${local} vs published ` +
            `${published}. publish-types.yml did not ship it — check its last run, or publish ` +
            `manually: cd packages/api-types && npm publish.`
        );
      } else {
        const patchDrift = l.patch - p.patch;
        log(
          `ℹ️  local is ${patchDrift} patch(es) ahead of published (same major.minor).`
        );
        if (patchDrift > MAX_PATCH_DRIFT) {
          fail(
            `${PKG_NAME} package.json (${local}) is ${patchDrift} patches ahead of published ` +
              `${published} — over the ${MAX_PATCH_DRIFT}-patch grace threshold. ` +
              `publish-types.yml did not ship it (or failed repeatedly). Check its last run, ` +
              `or publish manually: cd packages/api-types && npm publish.`
          );
        }
      }
    }
    await checkSynapAppRange(published);
  }

  if (hadFailure) process.exit(1);
}

main();
