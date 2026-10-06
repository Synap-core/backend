#!/usr/bin/env node
/**
 * check.mjs — the CI/CD conformance gate.
 *
 * Enforces the shared invariants across every repo, WITHOUT prescribing a single
 * file layout. Each repo's workflows legitimately differ (synap-app versions via
 * changesets, the backend has drift-gated conditional publish steps, the CLI is a
 * single package). Forcing them through one generated template would destroy that
 * — a linear template cannot express conditional or id-gated steps.
 *
 * So "one shared config" here is a set of RULES every publisher must satisfy,
 * checked automatically, not a generated file. That keeps each workflow honest
 * without flattening the ones that need to be complex.
 *
 * The rules (each has broken this repo at least once):
 *   1. A workflow that publishes must NOT pass `version:` to pnpm/action-setup
 *      when the repo pins `packageManager` (dual-pin ⇒ setup fails).
 *   2. A workflow that publishes must set `id-token: write` (Trusted Publishing).
 *   3. A publish workflow's concurrency must not use `cancel-in-progress: true`
 *      (a cancelled publish can leave a version half-uploaded).
 *   4. A publish workflow must not read the secret as `NPM_TOKEN:` on a step that
 *      runs npm/pnpm (npm ignores NPM_TOKEN; the correct var is NODE_AUTH_TOKEN).
 *   5. No package name may be published from two different repos.
 *   6. synap-app's changeset `ignore` list must cover every public package, except
 *      those explicitly excused in ci/repos.yml.
 *
 * Usage:
 *   node ci/scripts/check.mjs           # full gate (use in CI)
 *   node ci/scripts/check.mjs --quiet   # only failures
 */

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { dirname, resolve, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CI_DIR = resolve(__dirname, "..");
// ci/ lives inside synap-backend (its natural home — that repo owns
// publish-types.yml), so the workspace root is TWO levels up from here, not one.
const ROOT = resolve(CI_DIR, "../..");
// --quiet is for CI logs: print only what needs a human (failures, warnings,
// one summary line). Section headers, ✓ passes and the open-conflict essay are
// noise there. `--quiet` does NOT suppress failures — that would make a green
// build indistinguishable from a broken scan.
const QUIET = process.argv.includes("--quiet") || process.argv.includes("-q");

let parseYaml;
try {
  parseYaml = createRequire(join(ROOT, "noop.js"))("yaml").parse;
} catch {
  console.error("ci/scripts/check.mjs needs the `yaml` package on NODE_PATH.");
  process.exit(2);
}

// Colour only when a human is watching. Honour the NO_COLOR convention
// (https://no-color.org) and drop escapes entirely when stdout is not a TTY, so
// `check.mjs > log` and CI log capture do not accumulate raw escape bytes.
// Severity survives either way: ✓ / ! / ✗ are distinct glyphs, not colours.
const COLOR = process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== "dumb";
const G = COLOR ? "\x1b[32m" : "", R = COLOR ? "\x1b[31m" : "",
      Y = COLOR ? "\x1b[33m" : "", D = COLOR ? "\x1b[2m" : "",
      B = COLOR ? "\x1b[1m" : "", X = COLOR ? "\x1b[0m" : "";
let failures = 0;
const fail = (m) => { failures++; console.log(`${R}✗${X} ${m}`); };
const pass = (m) => { if (!QUIET) console.log(`${G}✓${X} ${m}`); };
const warn = (m) => console.log(`${Y}!${X} ${m}`);

const manifest = parseYaml(readFileSync(join(CI_DIR, "repos.yml"), "utf8"));

// Workflows that can publish to npm (name or content indicates a publish path).
const PUBLISH_HINT = /publish|release|changeset|ship/i;
// A step that publishes a PACKAGE TO THE NPM REGISTRY.
//
// Must not match `electron-builder --publish always`, which uploads a desktop
// binary to GitHub Releases and has nothing to do with npm. That command
// previously tripped this rule and produced a false "publishes but no id-token"
// warning on browser-release.yml. The lookbehind excludes `--publish` (a flag);
// a real publish has a space, a pipe, or the start of the command before it.
const NPM_PUBLISH_CMD =
  /(?<![-\w])(?:pnpm|npm|yarn|bun)\b[^#\n]*?(?<![-\w])publish\b|\bpnpm\s+run\s+release\b|\bchangeset\s+publish\b/i;
const isPublishStep = (s) => {
  const cmd = s?.run ?? "";
  if (typeof cmd === "string" && NPM_PUBLISH_CMD.test(cmd) && !/--dry-run|dry.run/i.test(cmd))
    return true;
  return /changesets\/action/.test(s?.uses ?? ""); // version+publish via the action
};

function workflowFiles(repo) {
  const dir = join(ROOT, repo, ".github", "workflows");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .map((f) => ({ name: f, path: join(dir, f), raw: readFileSync(join(dir, f), "utf8") }));
}

if (!QUIET) console.log(`\n${B}Synap CI/CD conformance${X}`);

// ── Per-repo workflow rules ──────────────────────────────────────────────────
const SKIP = new Set(["node_modules", ".git", "dist", ".next", ".turbo", "build",
  ".claude", ".worktrees", ".eas-snapshot", "coverage", ".dist-staging"]);

// Scan EVERY repo that ships a workflow, not only the ones listed in the
// manifest. An earlier version iterated manifest.repos and therefore never
// looked at `browser/` — where a live pnpm dual-pin blocker was sitting,
// undetected. A gate that only checks what someone remembered to register is
// a gate that misses exactly the thing you forgot.
function isWorktreeDir(dir) {
  try { return statSync(join(dir, ".git")).isFile(); } catch { return false; }
}
const WORKFLOW_REPOS = readdirSync(ROOT, { withFileTypes: true })
  .filter((e) => e.isDirectory() && !SKIP.has(e.name) && e.name.charAt(0) !== "."
    && existsSync(join(ROOT, e.name, ".github", "workflows")))
  .map((e) => e.name)
  .filter((r) => !isWorktreeDir(join(ROOT, r)));

function packageManagerPinned(repo) {
  try {
    return !!parseYaml(readFileSync(join(ROOT, repo, "package.json"), "utf8"))?.packageManager;
  } catch { return false; }
}

// Non-vacuity guard. Every rule below filters over a scanned set. If that set is
// empty the filters all pass vacuously and the gate reports green while checking
// nothing — the worst possible failure for a guard. Prove the scan saw something
// before trusting any "✓ no issues" below.
if (!WORKFLOW_REPOS.length) {
  fail(`no repo with .github/workflows was found under ${ROOT} — the scan is ` +
    `vacuous, not passing`);
} else if (!QUIET) {
  pass(`scanned ${WORKFLOW_REPOS.length} repo(s) with workflows`);
}

for (const repo of WORKFLOW_REPOS) {
  const wfs = workflowFiles(repo);
  if (!wfs.length) continue;
  const pmPinned = packageManagerPinned(repo);
  if (!QUIET) console.log(`\n${D}── ${repo} ──${X}`);

  for (const wf of wfs) {
    let doc; try { doc = parseYaml(wf.raw); } catch (e) {
      fail(`${wf.name} — invalid YAML: ${e.message}`); continue;
    }
    const jobs = doc?.jobs ?? {};
    const steps = Object.values(jobs).flatMap((j) => j?.steps ?? []);
    const publishes = steps.some(isPublishStep);

    // 1. dual pnpm pin — check EVERY pnpm/action-setup step, not just the first.
    //    browser-release.yml had three separate ones; checking only the first
    //    would have reported a clean file while two stayed broken.
    const pnpmSteps = steps.filter((s) => /pnpm\/action-setup/.test(s?.uses ?? ""));
    const dualPinned = pnpmSteps.filter((s) => s?.with?.version);
    if (dualPinned.length && pmPinned) {
      fail(`${wf.name} — ${dualPinned.length} pnpm/action-setup step(s) pass 'version:' ` +
        `(${dualPinned.map((s) => s.with.version).join(", ")}) AND the repo pins ` +
        `packageManager ⇒ setup fails ("Multiple versions of pnpm specified")`);
    } else if (publishes && pnpmSteps.length) {
      pass(`${wf.name} — pnpm version sourced from packageManager (no dual pin)`);
    }

    // 2. id-token for publishing
    if (publishes) {
      const perms = Object.values(jobs).map((j) => j?.permissions ?? {}).find((p) => p["id-token"] === "write")
        ?? doc?.permissions;
      if (perms?.["id-token"] === "write") pass(`${wf.name} — id-token: write set for Trusted Publishing`);
      else warn(`${wf.name} — publishes but no id-token: write (needed for Trusted Publishing)`);
    }

    // 3. concurrency must not cancel a publish
    const conc = doc?.concurrency;
    if (publishes) {
      if (!conc) warn(`${wf.name} — no concurrency block (concurrent publishes can race)`);
      else if (conc["cancel-in-progress"] === true)
        fail(`${wf.name} — concurrency.cancel-in-progress: true can cancel a publish mid-flight`);
      else pass(`${wf.name} — publish concurrency does not cancel`);
    }

    // 4. NPM_TOKEN used as an auth var on a real publish step. Check BOTH the
    //    step-level env AND the workflow-level env — a workflow-level
    //    `env: NPM_TOKEN` is inherited by every step, so it is just as broken.
    if (publishes) {
      const wfEnv = doc?.env ?? {};
      if (wfEnv.NPM_TOKEN !== undefined) {
        fail(`${wf.name} — workflow-level env sets NPM_TOKEN; npm reads NODE_AUTH_TOKEN ` +
          `(NPM_TOKEN is ignored ⇒ anonymous publish ⇒ misleading E404)`);
      }
      for (const s of steps) {
        if ((s?.env ?? {}).NPM_TOKEN !== undefined && isPublishStep(s)) {
          fail(`${wf.name} — step "${s.name ?? "(unnamed)"}" uses env NPM_TOKEN; npm reads ` +
            `NODE_AUTH_TOKEN (NPM_TOKEN is ignored ⇒ anonymous publish ⇒ misleading E404)`);
        }
      }
    }
  }
}

// ── 5. cross-repo name collisions ────────────────────────────────────────────
if (!QUIET) console.log(`\n${D}── cross-repo package names ──${X}`);
// Scan every real repo on disk. A name collision can be introduced by a repo
// that does not itself publish via this gate.
//
// Git worktrees are EXCLUDED: they are the same package at an older commit, not
// a second publisher. Detected structurally — a worktree's `.git` is a FILE
// containing `gitdir: …/worktrees/<name>`, whereas a real repo's is a DIRECTORY.
// Hardcoding worktree names would rot the moment someone creates a new one.
function isWorktree(dir) {
  try { return statSync(join(dir, ".git")).isFile(); } catch { return false; }
}
// Dot-directories and non-repo scratch trees are never publishers.
const NON_REPOS = new Set([".eas-snapshot", ".vercel", "node_modules", "components", "typo"]);
const ALL_REPOS = readdirSync(ROOT, { withFileTypes: true })
  .filter((e) => e.isDirectory() && !SKIP.has(e.name) && !NON_REPOS.has(e.name)
    && existsSync(join(ROOT, e.name, "package.json")))
  .map((e) => e.name)
  .filter((r) => !isWorktree(join(ROOT, r)));
const byName = new Map();
for (const repo of ALL_REPOS) {
  const walk = (d, depth) => {
    if (depth > 4) return;
    let es; try { es = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      if (SKIP.has(e.name)) continue;
      const f = join(d, e.name);
      if (e.isDirectory()) walk(f, depth + 1);
      else if (e.name === "package.json") {
        try {
          const j = JSON.parse(readFileSync(f, "utf8"));
          if (j.private || !j.name) continue;
          if (!byName.has(j.name)) byName.set(j.name, []);
          // `dir` is relative to the workspace root (e.g. "synap-app/apps/hub"),
          // and is what lets rule 6 decide whether changesets can reach a package.
          byName.get(j.name).push({ repo, version: j.version, dir: relative(ROOT, d) });
        } catch {}
      }
    }
  };
  walk(join(ROOT, repo), 0);
}

// Same non-vacuity argument for the package scan: rules 5 and 6 filter over
// `byName`. Zero entries means both rules pass while examining nothing.
if (!byName.size) {
  fail(`no public packages discovered under ${ROOT} — the package-name scan is ` +
    `vacuous, not passing`);
} else if (!QUIET) {
  pass(`scanned ${byName.size} distinct public package name(s)`);
}
/**
 * Does this repo actually publish <name> to npm? Decided locally, no network —
 * a CI gate must not depend on registry availability. A repo counts as a
 * publisher of a package if it has an npm publish workflow AND the package is
 * not private. hestia-cli's vendored chat-ui fails the first test (its workflow
 * ships GitHub release assets, never `npm publish`), so it is correctly treated
 * as a source copy rather than a second publisher.
 */
const repoPublishesNpm = new Map();
function actuallyPublishedOnNpm(name, repo) {
  const key = `${repo}::${name}`;
  if (repoPublishesNpm.has(key)) return repoPublishesNpm.get(key);
  let result = false;
  try {
    const dir = join(ROOT, repo, ".github", "workflows");
    if (existsSync(dir)) {
      for (const f of readdirSync(dir).filter((x) => /\.ya?ml$/.test(x))) {
        const doc = parseYaml(readFileSync(join(dir, f), "utf8"));
        const steps = Object.values(doc?.jobs ?? {}).flatMap((j) => j?.steps ?? []);
        if (steps.some(isPublishStep)) { result = true; break; }
      }
    }
  } catch {}
  repoPublishesNpm.set(key, result);
  return result;
}

let collisions = 0;
for (const [name, hits] of byName) {
  const repos = [...new Set(hits.map((h) => h.repo))];
  if (repos.length <= 1) continue;
  // A collision only bites if MORE THAN ONE copy actually reaches npm. If the
  // second copy is a source tree that is never published (e.g. hestia-cli's
  // vendored chat-ui, whose workflow ships GitHub release assets, not npm), the
  // risk is latent confusion, not a broken `latest` tag.
  const published = hits.filter((h) => actuallyPublishedOnNpm(name, h.repo));
  if (published.length > 1) {
    collisions++;
    fail(`${name}: ${published.length} published copies — ` +
      published.map((h) => `${h.repo}@${h.version}`).join(", ") +
      " (whoever publishes last owns `latest`)");
  } else {
    warn(`${name} exists in ${repos.length} repos (${repos.join(", ")}) but only ` +
      `${published.length === 0 ? "none" : published[0].repo} reaches npm — ` +
      "record it in ci/repos.yml open_conflicts to stop it becoming real");
  }
}
if (!collisions) pass("no package name is published from more than one repo");

// ── 6. changeset ignore coverage ─────────────────────────────────────────────
if (!QUIET) console.log(`\n${D}── changeset ignore coverage ──${X}`);
const cfgPath = join(ROOT, "synap-app", ".changeset", "config.json");
if (!existsSync(cfgPath)) warn("synap-app/.changeset/config.json not found — skipped");
else {
  const ignore = new Set(parseYaml(readFileSync(cfgPath, "utf8")).ignore ?? []);
  const excused = new Map((manifest.changeset_exceptions ?? [])
    .map((e) => [e.package, e.reason ?? ""]));
  const uncovered = [...byName.entries()]
    .filter(([n, hits]) => hits.some((h) => h.repo === "synap-app") && !ignore.has(n) && !excused.has(n))
    .map(([n]) => n);
  if (uncovered.length)
    fail("public synap-app package(s) neither ignored nor excused (changesets would " +
      "publish them with no decision): " + uncovered.join(", "));
  else pass("every public synap-app package is ignored or explicitly excused");

  // A `changeset_exceptions` entry is DOCUMENTATION, not enforcement. changesets
  // only obeys the `ignore` list. So an excused package that is still reachable
  // by the workspace globs stays publishable by changesets: the moment anyone
  // writes a changeset naming it, both doors publish and `latest` is a race.
  // Packages outside every workspace glob cannot be versioned by changesets at
  // all, so for those the exception is genuinely sufficient.
  const wsGlobs = parseYaml(readFileSync(join(ROOT, "synap-app", "pnpm-workspace.yaml"), "utf8"))
    .packages ?? [];
  const globRe = (g) =>
    new RegExp("^" + g.replace(/\./g, "\\.").replace(/\//g, "\\/").replace(/\*/g, "[^/]*") + "$");
  // Returns the matching glob, or null if the package is outside all of them.
  const workspaceGlobFor = (n) => {
    const rel = (byName.get(n).find((h) => h.repo === "synap-app")?.dir ?? "")
      .replace(/^synap-app\/?/, "");
    return wsGlobs.find((g) => globRe(g).test(rel)) ?? null;
  };
  // An excused package falls into one of two opposite classes, and guessing wrong
  // breaks releases in opposite directions:
  //
  //   A. "Another door owns this" (e.g. released by a bespoke script). It MUST be
  //      in `ignore`, or a changeset naming it would publish it a second time.
  //   B. "changesets owns this one" — the PUBLISHABLE allowlist in
  //      synap-app/scripts/sync-changeset-ignore.mjs. It MUST NOT be in `ignore`;
  //      the generator filters allowlisted packages OUT of the list, so adding one
  //      by hand silently disables its release.
  //
  // Class B is identified by the generator, not by prose. If the generator is
  // missing we cannot tell them apart, so say so instead of guessing.
  const genPath = join(ROOT, "synap-app", "scripts", "sync-changeset-ignore.mjs");
  let allowlist = null;
  if (existsSync(genPath)) {
    const src = readFileSync(genPath, "utf8");
    const m = src.match(/const\s+PUBLISHABLE\s*=\s*\[([^\]]*)\]/);
    if (m) allowlist = new Set([...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]));
  }

  for (const [n] of excused) {
    if (!byName.has(n)) continue;             // not a public package here
    if (allowlist && allowlist.has(n)) {
      // Class B — being absent from `ignore` is the CORRECT state.
      if (ignore.has(n))
        fail(`${n} is in sync-changeset-ignore.mjs PUBLISHABLE but also in the changeset ` +
          `ignore list ⇒ changesets will never version it. Re-run: ` +
          `node synap-app/scripts/sync-changeset-ignore.mjs`);
      else pass(`${n} is allowlisted for changesets and correctly absent from ignore`);
      continue;
    }
    if (ignore.has(n)) continue;              // class A, actually enforced — fine
    const glob = workspaceGlobFor(n);
    if (glob) {
      warn(`${n} is excused in ci/repos.yml but NOT in the changeset ignore list, and it IS ` +
        `inside the pnpm workspace (glob "${glob}") ⇒ a changeset naming it would publish it ` +
        `via BOTH doors. Add it to the ignore list (regenerate with ` +
        `node synap-app/scripts/sync-changeset-ignore.mjs).`);
    } else {
      pass(`${n} excused — outside every pnpm-workspace glob, so changesets cannot version it`);
    }
  }
}

// ── 7. single-home packages ──────────────────────────────────────────────────
if (!QUIET) console.log(`\n${D}── single-home packages ──${X}`);
// Rule 5 only fails when TWO copies reach npm, and only sees public packages.
// That let @synap-core/control-plane-types live in two repos for months: same
// name, drifting content, browser compiling against one copy and relay against
// the other. A name listed in `single_home` must be declared by exactly ONE
// package.json on disk — public or private, any depth, any repo — at its home.
//
// The scan set is DERIVED: every top-level directory under ROOT (not only the
// ones with a root package.json — a stray copy can sit in any tree), minus
// dot-directories, NON_REPOS and git worktrees (detected structurally at every
// level, so an agent worktree nested inside a repo is not a second copy).
// WHAT THIS CANNOT SEE: a home whose repo is not checked out beside this one
// (e.g. this repo's own CI) — that is reported as a warning, never as a pass.
const singleHome = manifest.single_home ?? [];
if (singleHome.length) {
  const wanted = new Map(singleHome.map((e) => [e.package, []]));
  let manifestsRead = 0;
  const scan = (d, depth) => {
    if (depth > 6) return;
    let es; try { es = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      if (SKIP.has(e.name)) continue;
      const f = join(d, e.name);
      if (e.isDirectory()) {
        if (e.name.charAt(0) === "." || isWorktree(f)) continue;
        scan(f, depth + 1);
      } else if (e.name === "package.json") {
        manifestsRead++;
        try {
          const name = JSON.parse(readFileSync(f, "utf8")).name;
          if (wanted.has(name)) wanted.get(name).push(relative(ROOT, d));
        } catch {}
      }
    }
  };
  for (const e of readdirSync(ROOT, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.charAt(0) === "." || SKIP.has(e.name) || NON_REPOS.has(e.name)) continue;
    const top = join(ROOT, e.name);
    if (isWorktree(top)) continue;
    scan(top, 1);
  }
  // Non-vacuity: a walk that read almost nothing proves nothing.
  if (manifestsRead < 50) {
    fail(`single-home scan read only ${manifestsRead} package.json file(s) under ${ROOT} — ` +
      `vacuous, not passing`);
  } else {
    pass(`single-home scan read ${manifestsRead} package.json file(s)`);
  }
  for (const { package: name, home } of singleHome) {
    const found = wanted.get(name);
    const homeRepo = home.split("/")[0];
    if (!existsSync(join(ROOT, homeRepo))) {
      warn(`${name}: home repo ${homeRepo}/ is not checked out under ${ROOT} — cannot check`);
      continue;
    }
    if (found.length === 1 && found[0] === home) {
      pass(`${name} has one home: ${home}`);
    } else if (!found.includes(home)) {
      // The self-check: the scan must see the copy it knows exists.
      fail(`${name}: expected at ${home}, found ${found.length ? found.join(", ") : "nowhere"} ` +
        `— the home moved or the scan went blind`);
    } else {
      fail(`${name}: ${found.length} package.json files declare this name — ` +
        `${found.join(", ")}. Its ONE home is ${home}; delete the others ` +
        `(see ci/repos.yml single_home)`);
    }
  }
}

// ── summary ──────────────────────────────────────────────────────────────────
console.log("");
if (failures) { console.error(`${R}✗ ${failures} CI/CD conformance failure(s)${X}\n`); process.exit(1); }
console.log(`${G}✓ CI/CD conformance: all rules pass${X}`);
for (const c of manifest.open_conflicts ?? []) {
  console.log(`  ${Y}○${X} ${c.package}: ${c.issue.split("\n")[0]} (${c.status})`);
}
console.log("");