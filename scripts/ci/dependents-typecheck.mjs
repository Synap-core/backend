#!/usr/bin/env node
/**
 * dependents-typecheck.mjs — the verdict of ci.yml's "Dependent repos
 * typecheck" (a required check from 2026-11-09, founder: "yes, it seem a good
 * thing to have, apply it").
 *
 * app-bases, browser and relay-app link @synap-core/types, api-types and
 * markdown-core from this repo by source. On 9 Nov backend#967 (a new
 * FailureErrorClass) and #969 (a new filter field) merged with every required
 * check green and turned app-bases red against backend main (two exhaustive
 * floors, and a runtime crash in filterFields.ts). This check typechecks the
 * dependents against the PR's head, and fails on the errors THE CHANGE
 * introduces:
 *
 *   run      typecheck each target, write <out>/<key>.log and <out>/result.json
 *            ({ key: { exit, errors: [{ file, line, col, code, msg }] } }).
 *   verdict  head result vs base result (the same dependent trees typechecked
 *            again at the PR base's shared packages, only when head is red):
 *            an error is NEW when its (file, code, message) occurs more often
 *            at head than at base (line numbers move; the message does not).
 *            Exit 1 when a target has new errors, or exits non-zero at head
 *            with no error line to compare (it did not typecheck: a failed
 *            read is never taken for a pass). A dependent that is red on its
 *            own at its main does not block a backend PR; its owner fixes it.
 *
 * Pure parts (parseTscErrors, newErrors, decide) are exported for the tripwire.
 * Usage:
 *   node scripts/ci/dependents-typecheck.mjs run --root .. --out DIR [--only k1,k2]
 *   node scripts/ci/dependents-typecheck.mjs verdict --head DIR [--base DIR]
 */
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The dependents and how each typechecks, from the slice root (scripts/ci/dependent-root). */
export const TARGETS = [
  {
    key: "app-bases-headless",
    repo: "synap-app/packages/headless",
    cmd: ["pnpm", "--filter", "@synap-core/headless", "run", "type-check"],
  },
  {
    key: "app-bases-hooks",
    repo: "synap-app/packages/hooks",
    cmd: ["pnpm", "--filter", "@synap-core/hooks", "run", "type-check"],
  },
  {
    key: "app-bases-web",
    repo: "synap-app/packages/web",
    cmd: ["pnpm", "--filter", "@synap-core/web", "run", "type-check"],
  },
  {
    key: "browser",
    repo: "browser",
    cmd: ["pnpm", "--filter", "@synap-core/browser", "run", "typecheck"],
  },
  {
    key: "relay-app",
    repo: "relay-app",
    cmd: ["pnpm", "--filter", "relay-app", "run", "typecheck"],
  },
];

// `path(line,col): error TSnnnn: message`, with or without a pnpm prefix.
const TSC_ERROR = /([^\s()]+)\((\d+),(\d+)\): error (TS\d+): (.*)$/;

// A colour escape (ESC [ … m), built from its code: a literal ESC in a regex
// is eslint's no-control-regex.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/** The tsc error lines of an output. Pure. */
export function parseTscErrors(output) {
  const out = [];
  for (const raw of String(output ?? "").split(/\r?\n/)) {
    const m = TSC_ERROR.exec(raw.replace(ANSI, ""));
    if (m)
      out.push({
        file: m[1],
        line: Number(m[2]),
        col: Number(m[3]),
        code: m[4],
        msg: m[5].trim(),
      });
  }
  return out;
}

const keyOf = (e) => `${e.file}|${e.code}|${e.msg}`;

/**
 * The head errors that are not at base: for each (file, code, message), the
 * occurrences beyond base's count (the last ones, by position). Pure.
 */
export function newErrors(head, base) {
  const left = new Map();
  for (const e of base ?? []) left.set(keyOf(e), (left.get(keyOf(e)) ?? 0) + 1);
  const out = [];
  for (const e of head ?? []) {
    const n = left.get(keyOf(e)) ?? 0;
    if (n > 0) left.set(keyOf(e), n - 1);
    else out.push(e);
  }
  return out;
}

/**
 * The verdict of one run. `head`/`base` = result.json maps; `base` null when
 * head was green (no baseline ran). Returns { ok, targets: [{ key, state,
 * fresh, preexisting, detail }] }, state one of green | preexisting | new |
 * broken | missing. Pure.
 */
export function decide(head, base = null) {
  const targets = TARGETS.map(({ key }) => {
    const h = head?.[key];
    if (!h)
      return {
        key,
        state: "missing",
        fresh: [],
        preexisting: 0,
        detail: "no head result: the target did not run",
      };
    if (h.exit === 0 && h.errors.length === 0)
      return {
        key,
        state: "green",
        fresh: [],
        preexisting: 0,
        detail: "no type errors",
      };
    if (h.errors.length === 0)
      return {
        key,
        state: "broken",
        fresh: [],
        preexisting: 0,
        detail: `exit ${h.exit} with no error line: it did not typecheck (read ${key}.log)`,
      };
    const b = base?.[key];
    if (!b)
      return {
        key,
        state: "new",
        fresh: h.errors,
        preexisting: 0,
        detail: `${h.errors.length} error(s) and no baseline to compare with: all read as new`,
      };
    const fresh = newErrors(h.errors, b.errors);
    const preexisting = h.errors.length - fresh.length;
    if (fresh.length)
      return {
        key,
        state: "new",
        fresh,
        preexisting,
        detail: `${fresh.length} new error(s) this change introduces (${preexisting} also at the base)`,
      };
    return {
      key,
      state: "preexisting",
      fresh: [],
      preexisting,
      detail: `${preexisting} error(s), all also at the base: red on its own, not this change's`,
    };
  });
  return {
    ok: targets.every((t) => t.state === "green" || t.state === "preexisting"),
    targets,
  };
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    opts[argv[i].slice(2)] = argv[i + 1];
    i++;
  }
  return opts;
}

const readResult = (dir) =>
  dir ? JSON.parse(readFileSync(join(dir, "result.json"), "utf8")) : null;

function run(opts) {
  const root = resolve(opts.root ?? "..");
  const out = resolve(opts.out);
  const only = opts.only ? opts.only.split(",").filter(Boolean) : null;
  mkdirSync(out, { recursive: true });
  const result = {};
  for (const t of TARGETS) {
    if (only && !only.includes(t.key)) continue;
    const started = Date.now();
    const r = spawnSync(t.cmd[0], t.cmd.slice(1), {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });
    const text = `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? `\n${r.error.message}` : ""}`;
    writeFileSync(join(out, `${t.key}.log`), text);
    const errors = parseTscErrors(text);
    result[t.key] = { exit: r.status ?? 1, errors };
    console.log(
      `${t.key}: exit ${r.status ?? r.signal ?? "?"}, ${errors.length} error(s), ${Math.round((Date.now() - started) / 1000)} s`
    );
  }
  writeFileSync(join(out, "result.json"), JSON.stringify(result));
  const red = Object.entries(result)
    .filter(([, v]) => v.exit !== 0 || v.errors.length)
    .map(([k]) => k);
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `red=${red.length ? "true" : "false"}\nred_targets=${red.join(",")}\n`
    );
  return 0;
}

function verdict(opts) {
  const head = readResult(opts.head);
  const base = opts.base ? readResult(opts.base) : null;
  const v = decide(head, base);
  const lines = ["### Dependent repos typecheck", ""];
  for (const t of v.targets) {
    lines.push(`- **${t.key}**: ${t.state}: ${t.detail}`);
    const repo = TARGETS.find((x) => x.key === t.key).repo;
    for (const e of t.fresh.slice(0, 50)) {
      const where = `${repo}/${e.file}:${e.line}:${e.col}`;
      console.log(`::error title=${t.key} (new)::${where} ${e.code} ${e.msg}`);
      lines.push(`  - \`${where}\` ${e.code} ${e.msg}`);
    }
    if (t.fresh.length > 50)
      lines.push(
        `  - … ${t.fresh.length - 50} more in ${t.key}.log (artifact dependents-typecheck)`
      );
    if (t.state === "broken" || t.state === "missing")
      console.log(`::error title=${t.key}::${t.detail}`);
  }
  lines.push(
    "",
    v.ok
      ? "No new error in a dependent repo."
      : "Fix: change this PR so the dependents still typecheck, or push the dependent's change on a branch and name it in this PR's body with a `Companion: <repo>@<branch>` line (it lands right after this PR). See .claude/rules/github-ci.md."
  );
  console.log(lines.join("\n"));
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
  return v.ok ? 0 : 1;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [cmd, ...rest] = process.argv.slice(2);
  const opts = parseArgs(rest);
  try {
    process.exit(
      cmd === "run" ? run(opts) : cmd === "verdict" ? verdict(opts) : 2
    );
  } catch (e) {
    console.error(`::error::dependents-typecheck ${cmd}: ${e.message}`);
    process.exit(2);
  }
}
