/**
 * F7 (29 Oct, pod document 9ca0c96b "How our AI work flows"): every main
 * commit gets a CI verdict. ci.yml's concurrency group decides it: GitHub
 * keeps ONE pending run per group and replaces it with each newer one, even
 * with cancel-in-progress off. A group keyed by branch therefore cancelled
 * 215 of 315 main push runs (20-29 Oct), and a pod takes only a commit whose
 * own push run is green (scripts/ci/release-gate-wait.mjs).
 *
 * This EVALUATES ci.yml's real `concurrency:` expressions (a small evaluator
 * of the GitHub expression subset they use) for each event the workflow
 * declares, instead of matching their text: any spelling that gives the same
 * groups passes, any that merges two main commits into one group fails.
 *
 * Not covered: a JOB-level `concurrency:` (asserted absent below), and how
 * GitHub schedules runs once the groups are right (runner cap, queue order).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const CI = readFileSync(join(REPO, ".github/workflows/ci.yml"), "utf8");

// ── a GitHub-expression evaluator, for the subset ci.yml's group uses ──────
type Ctx = Record<string, string>;
type Val = string | boolean | number | null;

export function evaluate(expr: string, ctx: Ctx): Val {
  const toks = expr.match(/'(?:[^']|'')*'|&&|\|\||==|!=|[()!]|[\w.-]+|\S/g);
  if (!toks) throw new Error(`empty expression: ${expr}`);
  let i = 0;
  const peek = () => toks[i];
  const next = () => toks[i++];
  const truthy = (v: Val) => !(v === "" || v === null || v === false || v === 0);
  const eq = (a: Val, b: Val) =>
    typeof a === "string" && typeof b === "string"
      ? a.toLowerCase() === b.toLowerCase() // GitHub compares strings ignoring case
      : a === b;
  function primary(): Val {
    const t = next();
    if (t === undefined) throw new Error(`unexpected end: ${expr}`);
    if (t === "(") {
      const v = or();
      if (next() !== ")") throw new Error(`missing ) in ${expr}`);
      return v;
    }
    if (t.startsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
    if (t === "true") return true;
    if (t === "false") return false;
    if (t === "null") return null;
    if (/^\d+$/.test(t)) return Number(t);
    if (/^[a-z_][\w-]*(\.[\w-]+)+$/i.test(t)) {
      if (!(t in ctx)) throw new Error(`context ${t} not given to the evaluator`);
      return ctx[t];
    }
    throw new Error(`unsupported token ${t} in ${expr}`);
  }
  function unary(): Val {
    if (peek() === "!") {
      next();
      return !truthy(unary());
    }
    return primary();
  }
  function equality(): Val {
    const a = unary();
    if (peek() === "==" || peek() === "!=") {
      const op = next();
      const b = unary();
      return op === "==" ? eq(a, b) : !eq(a, b);
    }
    return a;
  }
  function and(): Val {
    let a = equality();
    while (peek() === "&&") {
      next();
      const b = equality();
      a = truthy(a) ? b : a;
    }
    return a;
  }
  function or(): Val {
    let a = and();
    while (peek() === "||") {
      next();
      const b = and();
      a = truthy(a) ? a : b;
    }
    return a;
  }
  const v = or();
  if (i !== toks.length) throw new Error(`trailing tokens in ${expr}`);
  return v;
}

/** A workflow value: a whole `${{ }}` keeps its type, a template is a string. */
export function render(value: string, ctx: Ctx): Val {
  const whole = /^\$\{\{(.*)\}\}$/s.exec(value.trim());
  if (whole && !whole[1].includes("}}")) return evaluate(whole[1], ctx);
  return value.replace(/\$\{\{(.*?)\}\}/g, (_, e) =>
    String(evaluate(e, ctx) ?? "")
  );
}

// ── what ci.yml declares ─────────────────────────────────────────────────────
const block = /^concurrency:\n {2}group: (.+)\n {2}cancel-in-progress: (.+)$/m.exec(
  CI
);
const GROUP = block?.[1] ?? "";
const CANCEL = block?.[2] ?? "";
// The events that start ci.yml: the two-space keys of the top-level `on:`.
const onBlock = /^on:\n((?: {2}.*\n|\s*\n|#.*\n)+)/m.exec(CI)?.[1] ?? "";
const EVENTS = [...onBlock.matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1]);

const SHA = (c: string) => c.repeat(40);
const run = (event: string, ref: string, sha: string): Ctx => ({
  "github.workflow": "CI",
  "github.event_name": event,
  "github.ref": ref,
  "github.sha": sha,
});
// One run per case, for every event ci.yml declares (checked below).
const RUNS = {
  mainA: run("push", "refs/heads/main", SHA("a")),
  mainB: run("push", "refs/heads/main", SHA("b")),
  releaseA: run("push", "refs/heads/release/1.4", SHA("c")),
  releaseB: run("push", "refs/heads/release/1.4", SHA("d")),
  pr7a: run("pull_request", "refs/pull/7/merge", SHA("e")),
  pr7b: run("pull_request", "refs/pull/7/merge", SHA("f")),
  pr8: run("pull_request", "refs/pull/8/merge", SHA("1")),
  queueA: run(
    "merge_group",
    "refs/heads/gh-readonly-queue/main/pr-7-aaaa",
    SHA("2")
  ),
  queueB: run(
    "merge_group",
    "refs/heads/gh-readonly-queue/main/pr-8-bbbb",
    SHA("3")
  ),
};
const group = (c: Ctx, expr = GROUP) => render(expr, c);
const cancels = (c: Ctx) => render(CANCEL, c);

describe("ci.yml concurrency: every main commit gets its own verdict (F7)", () => {
  it("reads the workflow's one concurrency block and its triggers", () => {
    expect(GROUP).toContain("${{");
    expect(CANCEL).toContain("${{");
    // A job-level group could replace a main run's job just the same.
    expect(CI.match(/^\s*concurrency:/gm)).toHaveLength(1);
    expect(EVENTS.length).toBeGreaterThanOrEqual(3);
    // Every event that starts ci.yml has a case here: a new trigger fails
    // until someone decides its group.
    const covered = new Set(Object.values(RUNS).map((r) => r["github.event_name"]));
    for (const e of EVENTS) expect(covered, `event ${e}`).toContain(e);
  });

  it("the evaluator is GitHub's: && and || return operands, == ignores case", () => {
    const c = run("push", "refs/heads/main", SHA("a"));
    expect(evaluate("github.event_name == 'PUSH'", c)).toBe(true);
    expect(evaluate("github.event_name == 'push' && github.sha || 'x'", c)).toBe(
      SHA("a")
    );
    expect(evaluate("github.event_name == 'pr' && github.sha || 'x'", c)).toBe("x");
    expect(evaluate("!(github.ref == 'refs/heads/main')", c)).toBe(false);
    expect(render("${{ github.workflow }}-${{ github.ref }}", c)).toBe(
      "CI-refs/heads/main"
    );
    expect(() => evaluate("github.unknown == 'x'", c)).toThrow(/not given/);
  });

  it("two pushes to main never share a group, and are never cancelled", () => {
    expect(group(RUNS.mainA)).not.toBe(group(RUNS.mainB));
    expect(cancels(RUNS.mainA)).toBe(false);
    expect(cancels(RUNS.mainB)).toBe(false);
    // a release branch is tagged per commit too
    expect(group(RUNS.releaseA)).not.toBe(group(RUNS.releaseB));
    expect(cancels(RUNS.releaseA)).toBe(false);
  });

  it("a pull request keeps only its newest run (unchanged)", () => {
    expect(group(RUNS.pr7a)).toBe(group(RUNS.pr7b));
    expect(group(RUNS.pr7a)).not.toBe(group(RUNS.pr8));
    expect(cancels(RUNS.pr7a)).toBe(true);
  });

  it("each merge-queue entry has its own group and is never cancelled (unchanged)", () => {
    expect(group(RUNS.queueA)).not.toBe(group(RUNS.queueB));
    expect(cancels(RUNS.queueA)).toBe(false);
  });

  it("no two runs of different kinds collide (a PR never waits on main)", () => {
    const groups = Object.entries(RUNS)
      .filter(([k]) => k !== "pr7b") // pr7a and pr7b share one by design
      .map(([, c]) => group(c));
    expect(new Set(groups).size).toBe(groups.length);
  });

  // Which rule this suite rules out: the group ci.yml had until 29 Oct.
  it("the old branch-keyed group fails this suite", () => {
    const OLD =
      "${{ github.workflow }}-${{ github.event_name == 'merge_group' && github.sha || github.ref }}";
    expect(group(RUNS.mainA, OLD)).toBe(group(RUNS.mainB, OLD));
  });
});
