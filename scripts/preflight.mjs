#!/usr/bin/env node
/**
 * preflight — the cheap checks that are likely to be red, in one run, before
 * anyone pays for the 20-minute CI jobs. `pnpm preflight` before you push; CI
 * runs tier 0 as the "Preflight" job, and the heavy jobs wait for it.
 *
 * ── WHY ──────────────────────────────────────────────────────────────────────
 * 2026-10-28: one merge took ~4 h, five CI runs of 22-34 min in a row, each
 * finding ONE new red that the PR under test did not cause: an npm package
 * published by hand (api-types freshness), a control-plane-api change that made
 * the door tool-name table stale, a flaky test. Each of the first two is a
 * 1-second check. Measured over the last day of CI (scripts/ci/check-scores.json)
 * they are also the cheap checks most often red: api-types freshness p≈0.19,
 * door tool names p≈0.13, the security audit p≈0.10.
 *
 * ── WHAT IT DOES ─────────────────────────────────────────────────────────────
 * Runs EVERY selected check and reports EVERY red (prior-art brief, pod
 * document da67c51b, §1: for checks under 2 min, the number of CI runs is what
 * costs hours, not the order inside one run). Checks are listed in score order
 * (p / c, scripts/ci/check-scores.json). `--first` runs them one by one in that
 * order and stops at the first red.
 *
 *   tier 0  no install, no build: Node and the network.          (~5 s)
 *   tier 1  an installed tree: eslint and prettier on the files
 *           changed against origin/main (committed, staged,
 *           unstaged, untracked); and, advisory, a tRPC surface
 *           change with no regenerated API types (git only).      (~10-30 s)
 *   tier 2  a BUILT workspace (pnpm build): gen-types:check and
 *           docs:reference:check. Each needs the workspace dists and
 *           takes 1+ min, so they are NOT in the 2-minute default;
 *           `--build` adds them.
 *
 * Verdicts: PASS · FAIL (the CI check it mirrors will be red) · WARN (could not
 * decide: network, missing tool; or advisory, as CI's Format Check is) · SKIP
 * (does not apply here, e.g. no changed files, a pending Depends-On). Only FAIL
 * makes preflight red. A WARN or SKIP is never a PASS: it is printed as what it is.
 *
 * ── USAGE ────────────────────────────────────────────────────────────────────
 *   pnpm preflight                 tiers 0+1, every red
 *   pnpm preflight --first         stop at the first red (score order)
 *   pnpm preflight --build         also tier 2 (needs `pnpm build` first)
 *   pnpm preflight --tier=0        one tier only
 *   pnpm preflight --only=a,b      these checks only (any tier)
 *   pnpm preflight --record-costs  store each check's measured seconds in
 *                                  scripts/ci/check-scores.json (preflightCosts)
 *   node scripts/preflight.mjs --ci --tier=0
 *                                  CI: never exits 1 on a red; writes
 *                                  red=true|false and reds=<ids> to GITHUB_OUTPUT
 *                                  and a table to GITHUB_STEP_SUMMARY. The job's
 *                                  next step turns red=true into a failure.
 *   --cp-source=<file>             door-tool-names, cp-pod-tools-drift: read the
 *                                  control-plane-api catalog from this file (tests)
 *   --cp-drift-test-source=<file>  cp-pod-tools-drift: read CP's drift test (its
 *                                  omission registries) from this file (tests)
 */

import { spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCORES_PATH = join(ROOT, "scripts", "ci", "check-scores.json");
const CP_REPO = "Synap-core/control-plane-api";
const CP_FILE = "src/routes/mcp-pod-tools.ts";
const CP_DRIFT_TEST = "src/__tests__/mcp-pod-tools-drift.test.ts";
const BACKEND_REPO = "Synap-core/backend";
const MCP_MANIFEST =
  "packages/api/src/routers/mcp/tools/mcp-tools.manifest.json";
// The pod error text CP's drift test scans for prescribed tools.
const MCP_TOOL_ERRORS = "packages/api/src/routers/mcp/tool-errors.ts";

// ── process helpers ──────────────────────────────────────────────────────────
function sh(
  cmd,
  argv,
  { cwd = ROOT, env = process.env, timeoutMs = 90_000 } = {}
) {
  return new Promise((done) => {
    let out = "";
    let child;
    try {
      child = spawn(cmd, argv, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      done({ code: -1, out: String(err) });
      return;
    }
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", (err) => {
      clearTimeout(timer);
      done({ code: -1, out: `${out}${err.message}` });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      done({ code: signal ? -1 : code, out, signal });
    });
  });
}

const tail = (s, n = 8) =>
  s.trim().split("\n").filter(Boolean).slice(-n).join("\n");

async function ghToken(env) {
  if (env.GH_TOKEN || env.GITHUB_TOKEN) return env.GH_TOKEN || env.GITHUB_TOKEN;
  const r = await sh("gh", ["auth", "token"], { timeoutMs: 10_000 });
  return r.code === 0 ? r.out.trim() : "";
}

async function ghJson(path, env) {
  const r = await sh("gh", ["api", path], { env, timeoutMs: 20_000 });
  if (r.code !== 0) throw new Error(tail(r.out, 2) || `gh api ${path} failed`);
  return JSON.parse(r.out);
}

/** A file's text at `ref` of a GitHub repo, through `gh api` (throws). */
async function ghRaw(repo, path, ref, env) {
  const r = await sh(
    "gh",
    [
      "api",
      `repos/${repo}/contents/${path}?ref=${ref}`,
      "-H",
      "Accept: application/vnd.github.raw",
    ],
    { env, timeoutMs: 20_000 }
  );
  if (r.code !== 0) throw new Error(tail(r.out, 1) || `gh api ${path} failed`);
  return { text: r.out };
}

/** A file of this repo at main: origin/main if fetched, else GitHub. */
async function mainFile(path, env) {
  const local = await sh("git", ["show", `origin/main:${path}`], {
    timeoutMs: 10_000,
  });
  if (local.code === 0) return { text: local.out };
  return ghRaw(BACKEND_REPO, path, "main", env).catch((error) => ({ error }));
}

/**
 * Import one export of a self-contained TypeScript module given as TEXT
 * (Node's type stripping, 22.18+): CP's generated catalog has no imports.
 */
async function importTsModule(text, exportName) {
  const dir = mkdtempSync(join(tmpdir(), "preflight-ts-"));
  try {
    const file = join(dir, "module.mts");
    writeFileSync(file, text);
    const mod = await import(pathToFileURL(file).href);
    if (!(exportName in mod)) throw new Error(`no export ${exportName}`);
    return mod[exportName];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The keys of `const <name>: Record<…> = { … }` in TypeScript source, or null
 * when the declaration is not there. Skips strings and comments, so a reason
 * holding a brace, a comma or a colon does not shift the scan.
 */
export function parseRegistryKeys(src, name) {
  const decl = new RegExp(`\\bconst ${name}\\b[^=]*=\\s*\\{`).exec(src);
  if (!decl) return null;
  let i = decl.index + decl[0].length;
  const keys = [];
  let depth = 1;
  let expectKey = true;
  const skipString = (q) => {
    i++;
    while (i < src.length && src[i] !== q) i += src[i] === "\\" ? 2 : 1;
    i++;
  };
  while (i < src.length && depth > 0) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      i = src.indexOf("\n", i);
      if (i < 0) break;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i = src.indexOf("*/", i) + 2;
      if (i < 2) break;
      continue;
    }
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (depth === 1 && expectKey) {
      if (c === "}") {
        depth--;
        break;
      }
      const m = /^(?:"([^"]+)"|'([^']+)'|([A-Za-z_$][\w$]*))\s*:/.exec(
        src.slice(i, i + 300)
      );
      if (!m) return null;
      keys.push(m[1] ?? m[2] ?? m[3]);
      i += m[0].length;
      expectKey = false;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      skipString(c);
      continue;
    }
    if (c === "{" || c === "[" || c === "(") depth++;
    else if (c === "}" || c === "]" || c === ")") depth--;
    else if (c === "," && depth === 1) expectKey = true;
    i++;
  }
  return depth === 0 ? keys : null;
}

/**
 * The rows control-plane-api's mcp-pod-tools-drift test
 * (src/__tests__/mcp-pod-tools-drift.test.ts) would report, for a pod
 * manifest and CP's catalog + registries. Pure; sorted strings:
 *   missing <tool>        CP curates a pod tool that no longer exists
 *   uncurated <tool>      a pod tool neither curated nor declared omitted
 *   readOnlyHint <tool>   the pod's readOnlyHint differs from CP's copy
 *   input <tool>.<prop>   a pod input the curated copy drops, undeclared
 *   error-text <tool>()   pod error text prescribes a tool CP does not expose
 * Not mirrored: CP-internal checks the pod cannot move (proposal wording,
 * frozen public names, dangling references inside CP's own descriptions).
 */
export function cpDriftProblems({
  manifestTools,
  toolErrorsSource = "",
  curated,
  omittedTools,
  omittedProps,
  exempt = [],
}) {
  const pod = new Map(manifestTools.map((t) => [t.name, t]));
  const curatedNames = new Set(curated.map((c) => c.podToolName));
  const out = new Set();
  for (const c of curated) {
    const t = pod.get(c.podToolName);
    if (!t) {
      out.add(`missing ${c.podToolName}`);
      continue;
    }
    const ro = t.annotations?.readOnlyHint;
    if (typeof ro === "boolean" && ro !== c.annotations?.readOnlyHint)
      out.add(`readOnlyHint ${c.podToolName}`);
    const mine = new Set(Object.keys(c.inputSchema?.properties ?? {}));
    for (const prop of Object.keys(t.inputSchema?.properties ?? {})) {
      // CP injects workspaceId onto every tool (the drift test's own rule).
      if (prop === "workspaceId" || mine.has(prop)) continue;
      if (omittedProps.includes(`${c.podToolName}.${prop}`)) continue;
      out.add(`input ${c.podToolName}.${prop}`);
    }
  }
  for (const name of pod.keys())
    if (!curatedNames.has(name) && !omittedTools.includes(name))
      out.add(`uncurated ${name}`);
  for (const m of toolErrorsSource.matchAll(/\b(synap_[a-z_]+)\(\)/g))
    if (!curatedNames.has(m[1]) && !exempt.includes(m[1]))
      out.add(`error-text ${m[1]}()`);
  return [...out].sort();
}

export const GENERATED_API_TYPES = "packages/api-types/src/generated.d.ts";

/**
 * The changed files that can move the generated API types (the tRPC
 * AppRouter that packages/api/scripts/gen-types.mjs bundles from
 * packages/api/src/root.ts): the routers and the tRPC wiring, tests excluded.
 * A heuristic in both directions: a service whose return type a procedure
 * infers can move them too (not listed), and most router edits do not.
 */
export function apiTypesSurface(files) {
  const isTest = (f) =>
    /(__tests__|__tripwires__)\/|\.(test|spec)\.[cm]?[jt]sx?$/.test(f);
  const surface = files.filter(
    (f) =>
      /^packages\/api\/src\/(routers\/.+|root|trpc|init-trpc|context)\.ts$/.test(
        f
      ) && !isTest(f)
  );
  return { surface, regenerated: files.includes(GENERATED_API_TYPES) };
}

// ── changed files (tier 1) ───────────────────────────────────────────────────
async function changedFiles(ctx) {
  const lines = async (argv) => {
    const r = await sh("git", argv, { timeoutMs: 20_000 });
    if (r.code !== 0)
      throw new Error(`git ${argv.join(" ")}: ${tail(r.out, 2)}`);
    return r.out.split("\n").filter(Boolean);
  };
  const base =
    ctx.base ?? (await lines(["merge-base", "origin/main", "HEAD"]))[0];
  const set = new Set([
    ...(await lines([
      "diff",
      "--name-only",
      "--diff-filter=ACMR",
      `${base}...HEAD`,
    ])),
    ...(await lines(["diff", "--name-only", "--diff-filter=ACMR", "HEAD"])),
    ...(await lines(["ls-files", "--others", "--exclude-standard"])),
  ]);
  return [...set].filter((f) => existsSync(join(ROOT, f))).sort();
}

const bin = (name) => join(ROOT, "node_modules", ".bin", name);

// ── the checks ───────────────────────────────────────────────────────────────
// `mirrors` names the row of scripts/ci/check-scores.json whose measured p is
// this check's: the CI step (or test file) that goes red when this one does.
// `costHint` (seconds) is used until `--record-costs` measured the real cost.
export const CHECKS = [
  {
    id: "api-types-freshness",
    tier: 0,
    mirrors:
      "Full suite (shard 1/4) › Check @synap-core/api-types publish freshness (drift tripwire)",
    costHint: 2,
    fix: "the repo's packages/api-types version must be the one on npm (pod caution 6b19d446: a hand publish leaves main behind npm; land the version bump on main)",
    async run(ctx) {
      const token = ctx.env.CROSS_REPO_TOKEN || (await ghToken(ctx.env));
      const r = await sh("node", ["scripts/check-publish-freshness.mjs"], {
        cwd: join(ROOT, "packages/api-types"),
        env: {
          ...ctx.env,
          SYNAP_APP_REPO: "Synap-core/app-bases",
          ...(token ? { CROSS_REPO_TOKEN: token } : {}),
        },
        timeoutMs: 60_000,
      });
      const fails = r.out
        .split("\n")
        .filter((l) => l.includes("❌"))
        .map((l) => l.replace("❌", "").trim());
      if (r.code === 1 || fails.length)
        return { verdict: "FAIL", detail: fails.join("; ") || tail(r.out, 3) };
      if (r.code !== 0)
        return { verdict: "WARN", detail: `exit ${r.code}: ${tail(r.out, 2)}` };
      const local = /local \S+ version: (\S+)/.exec(r.out)?.[1];
      const npm = /published \S+ version: (\S+)/.exec(r.out)?.[1];
      if (r.out.includes("⚠️"))
        return {
          verdict: "WARN",
          detail: `partly unchecked: ${r.out
            .split("\n")
            .filter((l) => l.includes("⚠️"))
            .map((l) => l.replace("⚠️", "").trim())
            .join("; ")}`,
        };
      return {
        verdict: "PASS",
        detail: `local ${local} = npm ${npm}; app-bases range satisfied`,
      };
    },
  },
  {
    id: "door-tool-names",
    tier: 0,
    mirrors:
      "test file packages/api/src/routers/mcp/door-tool-names.freshness.test.ts",
    costHint: 1,
    fix: "cd packages/api && npx tsx src/routers/mcp/gen-door-tool-names.ts (with ../synap-control-plane-api at main), commit door-tool-names.generated.ts",
    async run(ctx) {
      // CI tests the PR with a pending control-plane-api dependency checked
      // out at that dependency's ref (scripts/layout/layout.mjs): CP main is
      // then the wrong comparison, and the Full suite judges it.
      if (/^Depends-On:.*control-plane-api/im.test(ctx.prBody ?? ""))
        return {
          verdict: "SKIP",
          detail:
            "the PR body names a control-plane-api Depends-On: the Full suite compares against that ref",
        };
      let source;
      let from;
      if (ctx.cpSource) {
        source = readFileSync(ctx.cpSource, "utf8");
        from = ctx.cpSource;
      } else {
        // CI reads the private CP repo with the Reader App token, the
        // backend's own API with github.token (GH_TOKEN).
        const env = {
          ...ctx.env,
          ...(ctx.env.CP_READ_TOKEN ? { GH_TOKEN: ctx.env.CP_READ_TOKEN } : {}),
        };
        const [file, commit] = await Promise.allSettled([
          sh(
            "gh",
            [
              "api",
              `repos/${CP_REPO}/contents/${CP_FILE}?ref=main`,
              "-H",
              "Accept: application/vnd.github.raw",
            ],
            { env, timeoutMs: 20_000 }
          ),
          ghJson(
            `repos/${CP_REPO}/commits?sha=main&path=${CP_FILE}&per_page=1`,
            env
          ),
        ]);
        if (file.status === "fulfilled" && file.value.code === 0) {
          source = file.value.out;
          const c = commit.status === "fulfilled" ? commit.value[0] : null;
          from = c
            ? `${CP_REPO}@main (${CP_FILE} last changed in ${c.sha.slice(0, 8)} "${c.commit.message.split("\n")[0].slice(0, 60)}")`
            : `${CP_REPO}@main`;
        } else {
          // No GitHub access: the sibling checkout, which may not be at main.
          const sibling = resolve(
            ROOT,
            "..",
            "synap-control-plane-api",
            CP_FILE
          );
          if (!existsSync(sibling))
            return {
              verdict: "WARN",
              detail: `could not read ${CP_REPO}@main (${file.status === "fulfilled" ? tail(file.value.out, 1) : file.reason}) and no sibling checkout`,
            };
          source = readFileSync(sibling, "utf8");
          from = `the sibling checkout ${sibling} (NOT necessarily main)`;
        }
      }
      // The SAME builder and committed table the freshness tripwire compares
      // (door-tool-names.build.ts, door-tool-names.generated.ts), loaded with
      // Node's type stripping (22.18+): no install, no tsx.
      let build;
      let generated;
      try {
        const dir = join(ROOT, "packages/api/src/routers/mcp");
        build = await import(
          pathToFileURL(join(dir, "door-tool-names.build.ts")).href
        );
        generated = await import(
          pathToFileURL(join(dir, "door-tool-names.generated.ts")).href
        );
      } catch (err) {
        return {
          verdict: "WARN",
          detail: `cannot load the TS builder on node ${process.version} (needs >= 22.18): ${err.message}`,
        };
      }
      const manifest = JSON.parse(
        readFileSync(
          join(
            ROOT,
            "packages/api/src/routers/mcp/tools/mcp-tools.manifest.json"
          ),
          "utf8"
        )
      );
      const fresh = build.buildDoorToolNames({
        podToolNames: manifest.tools.map((t) => t.name),
        cpCuratedSource: source,
      });
      const committed = generated.DOOR_TOOL_NAMES;
      if (isDeepStrictEqual(committed, fresh))
        return { verdict: "PASS", detail: `fresh against ${from}` };
      const keys = new Set([...Object.keys(committed), ...Object.keys(fresh)]);
      const diff = [...keys].filter(
        (k) => !isDeepStrictEqual(committed[k], fresh[k])
      );
      return {
        verdict: "FAIL",
        detail: `door-tool-names.generated.ts is stale against ${from}: ${diff.length} row(s) differ (${diff.slice(0, 4).join(", ")}${diff.length > 4 ? ", …" : ""}). The producer changed, not necessarily this PR`,
      };
    },
  },
  {
    // THE OTHER DIRECTION (2026-10-29): door-tool-names above asks "did CP
    // change under us?"; this asks "will THIS change turn CP red?". backend#366
    // (28 Oct) added four `synap_diagnose` inputs; nothing on the backend side
    // said so, and control-plane-api's mcp-pod-tools-drift test went red on
    // CP's next run. This runs that test's checks here, against CP main and
    // this tree's MCP manifest (cpDriftProblems).
    // WARN, never FAIL (advisory): the red lands in CP, whose hand-copied
    // catalog is what must follow; this backend change is correct as it is.
    // Holding it would make every MCP tool change a two-repo lockstep, and a
    // Depends-On cannot say "CP follows me". What the incident lacked was the
    // WARNING: it reaches the PR as an annotation and the step summary, and
    // `pnpm preflight` locally, naming each CP row to fix.
    id: "cp-pod-tools-drift",
    tier: 0,
    advisory: true,
    annotate: true,
    mirrors: null,
    costHint: 2,
    fix: `in control-plane-api: curate each new tool/input in ${CP_FILE} (scripts/gen-pod-tools.ts) or declare it in src/__tests__/mcp-pod-tools-drift.test.ts (INTENTIONALLY_OMITTED_*), after this lands`,
    async run(ctx) {
      if (/^Depends-On:.*control-plane-api/im.test(ctx.prBody ?? ""))
        return {
          verdict: "SKIP",
          detail:
            "the PR body names a control-plane-api Depends-On: CP main is not the comparison",
        };
      const env = {
        ...ctx.env,
        ...(ctx.env.CP_READ_TOKEN ? { GH_TOKEN: ctx.env.CP_READ_TOKEN } : {}),
      };
      const raw = (repo, path, useEnv) =>
        ghRaw(repo, path, "main", useEnv).catch((err) => ({ error: err }));
      const [cpCatalog, cpTest, mainManifest, mainErrors] = await Promise.all([
        ctx.cpSource
          ? { text: readFileSync(ctx.cpSource, "utf8") }
          : raw(CP_REPO, CP_FILE, env),
        ctx.cpDriftTestSource
          ? { text: readFileSync(ctx.cpDriftTestSource, "utf8") }
          : raw(CP_REPO, CP_DRIFT_TEST, env),
        mainFile(MCP_MANIFEST, ctx.env),
        mainFile(MCP_TOOL_ERRORS, ctx.env),
      ]);
      for (const [what, r] of [
        [`${CP_REPO}@main ${CP_FILE}`, cpCatalog],
        [`${CP_REPO}@main ${CP_DRIFT_TEST}`, cpTest],
      ])
        if (r.error)
          return {
            verdict: "WARN",
            detail: `could not read ${what}: ${r.error.message}`,
          };
      let curated;
      try {
        curated = await importTsModule(cpCatalog.text, "CURATED_POD_TOOLS");
      } catch (err) {
        return {
          verdict: "WARN",
          detail: `cannot load CP's catalog on node ${process.version} (needs >= 22.18, erasable TS): ${err.message}`,
        };
      }
      const omittedTools = parseRegistryKeys(
        cpTest.text,
        "INTENTIONALLY_OMITTED_TOOLS"
      );
      const omittedProps = parseRegistryKeys(
        cpTest.text,
        "INTENTIONALLY_OMITTED_PROPS"
      );
      const exempt = parseRegistryKeys(
        cpTest.text,
        "REFERENCEABLE_WITHOUT_EXPOSURE"
      );
      if (!omittedTools || !omittedProps || !exempt)
        return {
          verdict: "WARN",
          detail: `could not read the omission registries in ${CP_DRIFT_TEST} (its shape changed: fix parseRegistryKeys)`,
        };
      const registries = { curated, omittedTools, omittedProps, exempt };
      const here = cpDriftProblems({
        manifestTools: JSON.parse(
          readFileSync(join(ROOT, MCP_MANIFEST), "utf8")
        ).tools,
        toolErrorsSource: readFileSync(join(ROOT, MCP_TOOL_ERRORS), "utf8"),
        ...registries,
      });
      if (here.length === 0)
        return {
          verdict: "PASS",
          detail: `CP main's catalog (${curated.length} curated) holds against this tree's manifest`,
        };
      // Which rows this change adds, and which backend main already has.
      const atMain =
        mainManifest.error || mainErrors.error
          ? null
          : new Set(
              cpDriftProblems({
                manifestTools: JSON.parse(mainManifest.text).tools,
                toolErrorsSource: mainErrors.text,
                ...registries,
              })
            );
      const added = atMain ? here.filter((p) => !atMain.has(p)) : here;
      const already = atMain ? here.filter((p) => atMain.has(p)) : [];
      const list = (xs) =>
        `${xs.slice(0, 6).join(", ")}${xs.length > 6 ? `, … (${xs.length})` : ""}`;
      return {
        verdict: "WARN",
        detail: [
          added.length
            ? `this change turns control-plane-api's mcp-pod-tools-drift test red once it lands: ${list(added)}`
            : "",
          already.length
            ? `CP is already red against backend main (not this change): ${list(already)}`
            : "",
          atMain
            ? ""
            : "(backend main unread: every row is listed as this change's)",
        ]
          .filter(Boolean)
          .join("; "),
      };
    },
  },
  {
    id: "security-audit",
    tier: 0,
    mirrors: "Full suite (shard 1/4) › Security Audit",
    costHint: 2,
    fix: "pnpm audit --prod --audit-level=high: bump the package, or (justified) add it to pnpm.auditConfig.ignoreCves",
    async run(ctx) {
      const r = await sh("pnpm", ["audit", "--prod", "--audit-level=high"], {
        env: ctx.env,
        timeoutMs: 60_000,
      });
      const summary = /^\d+ vulnerabilities found[\s\S]*?Severity:.*$/m
        .exec(r.out)?.[0]
        ?.replace(/\n/g, "; ");
      if (r.code === 0)
        return {
          verdict: "PASS",
          detail: summary ?? "no vulnerabilities at high or above",
        };
      if (!summary && !/No known vulnerabilities/.test(r.out))
        return {
          verdict: "WARN",
          detail: `could not audit (exit ${r.code}): ${tail(r.out, 2)}`,
        };
      const advisories = [
        ...r.out.matchAll(/│\s*(high|critical)\s*│\s*([^│]+?)\s*│/g),
      ].map((m) => `${m[1]}: ${m[2]}`);
      return {
        verdict: "FAIL",
        detail: `${summary ?? ""}${advisories.length ? ` — ${advisories.slice(0, 3).join("; ")}` : ""}`,
      };
    },
  },
  {
    id: "main-status",
    tier: 0,
    informational: true,
    mirrors: null,
    costHint: 1,
    fix: "a red main is fixed by ONE PR; every other PR waits (rules/github-ci, Never)",
    async run(ctx) {
      let latest;
      try {
        // A cancelled run (superseded by a newer push) measured nothing.
        latest = (
          await ghJson(
            `repos/${BACKEND_REPO}/actions/workflows/ci.yml/runs?branch=main&event=push&status=completed&per_page=30`,
            ctx.env
          )
        ).workflow_runs.find(
          (r) => r.conclusion !== "cancelled" && r.conclusion !== "skipped"
        );
      } catch (err) {
        return {
          verdict: "WARN",
          detail: `could not read main's CI: ${err.message}`,
        };
      }
      if (!latest)
        return {
          verdict: "WARN",
          detail:
            "main's last 30 completed CI runs were all cancelled (a merge wave): no verdict on main yet",
        };
      const at = `${latest.head_sha.slice(0, 8)} (${latest.run_started_at ?? latest.created_at}, the newest main run that finished: ${latest.html_url})`;
      if (latest.conclusion === "success")
        return { verdict: "PASS", detail: `main green at ${at}` };
      let red = "";
      try {
        const jobs = (
          await ghJson(
            `repos/${BACKEND_REPO}/actions/runs/${latest.id}/jobs?per_page=100`,
            ctx.env
          )
        ).jobs;
        red = jobs
          .filter((j) => j.conclusion === "failure")
          .map(
            (j) =>
              `${j.name} › ${j.steps?.find((s) => s.conclusion === "failure")?.name ?? "?"}`
          )
          .join("; ");
      } catch {
        // the conclusion alone is still the answer
      }
      return {
        verdict: "WARN",
        detail: `main is ${latest.conclusion} at ${at}${red ? `: ${red}` : ""}. A red there is main's, not yours`,
      };
    },
  },
  {
    id: "eslint-changed",
    tier: 1,
    mirrors: "Release gate › Lint",
    costHint: 15,
    fix: "pnpm exec eslint --fix <file> (prettier findings are eslint errors here: prettier/prettier)",
    async run(ctx) {
      if (!existsSync(bin("eslint")))
        return {
          verdict: "WARN",
          detail: "eslint not installed (pnpm install)",
        };
      const files = (await ctx.changed()).filter((f) =>
        /\.(c|m)?[jt]sx?$/.test(f)
      );
      if (!files.length)
        return { verdict: "SKIP", detail: "no changed JS/TS file" };
      const r = await sh(
        bin("eslint"),
        ["--cache", "--no-warn-ignored", "--format=json", ...files],
        { timeoutMs: 120_000 }
      );
      let report;
      try {
        report = JSON.parse(r.out.slice(r.out.indexOf("[")));
      } catch {
        return {
          verdict: "WARN",
          detail: `eslint exit ${r.code}, unreadable output: ${tail(r.out, 3)}`,
        };
      }
      const errors = report.flatMap((f) =>
        f.messages
          .filter((m) => m.severity === 2)
          .map(
            (m) =>
              `${f.filePath.replace(`${ROOT}/`, "")}:${m.line}:${m.column} ${m.message.split("\n")[0]} (${m.ruleId ?? "fatal"})`
          )
      );
      if (!errors.length)
        return { verdict: "PASS", detail: `${files.length} file(s), no error` };
      return {
        verdict: "FAIL",
        detail: `${errors.length} error(s) in ${files.length} changed file(s):\n${errors
          .slice(0, 8)
          .map((l) => `      ${l}`)
          .join("\n")}`,
      };
    },
  },
  {
    id: "prettier-changed",
    tier: 1,
    // CI's "Format Check" never fails (continue-on-error); JS/TS formatting is
    // judged by eslint's prettier/prettier rule above. So this one only warns.
    advisory: true,
    mirrors: "Release gate › Format Check",
    costHint: 5,
    fix: "pnpm exec prettier --write <file>",
    async run(ctx) {
      if (!existsSync(bin("prettier")))
        return {
          verdict: "WARN",
          detail: "prettier not installed (pnpm install)",
        };
      const files = await ctx.changed();
      if (!files.length) return { verdict: "SKIP", detail: "no changed file" };
      const r = await sh(
        bin("prettier"),
        ["--check", "--ignore-unknown", ...files],
        { timeoutMs: 60_000 }
      );
      if (r.code === 0)
        return { verdict: "PASS", detail: `${files.length} file(s)` };
      const bad = r.out
        .split("\n")
        .filter(
          (l) => l.startsWith("[warn] ") && !l.includes("Code style issues")
        );
      return {
        verdict: "WARN",
        detail: `not prettier-clean (advisory in CI): ${bad
          .map((l) => l.slice(7))
          .slice(0, 6)
          .join(", ")}`,
      };
    },
  },
  {
    // F10 (29 Oct, pod document 9ca0c96b): "API types out of date" was 22 % of
    // the primary PR reds. Of 41 sampled reds of CI's "Verify generated API
    // types" step, the 21 whose PR diff could still be read ALL changed the
    // tRPC surface (apiTypesSurface) without touching generated.d.ts. The
    // exact answer needs the generator, which needs ~10 built workspace
    // packages and ~70 s (tier 2, `gen-types`): not a Mac check. So this is
    // the cheap half, ADVISORY: of the 140 PRs merged 20-29 Oct that touched
    // the routers, 73 were right NOT to regenerate (their types did not
    // move), so a FAIL here would refuse half of the correct pushes.
    id: "api-types-surface",
    tier: 1,
    advisory: true,
    mirrors: "Release gate › Verify generated API types are up to date",
    costHint: 1, // measured 0.7 s (git diff only)
    fix: "if the API types changed: regenerate on a built tree (pnpm build, then pnpm --filter @synap/api gen-types) and commit packages/api-types/src/generated.d.ts; when CI's 'Verify generated API types' is red, its run hands back the regenerated file (the step prints the one gh run download line)",
    async run(ctx) {
      const { surface, regenerated } = apiTypesSurface(await ctx.changed());
      if (!surface.length)
        return { verdict: "SKIP", detail: "no tRPC surface file changed" };
      if (regenerated)
        return {
          verdict: "PASS",
          detail: `${surface.length} surface file(s) changed, generated.d.ts changed with them (CI checks it is current)`,
        };
      return {
        verdict: "WARN",
        detail: `${surface.length} tRPC surface file(s) changed (${surface.slice(0, 3).join(", ")}${surface.length > 3 ? ", …" : ""}) and packages/api-types/src/generated.d.ts did not: if a procedure's input or output type moved, CI's "Verify generated API types" goes red`,
      };
    },
  },
  {
    id: "gen-types",
    tier: 2,
    mirrors: "Release gate › Verify generated API types are up to date",
    costHint: 70,
    fix: "pnpm --filter @synap/api gen-types, commit packages/api-types/src/generated.d.ts",
    async run(ctx) {
      if (!existsSync(join(ROOT, "packages/database/dist")))
        return {
          verdict: "SKIP",
          detail:
            "needs a built workspace (pnpm build): not part of the 2-minute tier",
        };
      const r = await sh(
        "pnpm",
        ["--filter", "@synap/api", "gen-types:check"],
        { env: ctx.env, timeoutMs: 300_000 }
      );
      return r.code === 0
        ? { verdict: "PASS", detail: "generated.d.ts is current" }
        : { verdict: "FAIL", detail: tail(r.out, 4) };
    },
  },
  {
    id: "docs-reference",
    tier: 2,
    mirrors: "Reference docs are current › Check docs/reference is up to date",
    costHint: 60,
    fix: "pnpm docs:reference, commit docs/reference/",
    async run(ctx) {
      if (!existsSync(join(ROOT, "packages/database/dist")))
        return {
          verdict: "SKIP",
          detail:
            "needs a built workspace (pnpm build): not part of the 2-minute tier",
        };
      const r = await sh("pnpm", ["docs:reference:check"], {
        env: ctx.env,
        timeoutMs: 300_000,
      });
      return r.code === 0
        ? { verdict: "PASS", detail: "docs/reference is current" }
        : { verdict: "FAIL", detail: tail(r.out, 4) };
    },
  },
];

// ── scoring ──────────────────────────────────────────────────────────────────
export function loadScores(path = SCORES_PATH) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** p (measured, from the row the check mirrors), c (local seconds), score = p/c per minute. */
export function scoreOf(check, scores) {
  const row =
    check.mirrors && scores?.checks?.find((r) => r.check === check.mirrors);
  const p = row?.p ?? null;
  const cSecs = scores?.preflightCosts?.[check.id]?.seconds ?? check.costHint;
  return {
    p,
    n: row?.n ?? 0,
    cSecs,
    score: p === null ? null : p / Math.max(cSecs / 60, 1 / 60),
  };
}

export function inScoreOrder(checks, scores) {
  return checks
    .map((c, i) => ({ c, i, s: scoreOf(c, scores) }))
    .sort((a, b) => (b.s.score ?? -1) - (a.s.score ?? -1) || a.i - b.i)
    .map((x) => x.c);
}

// ── the runner ───────────────────────────────────────────────────────────────
/**
 * Runs `checks` and returns one result per check that ran. Every check runs
 * (concurrently) unless `first`: then one by one in the given order, stopping
 * after the first FAIL of a check that is not informational.
 * A check that throws is a WARN (it decided nothing), never a PASS.
 */
export async function runChecks(checks, ctx, { first = false } = {}) {
  const runOne = async (check) => {
    const t0 = Date.now();
    let res;
    try {
      res = await check.run(ctx);
    } catch (err) {
      res = {
        verdict: "WARN",
        detail: `check crashed: ${err?.message ?? err}`,
      };
    }
    if (!["PASS", "FAIL", "WARN", "SKIP"].includes(res?.verdict))
      res = {
        verdict: "WARN",
        detail: `check returned no verdict (${JSON.stringify(res)})`,
      };
    // An informational or advisory check can warn, never fail the run.
    if (res.verdict === "FAIL" && (check.informational || check.advisory))
      res = { ...res, verdict: "WARN" };
    return {
      id: check.id,
      tier: check.tier,
      fix: check.fix,
      ...res,
      seconds: (Date.now() - t0) / 1000,
    };
  };
  if (!first) return Promise.all(checks.map(runOne));
  const out = [];
  for (const check of checks) {
    const r = await runOne(check);
    out.push(r);
    if (r.verdict === "FAIL") break;
  }
  return out;
}

const MARK = { PASS: "✓ PASS", FAIL: "✗ FAIL", WARN: "! WARN", SKIP: "- SKIP" };

export function render(results, checks, scores) {
  const lines = [];
  for (const r of results) {
    const s = scoreOf(
      checks.find((c) => c.id === r.id),
      scores
    );
    const p = s.p === null ? "p=  -  " : `p=${s.p.toFixed(3)}`;
    lines.push(
      `  ${MARK[r.verdict]}  ${r.id.padEnd(20)} ${`${r.seconds.toFixed(1)}s`.padStart(6)}  ${p}  ${r.detail}`
    );
    if (r.verdict === "FAIL") lines.push(`         fix: ${r.fix}`);
  }
  return lines.join("\n");
}

function summaryMarkdown(results) {
  const rows = results.map(
    (r) =>
      `| ${MARK[r.verdict]} | \`${r.id}\` | ${r.seconds.toFixed(1)} s | ${r.detail.replace(/\n/g, " ").replace(/\|/g, "\\|")}${r.verdict === "FAIL" ? `<br>fix: ${r.fix}` : ""} |`
  );
  return [
    "### Preflight",
    "",
    "| verdict | check | time | detail |",
    "|---|---|---|---|",
    ...rows,
    "",
    "Reproduce locally: `pnpm preflight` (all reds at once). Scores: `scripts/ci/check-scores.json`.",
    "",
  ].join("\n");
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = (n) =>
    argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
  const has = (n) => argv.includes(`--${n}`);
  const CI = has("ci");
  const tierArg = flag("tier");
  const tiers =
    tierArg !== undefined
      ? tierArg.split(",").map(Number)
      : has("build")
        ? [0, 1, 2]
        : [0, 1];
  const only = flag("only")?.split(",").filter(Boolean);
  const unknown = (only ?? []).filter((id) => !CHECKS.some((c) => c.id === id));
  if (unknown.length) {
    console.error(
      `preflight: unknown check(s) ${unknown.join(", ")}; known: ${CHECKS.map((c) => c.id).join(", ")}`
    );
    process.exit(2);
  }
  const scores = loadScores();
  const selected = inScoreOrder(
    CHECKS.filter((c) => (only ? only.includes(c.id) : tiers.includes(c.tier))),
    scores
  );

  let changed;
  const ctx = {
    env: process.env,
    prBody: process.env.PR_BODY ?? "",
    cpSource: flag("cp-source"),
    cpDriftTestSource: flag("cp-drift-test-source"),
    base: process.env.PREFLIGHT_BASE || undefined,
    changed: () => (changed ??= changedFiles(ctx)),
  };
  const t0 = Date.now();
  const when = scores?.generatedAt
    ? scores.generatedAt.slice(0, 10)
    : "no scores file";
  console.log(
    `preflight: ${selected.length} check(s), ${only ? `--only=${only.join(",")}` : `tier ${tiers.join("+")}`}, ${has("first") ? "stopping at the first red" : "every red reported"} (score order p/c, scripts/ci/check-scores.json of ${when})`
  );
  const results = await runChecks(selected, ctx, { first: has("first") });
  console.log(render(results, selected, scores));
  const reds = results.filter((r) => r.verdict === "FAIL").map((r) => r.id);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    reds.length
      ? `\npreflight: ${reds.length} red (${reds.join(", ")}) in ${secs}s`
      : `\npreflight: no red in ${secs}s${results.some((r) => r.verdict === "WARN") ? " (read the WARN lines: they decided nothing)" : ""}`
  );

  if (has("record-costs")) {
    const doc = scores ?? {};
    doc.preflightCosts ??= {};
    const measuredAt = new Date().toISOString();
    for (const r of results)
      if (r.verdict !== "SKIP")
        doc.preflightCosts[r.id] = {
          seconds: Number(r.seconds.toFixed(2)),
          measuredAt,
          where: CI ? "ci" : "local",
        };
    writeFileSync(SCORES_PATH, `${JSON.stringify(doc, null, 2)}\n`);
    console.log(
      `recorded ${results.length} cost(s) in scripts/ci/check-scores.json`
    );
  }

  if (CI) {
    if (process.env.GITHUB_OUTPUT)
      appendFileSync(
        process.env.GITHUB_OUTPUT,
        `red=${reds.length > 0}\nreds=${reds.join(" ")}\n`
      );
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, summaryMarkdown(results));
    for (const r of results)
      if (r.verdict === "FAIL")
        console.log(
          `::error title=Preflight ${r.id}::${r.detail.replace(/\n/g, " ")} — fix: ${r.fix}`
        );
      // An advisory check whose warning someone must act on (cp-pod-tools-drift)
      // shows on the PR's checks page, not only in the step summary.
      else if (
        r.verdict === "WARN" &&
        selected.find((c) => c.id === r.id)?.annotate
      )
        console.log(
          `::warning title=Preflight ${r.id}::${r.detail.replace(/\n/g, " ")} — fix: ${r.fix}`
        );
    process.exit(0);
  }
  process.exit(reds.length ? 1 : 0);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
