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
import { setTimeout as sleep } from "node:timers/promises";
import { readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { behindVerdict, satisfiesRange } from "./semver-range.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_DIR = resolve(__dirname, "..");
const PKG_JSON = join(PKG_DIR, "package.json");
const PKG_NAME = "@synap-core/api-types";

const MAX_PATCH_DRIFT = Number(process.env.API_TYPES_MAX_PATCH_DRIFT ?? 1);
const SYNAP_APP_REPO = process.env.SYNAP_APP_REPO ?? "Synap-core/first-app";
const SYNAP_APP_BRANCH = process.env.SYNAP_APP_BRANCH ?? "main";
const SYNAP_APP_TOKEN = process.env.CROSS_REPO_TOKEN;
// A checkout BEHIND npm: how long to wait for publish-types.yml's bump commit
// to reach main before calling it drift (it publishes, then pushes the bump).
const MAIN_BRANCH = process.env.BACKEND_MAIN_BRANCH ?? "main";
const MAIN_WAIT_ATTEMPTS = Number(
  process.env.API_TYPES_MAIN_WAIT_ATTEMPTS ?? 6
);
const MAIN_WAIT_MS = 20_000;

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

/**
 * This package's version at main's head, read fresh: a `git fetch` of main,
 * never a raw-content URL (its CDN caches for minutes, longer than the race
 * this reads). null when it cannot be read.
 */
function mainHeadVersion() {
  try {
    execSync(`git fetch --quiet --depth=1 origin ${MAIN_BRANCH}`, {
      cwd: PKG_DIR,
      stdio: "ignore",
      timeout: 60_000,
    });
    const body = execSync(
      "git show FETCH_HEAD:packages/api-types/package.json",
      { cwd: PKG_DIR, encoding: "utf-8" }
    );
    return JSON.parse(body).version;
  } catch (err) {
    warn(
      `could not read ${PKG_NAME}'s version at main's head (${err.message}).`
    );
    return null;
  }
}

/**
 * Local is behind npm. Drift only when MAIN is behind npm too (behindVerdict):
 * a run on an earlier main commit that overlaps a publish sees this with
 * nothing wrong. Waits up to MAIN_WAIT_ATTEMPTS reads for the publish's bump
 * commit; an unreadable main head stays a failure, as before this read.
 */
async function checkBehindPublished(local, published) {
  for (let attempt = 1; ; attempt++) {
    const head = mainHeadVersion();
    const verdict = behindVerdict(published, head);
    if (verdict === "main-moved-on") {
      log(
        `ℹ️  local ${local} is behind published ${published}, but main's head is at ${head}: ` +
          `this run predates the publish's bump commit. Not drift.`
      );
      return;
    }
    if (verdict === null || attempt >= MAIN_WAIT_ATTEMPTS) {
      fail(
        `local ${PKG_NAME} version ${local} is BEHIND the published ${published}, and main's ` +
          `head is at ${head ?? "(unread)"}.\n` +
          `   npm is ahead of main: check for an out-of-band publish.`
      );
      return;
    }
    log(
      `main's head is at ${head}, behind published ${published}: the publish may be about ` +
        `to push its bump; reading main again in ${MAIN_WAIT_MS / 1000} s ` +
        `(${attempt}/${MAIN_WAIT_ATTEMPTS}).`
    );
    await sleep(MAIN_WAIT_MS);
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
  const verdict = satisfiesRange(publishedVer, range);
  if (verdict === null) {
    fail(
      `could not evaluate synap-app's ${PKG_NAME}@"${range}" against ${publishedVer} ` +
        `(a range form scripts/semver-range.mjs does not read). Teach it the form; ` +
        `an unevaluated range is never reported as satisfied or unsatisfied.`
    );
    return;
  }
  if (!verdict) {
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
        await checkBehindPublished(local, published);
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
