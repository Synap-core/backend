#!/usr/bin/env node
/**
 * contracts-publish.mjs — one command to ship the cross-repo contract artifacts
 * and keep every consumer's version pin in lockstep.
 *
 * Kills the contract-drift bug class: backend tRPC / type / hub-protocol changes
 * are invisible to synap-app / synap-intelligence-service until the published
 * artifact is regenerated, version-bumped, and the consumers' pins are updated.
 *
 * Artifacts handled:
 *   1. @synap-core/api-types  → npm publish      (consumed by synap-app + synap-cli)
 *   2. @synap-core/types      → pnpm pack → tgz  (consumed by synap-intelligence-service via file:)
 *   3. @synap-core/hub-protocol → pnpm pack → tgz (consumed by synap-intelligence-service via file:)
 *
 * DRY-RUN by default. Nothing is written, published, or copied without --yes.
 *
 * Usage:
 *   node scripts/contracts-publish.mjs [patch|minor] [--yes]
 *
 * Env:
 *   SYNAP_IS_DIR   intelligence-service repo (default: ../synap-intelligence-service)
 *   SYNAP_APP_DIR  app repo                  (default: ../synap-app)
 *
 * Conventions reused from packages/api/scripts/gen-types.mjs:
 *   - plain node + child_process.execSync, no extra deps
 *   - 4 GB heap for dts-bundle-generator, emoji step logging
 */

import { execSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(__dirname, "..");

// ── argv ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const APPLY = argv.includes("--yes");
const bumpType = argv.find((a) => a === "patch" || a === "minor") ?? "patch";
const DRY = !APPLY;

const SYNAP_IS_DIR = resolve(
  ROOT_DIR,
  process.env.SYNAP_IS_DIR ?? "../synap-intelligence-service"
);
const SYNAP_APP_DIR = resolve(
  ROOT_DIR,
  process.env.SYNAP_APP_DIR ?? "../synap-app"
);

// ── tiny utils ────────────────────────────────────────────────────────────────
const log = (msg) => console.log(msg);
const step = (n, msg) => console.log(`\n${n}  ${msg}`);
const tag = () => (DRY ? "[dry-run]" : "[apply]");
const sub = (msg) => console.log(`     ${msg}`);

function run(cmd, opts = {}) {
  return execSync(cmd, {
    stdio: opts.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    cwd: opts.cwd ?? ROOT_DIR,
    encoding: "utf-8",
    env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=4096" },
  });
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf-8"));
}

function bumpVersion(version, type) {
  const [maj, min, pat] = version.split(".").map((n) => parseInt(n, 10));
  if (type === "minor") return `${maj}.${min + 1}.0`;
  return `${maj}.${min}.${pat + 1}`;
}

function gitClean(relPath) {
  // returns true if the path has NO uncommitted changes
  try {
    const out = execSync(`git status --porcelain -- "${relPath}"`, {
      cwd: ROOT_DIR,
      encoding: "utf-8",
    });
    return out.trim() === "";
  } catch {
    return true;
  }
}

// Replace a "name": "<oldpin>" line for `pkgName` with the new pin, preserving
// the caret/range prefix. Operates on raw JSON text so we never reorder keys or
// disturb adjacent in-flight edits. Returns { text, count }.
function repinJsonText(text, pkgName, newVersion) {
  const escaped = pkgName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // matches: "pkg": "^1.2.3"  /  "pkg": "~1.2.3"  /  "pkg": "1.2.3"
  const re = new RegExp(
    `("${escaped}"\\s*:\\s*")([\\^~]?)\\d+\\.\\d+\\.\\d+(")`,
    "g"
  );
  let count = 0;
  const out = text.replace(re, (_m, pre, range, post) => {
    count += 1;
    return `${pre}${range}${newVersion}${post}`;
  });
  return { text: out, count };
}

// ── header ────────────────────────────────────────────────────────────────────
log("════════════════════════════════════════════════════════════════════");
log(` Synap contracts-publish  ${tag()}  bump=${bumpType}`);
log("════════════════════════════════════════════════════════════════════");
sub(`backend : ${ROOT_DIR}`);
sub(
  `IS      : ${SYNAP_IS_DIR}${existsSync(SYNAP_IS_DIR) ? "" : "  (MISSING)"}`
);
sub(
  `app     : ${SYNAP_APP_DIR}${existsSync(SYNAP_APP_DIR) ? "" : "  (missing — app step skipped)"}`
);

// ─────────────────────────────────────────────────────────────────────────────
// STEP A — regenerate the api-types contract and detect drift
// ─────────────────────────────────────────────────────────────────────────────
const API_TYPES_DIR = join(ROOT_DIR, "packages/api-types");
const GENERATED_REL = "packages/api-types/src/generated.d.ts";
const GENERATED_ABS = join(ROOT_DIR, GENERATED_REL);
const apiTypesPkgFile = join(API_TYPES_DIR, "package.json");

step("A", "Regenerate api-types contract (gen-types) & detect drift");
const generatedWasCleanBefore = gitClean(GENERATED_REL);
sub(`generated.d.ts dirty-before-run: ${!generatedWasCleanBefore}`);

let contractChanged = false;
try {
  run("node scripts/gen-types.mjs", { cwd: join(ROOT_DIR, "packages/api") });
} catch (e) {
  sub(
    `⚠️  gen-types failed/skipped (${e.message ?? e}); continuing with existing generated.d.ts`
  );
}
const generatedCleanAfter = gitClean(GENERATED_REL);
// "contract changed" = regeneration introduced new dirt that wasn't there before.
contractChanged = generatedWasCleanBefore && !generatedCleanAfter;

if (contractChanged) {
  sub("→ contract changed — bump required (this is the normal trigger)");
} else if (!generatedWasCleanBefore && !generatedCleanAfter) {
  sub(
    "→ generated.d.ts was already dirty before this run (pre-existing in-flight edit)"
  );
  sub("  treating as: bump required (proceeding) — review the diff yourself");
  contractChanged = true;
} else {
  sub("→ no contract change");
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP B — bump api-types version + npm publish
// ─────────────────────────────────────────────────────────────────────────────
step("B", "Bump @synap-core/api-types & publish to npm");
const apiTypesPkgRaw = readFileSync(apiTypesPkgFile, "utf-8");
const apiTypesPkg = JSON.parse(apiTypesPkgRaw);
const apiTypesOld = apiTypesPkg.version;
const apiTypesNew = bumpVersion(apiTypesOld, bumpType);
sub(`@synap-core/api-types  ${apiTypesOld} → ${apiTypesNew}`);

if (DRY) {
  sub(
    `${tag()} would set version ${apiTypesNew} in ${GENERATED_REL.replace("src/generated.d.ts", "package.json")}`
  );
  sub(
    `${tag()} pnpm --filter @synap-core/api-types publish --dry-run --no-git-checks`
  );
  try {
    run(
      "pnpm --filter @synap-core/api-types publish --dry-run --no-git-checks"
    );
  } catch (e) {
    sub(`⚠️  publish --dry-run reported: ${e.message ?? e}`);
  }
  sub("(version file untouched in dry-run)");
} else {
  // write bumped version (text-surgical to avoid reordering keys)
  const bumped = apiTypesPkgRaw.replace(
    /("version"\s*:\s*")\d+\.\d+\.\d+(")/,
    `$1${apiTypesNew}$2`
  );
  writeFileSync(apiTypesPkgFile, bumped);
  sub(`✓ wrote version ${apiTypesNew}`);
  run("pnpm --filter @synap-core/api-types build");
  run("pnpm --filter @synap-core/api-types publish --no-git-checks");
  sub(`✓ published @synap-core/api-types@${apiTypesNew}`);
}

// The pin value consumers should adopt (caret form, matches existing convention)
const apiTypesPin = apiTypesNew;

// ─────────────────────────────────────────────────────────────────────────────
// STEP C — pack file:-consumed tgz artifacts → copy into IS → repin file: refs
// ─────────────────────────────────────────────────────────────────────────────
// Each entry: backend workspace package → IS file: consumer.
const TGZ_ARTIFACTS = [
  {
    name: "@synap-core/types",
    dir: "packages/types",
    tgzPrefix: "synap-core-types-",
  },
  {
    name: "@synap-core/hub-protocol",
    dir: "packages/hub-protocol",
    tgzPrefix: "synap-core-hub-protocol-",
  },
];

step(
  "C",
  "Pack tgz artifacts (types, hub-protocol) → copy to IS → repin file: refs"
);
const isPkgFile = join(SYNAP_IS_DIR, "apps/cli/package.json");
const isPkgRel = "apps/cli/package.json";
const isPackagesDir = join(SYNAP_IS_DIR, "packages");
const isHasCli = existsSync(isPkgFile);

if (!existsSync(SYNAP_IS_DIR)) {
  sub(`⚠️  IS repo not found at ${SYNAP_IS_DIR} — skipping tgz step`);
} else if (!isHasCli) {
  sub(`⚠️  ${isPkgRel} not found in IS repo — skipping tgz step`);
}

let isPkgText = isHasCli ? readFileSync(isPkgFile, "utf-8") : null;
const tgzSummary = [];

for (const art of TGZ_ARTIFACTS) {
  const pkgFile = join(ROOT_DIR, art.dir, "package.json");
  if (!existsSync(pkgFile)) {
    sub(`⚠️  ${art.dir} missing — skipping ${art.name}`);
    continue;
  }
  const ver = readJson(pkgFile).version;
  const tgzName = `${art.tgzPrefix}${ver}.tgz`;
  const isRefPath = `file:../../packages/${tgzName}`;
  sub(`${art.name}@${ver} → ${tgzName}`);

  if (DRY) {
    sub(`  ${tag()} pnpm --filter ${art.name} build && pnpm pack`);
    sub(`  ${tag()} copy → ${join("packages", tgzName)} (in IS)`);
    // show superseded tgz that would be removed
    if (existsSync(isPackagesDir)) {
      const stale = readdirSync(isPackagesDir).filter(
        (f) =>
          f.startsWith(art.tgzPrefix) && f.endsWith(".tgz") && f !== tgzName
      );
      for (const s of stale)
        sub(`  ${tag()} would remove superseded: packages/${s}`);
    }
    if (isPkgText) {
      const { count } = repinJsonText(isPkgText, art.name, "__N/A__"); // count only for file: style below
      // file: refs are not semver — detect by name presence
      const hasRef = new RegExp(
        `"${art.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*:\\s*"file:`
      ).test(isPkgText);
      sub(
        `  ${tag()} would set ${isPkgRel}: "${art.name}": "${isRefPath}" ${hasRef ? "(replacing existing file: ref)" : "(no existing file: ref found — review)"}`
      );
    }
    tgzSummary.push({ name: art.name, ver, tgzName, applied: false });
  } else {
    run(`pnpm --filter ${art.name} build`);
    // pnpm pack writes the tgz into the package dir; capture its path from output
    const out = run(
      `pnpm --filter ${art.name} pack --pack-destination "${join(ROOT_DIR, art.dir)}"`,
      { capture: true }
    );
    // resolve produced tgz (pnpm names it <name-without-scope>-<ver>.tgz with scope flattened)
    const producedDir = join(ROOT_DIR, art.dir);
    const produced =
      readdirSync(producedDir).find(
        (f) =>
          f.endsWith(`-${ver}.tgz`) &&
          f.includes(art.tgzPrefix.replace(/-$/, ""))
      ) ?? readdirSync(producedDir).find((f) => f.endsWith(".tgz"));
    if (!produced)
      throw new Error(`pnpm pack produced no tgz for ${art.name}\n${out}`);
    const destTgz = join(isPackagesDir, tgzName);
    copyFileSync(join(producedDir, produced), destTgz);
    unlinkSync(join(producedDir, produced));
    sub(`  ✓ copied → packages/${tgzName} (in IS)`);
    // remove superseded
    if (existsSync(isPackagesDir)) {
      const stale = readdirSync(isPackagesDir).filter(
        (f) =>
          f.startsWith(art.tgzPrefix) && f.endsWith(".tgz") && f !== tgzName
      );
      for (const s of stale) {
        unlinkSync(join(isPackagesDir, s));
        sub(`  ✓ removed superseded: packages/${s}`);
      }
    }
    if (isPkgText) {
      const escaped = art.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`("${escaped}"\\s*:\\s*")file:[^"]*(")`, "g");
      let n = 0;
      isPkgText = isPkgText.replace(re, (_m, pre, post) => {
        n += 1;
        return `${pre}${isRefPath}${post}`;
      });
      sub(`  ✓ repinned ${isPkgRel} (${n} ref${n === 1 ? "" : "s"})`);
    }
    tgzSummary.push({ name: art.name, ver, tgzName, applied: true });
  }
}

if (!DRY && isPkgText && isHasCli) {
  writeFileSync(isPkgFile, isPkgText);
  sub(`✓ wrote ${isPkgRel}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP D — repin api-types in synap-app (deps + catalog + overrides + synap-client)
// ─────────────────────────────────────────────────────────────────────────────
step("D", "Repin @synap-core/api-types in synap-app");
const appTargets = [
  { rel: "package.json", file: join(SYNAP_APP_DIR, "package.json") },
  {
    rel: "packages/synap-client/package.json",
    file: join(SYNAP_APP_DIR, "packages/synap-client/package.json"),
  },
];

if (!existsSync(SYNAP_APP_DIR)) {
  sub(`app repo not present at ${SYNAP_APP_DIR} — step skipped`);
} else {
  for (const t of appTargets) {
    if (!existsSync(t.file)) {
      sub(`⚠️  ${t.rel} not found — skipping`);
      continue;
    }
    const raw = readFileSync(t.file, "utf-8");
    const { text, count } = repinJsonText(
      raw,
      "@synap-core/api-types",
      apiTypesPin
    );
    if (count === 0) {
      sub(`${t.rel}: no @synap-core/api-types pin found`);
      continue;
    }
    if (DRY) {
      sub(
        `${tag()} ${t.rel}: would repin ${count} occurrence${count === 1 ? "" : "s"} → ^${apiTypesPin} (deps/catalog/overrides)`
      );
    } else {
      // preserve existing caret convention: repinJsonText keeps the prefix already present
      writeFileSync(t.file, text);
      sub(
        `✓ ${t.rel}: repinned ${count} occurrence${count === 1 ? "" : "s"} → ${apiTypesPin}`
      );
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP E — next-steps checklist for the human
// ─────────────────────────────────────────────────────────────────────────────
step("E", "Next steps (run these manually)");
log("────────────────────────────────────────────────────────────────────");
if (DRY) {
  log(
    " This was a DRY-RUN. Nothing was published, packed, copied, or written."
  );
  log(" Re-run with --yes to apply:");
  log(`     node scripts/contracts-publish.mjs ${bumpType} --yes`);
  log("");
}
log(" After a real (--yes) run, complete the rollout:");
log("");
log(" 1. backend (this repo):");
log(
  `      - commit packages/api-types (version → ${apiTypesNew} + generated.d.ts)`
);
log(
  `        git add packages/api-types && git commit -m "chore(contracts): api-types@${apiTypesNew}"`
);
log("");
log(" 2. synap-intelligence-service:");
log("      - pnpm install   (picks up the new .tgz file: refs)");
log("      - commit apps/cli/package.json + packages/*.tgz");
for (const a of tgzSummary) log(`        (${a.name} → packages/${a.tgzName})`);
log("");
if (existsSync(SYNAP_APP_DIR)) {
  log(" 3. synap-app:");
  log("      - pnpm install   (resolves the new @synap-core/api-types pin)");
  log(
    `      - commit package.json + packages/synap-client/package.json (api-types → ${apiTypesPin})`
  );
  log("");
}
log("════════════════════════════════════════════════════════════════════");
log(` Done ${tag()} — bump=${bumpType}, api-types target=${apiTypesNew}`);
log("════════════════════════════════════════════════════════════════════");
