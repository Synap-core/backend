#!/usr/bin/env node
// Pre-commit CHECK — never rewrites, never touches the working tree or the index.
//
// Why this replaced `lint-staged --no-stash` (2026-10-13): lint-staged formats the WHOLE
// staged file (a 3-line change turned into a 1286-line reformat), and even with --no-stash
// it hides partially-staged files with `git checkout --force -- <files>`, which can drop a
// concurrent session's edit in this shared tree. Policy: "new code only" formatting — check,
// never rewrite, in hooks.
//
// What it does, on the INDEX content (what will actually be committed):
//   prettier  — a staged file that is not prettier-clean FAILS when it is new, or was clean at
//               HEAD; it only WARNS when HEAD's version was already unclean (no mass reformat).
//   eslint    — FAILS when the staged version has more errors than HEAD's (new file = 0);
//               warnings never fail. `prettier/prettier` findings are ignored here (prettier
//               is judged above, by the rule above).
//   lockfile  — when a package.json is staged: FAILS if the staged pnpm-lock.yaml does not
//               satisfy the staged package.json files (`pnpm install --frozen-lockfile`
//               run against the index content in a temp dir).
// The fix is printed for the author to run deliberately; the hook itself never writes.
// Allowed git calls: read-only plumbing (diff --cached, cat-file, ls-files). No checkout,
// add, stash, reset — keep it that way.
//
// Usage: node scripts/precommit-check.mjs [--eslint=ts,tsx,js,jsx] [--prettier=ts,tsx,...] [--lockfile]
// This file is byte-identical in synap-app, synap-backend, synap-control-plane-api and
// synap-intelligence-service; per-repo differences live in the .husky/pre-commit arguments.

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const listArg = (name) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3).split(",").filter(Boolean) : [];
};
const ESLINT_EXT = listArg("eslint");
const PRETTIER_EXT = listArg("prettier");
const CHECK_LOCKFILE = args.includes("--lockfile");

const ROOT = git(["rev-parse", "--show-toplevel"]).toString().trim();
process.chdir(ROOT);

function git(argv, input) {
  const r = spawnSync("git", argv, { input, maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) {
    throw new Error(`git ${argv.join(" ")} failed: ${r.stderr.toString()}`);
  }
  return r.stdout;
}

const ZERO = /^0+$/;
const blob = (sha) => git(["cat-file", "blob", sha]).toString("utf8");
const ext = (p) => path.extname(p).slice(1);

// --raw gives both blob ids: dst = the staged (index) blob, src = HEAD's (or the rename source).
function stagedEntries() {
  const parts = git(["diff", "--cached", "--raw", "-z", "-M", "--diff-filter=ACMR"])
    .toString("utf8")
    .split("\0");
  const out = [];
  for (let i = 0; i < parts.length - 1; ) {
    const meta = parts[i++];
    if (!meta.startsWith(":")) continue;
    const [srcMode, dstMode, srcSha, dstSha, status] = meta.slice(1).split(" ");
    const twoPaths = status[0] === "R" || status[0] === "C";
    const srcPath = parts[i++];
    const file = twoPaths ? parts[i++] : srcPath;
    if (!dstMode.startsWith("100")) continue; // symlinks, submodules
    const hasBase = !ZERO.test(srcSha) && srcMode.startsWith("100");
    out.push({ file, dstSha, srcSha: hasBase ? srcSha : null, srcPath });
  }
  return out;
}

const entries = stagedEntries();
const failures = [];
const warnings = [];

// ── prettier ──────────────────────────────────────────────────────────────────
if (PRETTIER_EXT.length) {
  const prettier = await import("prettier");
  const targets = entries.filter((e) => PRETTIER_EXT.includes(ext(e.file)));
  for (const e of targets) {
    const info = await prettier.getFileInfo(e.file, {
      ignorePath: [".gitignore", ".prettierignore"],
    });
    if (info.ignored || !info.inferredParser) continue;
    const options = { ...(await prettier.resolveConfig(e.file)), filepath: e.file };
    const clean = async (text) => {
      try {
        return await prettier.check(text, options);
      } catch (err) {
        return `syntax: ${String(err.message).split("\n")[0]}`;
      }
    };
    const now = await clean(blob(e.dstSha));
    if (now === true) continue;
    const before = e.srcSha ? await clean(blob(e.srcSha)) : null;
    const why = typeof now === "string" ? ` (${now})` : "";
    if (before === false || typeof before === "string") {
      warnings.push(`prettier: ${e.file} was already not prettier-clean at HEAD — left as is${why}`);
    } else {
      failures.push(
        `prettier: ${e.file} is not prettier-clean${why}\n    fix: pnpm exec prettier --write ${JSON.stringify(e.file)} && git add ${JSON.stringify(e.file)}`,
      );
    }
  }
}

// ── eslint ────────────────────────────────────────────────────────────────────
if (ESLINT_EXT.length) {
  const targets = entries.filter((e) => ESLINT_EXT.includes(ext(e.file)));
  if (targets.length) {
    const { ESLint } = await import("eslint");
    const eslint = new ESLint({ cwd: ROOT });
    const errorsIn = async (text, file) => {
      const [res] = await eslint.lintText(text, { filePath: path.join(ROOT, file) });
      return (res?.messages ?? []).filter(
        (m) => m.severity === 2 && m.ruleId !== "prettier/prettier",
      );
    };
    for (const e of targets) {
      if (await eslint.isPathIgnored(path.join(ROOT, e.file))) continue;
      const now = await errorsIn(blob(e.dstSha), e.file);
      if (!now.length) continue;
      const before = e.srcSha ? (await errorsIn(blob(e.srcSha), e.srcPath)).length : 0;
      const lines = now
        .slice(0, 10)
        .map((m) => `      ${m.line}:${m.column} ${m.message} (${m.ruleId ?? "parse"})`)
        .join("\n");
      if (now.length > before) {
        failures.push(
          `eslint: ${e.file} has ${now.length} error(s), HEAD had ${before}\n${lines}\n    fix: pnpm exec eslint --fix ${JSON.stringify(e.file)} (review the diff), then git add it`,
        );
      } else {
        warnings.push(`eslint: ${e.file} still has ${now.length} pre-existing error(s) (HEAD had ${before})`);
      }
    }
  }
}

// ── lockfile ──────────────────────────────────────────────────────────────────
if (CHECK_LOCKFILE && entries.some((e) => path.basename(e.file) === "package.json")) {
  // Materialize the INDEX versions of every manifest + the lockfile into a temp dir and ask
  // pnpm whether the lockfile satisfies them. Nothing in the repo is written.
  const dir = mkdtempSync(path.join(tmpdir(), "precommit-lock-"));
  try {
    const files = git(["ls-files", "-z", "--", "*package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".npmrc"])
      .toString("utf8")
      .split("\0")
      .filter((f) => f && (path.basename(f) !== "package.json" || !f.includes("node_modules/")));
    for (const f of files) {
      mkdirSync(path.join(dir, path.dirname(f)), { recursive: true });
      writeFileSync(path.join(dir, f), git(["cat-file", "blob", `:${f}`]));
    }
    const r = spawnSync(
      "pnpm",
      ["install", "--lockfile-only", "--frozen-lockfile", "--ignore-scripts", "--offline"],
      { cwd: dir, encoding: "utf8" },
    );
    if (r.status !== 0) {
      const tail = `${r.stdout}\n${r.stderr}`.trim().split("\n").slice(-4).join("\n      ");
      failures.push(
        `lockfile: the staged pnpm-lock.yaml does not satisfy the staged package.json files\n      ${tail}\n    fix: pnpm install --lockfile-only && git add pnpm-lock.yaml`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const w of warnings) console.warn(`  warn  ${w}`);
if (failures.length) {
  console.error(`\npre-commit: ${failures.length} problem(s) in the staged changes (nothing was rewritten):\n`);
  for (const f of failures) console.error(`  ✖ ${f}\n`);
  process.exit(1);
}
