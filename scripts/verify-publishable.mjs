#!/usr/bin/env node
/**
 * Post-publish artifact verification.
 *
 * Downloads the tarball each package ACTUALLY serves from the registry and
 * fails if any dependency range is an unpublishable workspace-local protocol
 * (`workspace:` or `file:`). Those ranges make `npm install` die with
 * EUNSUPPORTEDPROTOCOL for every consumer — the failure mode that silently
 * broke ~70 consecutive `@synap-core/api-types` releases.
 *
 * ⚠️ WHY THIS IS NOT A `prepublishOnly` / `prepack` HOOK:
 * pnpm rewrites `workspace:*` → a real semver range AFTER it runs `prepack`.
 * At that lifecycle point `package.json` still literally reads `workspace:*`
 * even on a perfectly correct release, so a source-manifest self-check
 * false-positives on every legitimate publish. Empirically proven — do not
 * "fix" this by moving the check into a package lifecycle hook.
 *
 * ⚠️ AND WHY IT PACKS FROM THE REGISTRY, NOT FROM DISK:
 * `npm pack <dir>` ships `workspace:*` raw; `pnpm pack <dir>` resolves it. A
 * local pack therefore measures which packer you ran, not what consumers get.
 * `npm pack <name>@<version>` downloads the published artifact — the only
 * ground truth.
 *
 * Usage:
 *   node scripts/verify-publishable.mjs                      # default publish list
 *   node scripts/verify-publishable.mjs packages/types ...   # explicit dirs
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Package dirs (repo-root-relative) this repo's publish workflow ships.
 *
 * This is a POST-publish gate: a package listed here must already exist on the
 * registry at its on-disk version, or the run fails. Add
 * `packages/auth-bootstrap`, `packages/hub-rest-client` and
 * `packages/hub-protocol` here once Wave 1 of SDK-AND-BASE-APP-PLAN.md
 * publishes them (today they have no registry entry at all).
 */
const DEFAULT_PACKAGE_DIRS = ["packages/types", "packages/api-types"];

/** Dependency ranges that cannot survive a publish. */
const FORBIDDEN_PROTOCOLS = ["workspace:", "file:"];

/** Registry propagation is not instantaneous after `pnpm publish`. */
const FETCH_ATTEMPTS = 5;
const FETCH_DELAY_MS = 5000;

const DEP_FIELDS = ["dependencies", "peerDependencies", "optionalDependencies"];

const repoRoot = resolve(import.meta.dirname, "..");
const packageDirs = process.argv.slice(2);
const targets = packageDirs.length > 0 ? packageDirs : DEFAULT_PACKAGE_DIRS;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Download `<name>@<version>` from the registry into `destDir`; return the tarball path. */
async function packFromRegistry(spec, destDir) {
  let lastError;
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt++) {
    try {
      execFileSync(
        "npm",
        ["pack", spec, "--pack-destination", destDir, "--silent"],
        { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" }
      );
      const tarball = readdirSync(destDir).find((f) => f.endsWith(".tgz"));
      if (!tarball) throw new Error("npm pack produced no tarball");
      return join(destDir, tarball);
    } catch (err) {
      lastError = err;
      if (attempt < FETCH_ATTEMPTS) await sleep(FETCH_DELAY_MS);
    }
  }
  throw new Error(
    `could not fetch ${spec} from the registry after ${FETCH_ATTEMPTS} attempts: ` +
      `${lastError?.stderr || lastError?.message || lastError}`
  );
}

/** Read `package/package.json` out of a packed tarball. */
function readPackedManifest(tarballPath) {
  const raw = execFileSync(
    "tar",
    ["-xOf", tarballPath, "package/package.json"],
    {
      encoding: "utf8",
    }
  );
  return JSON.parse(raw);
}

/** Return `["field dep range", ...]` for every forbidden protocol in the manifest. */
function findForbiddenRanges(manifest) {
  const violations = [];
  for (const field of DEP_FIELDS) {
    for (const [dep, range] of Object.entries(manifest[field] ?? {})) {
      if (
        typeof range === "string" &&
        FORBIDDEN_PROTOCOLS.some((p) => range.startsWith(p))
      ) {
        violations.push(`${field}."${dep}": "${range}"`);
      }
    }
  }
  return violations;
}

let failed = false;

for (const dir of targets) {
  const sourceManifestPath = join(repoRoot, dir, "package.json");
  // Source manifest is read ONLY to learn what to fetch — never to validate.
  if (!existsSync(sourceManifestPath)) {
    // Args are package DIRECTORIES (packages/api-types), not names
    // (@synap-core/api-types). Fail with that stated, not a raw ENOENT trace.
    console.error(
      `✗ no package.json at "${dir}" — arguments are package DIRECTORIES relative to the repo root, e.g. "packages/api-types" (not package names).`
    );
    failed = true;
    continue;
  }
  const { name, version } = JSON.parse(
    readFileSync(sourceManifestPath, "utf8")
  );
  const spec = `${name}@${version}`;

  const tmp = mkdtempSync(join(tmpdir(), "synap-verify-publishable-"));
  try {
    const tarball = await packFromRegistry(spec, tmp);
    const packed = readPackedManifest(tarball);
    const violations = findForbiddenRanges(packed);

    if (violations.length > 0) {
      failed = true;
      console.error(`✗ ${spec} — published artifact is uninstallable:`);
      for (const v of violations) console.error(`    ${v}`);
    } else {
      console.log(
        `✓ ${spec} — no workspace:/file: ranges in the published artifact`
      );
    }
  } catch (err) {
    failed = true;
    console.error(`✗ ${spec} — ${err.message}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (failed) {
  console.error(
    "\nPublished artifacts carry workspace-local dependency protocols. " +
      "Publish with `pnpm publish` (it rewrites them); `npm publish` does not."
  );
  process.exit(1);
}

console.log("\nAll published artifacts install cleanly.");
