/**
 * TRIPWIRE — no `playbook_run` execution path bypasses the node's MODE.
 *
 * A propose-mode node must never start a session. Two ways that could break
 * while every type stays green:
 *
 *   A. A CALL SITE drops `mode` on the way in. `automation-executor.ts`
 *      rebuilds the node data field-by-field at the top level; a call site
 *      that forgets `mode` turns every propose node into a RUN. Rule: every
 *      `executePlaybookRun(` call passes either the node's data WHOLESALE
 *      (`<x>.data as …`, mode rides along) or an object literal that forwards
 *      `mode: <x>.mode`.
 *   B. A SESSION-BIRTH SLOT is reached before (or around) the propose branch.
 *      The runner (`getPlaybookRunner`, where the agent kickoff lives) and the
 *      scheduler (`getSessionScheduler`) may be called ONLY inside
 *      `steps/playbook-run.ts`, and only AFTER its `if (mode === "propose")`
 *      branch, which must `return` a proposal.
 *
 * The scanned set is DERIVED (every non-test .ts under jobs/src and api/src),
 * never hand-listed, so a new caller joins the scan by existing.
 *
 * WHAT THIS DOES NOT COVER, measured: it reads source text. It cannot see a
 * call that forwards a WRONG value under the right key (`mode: data.agentType`
 * passes), and "after the branch" is textual order inside one function — it
 * would not notice the branch being moved into dead code. The behavioural half
 * (runner never called in propose mode) is `steps/__tests__/playbook-run-propose.test.ts`.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const PKGS = join(__dirname, "..", "..", "..", "..");
const ROOTS = [join(PKGS, "jobs", "src"), join(PKGS, "api", "src")];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) out.push(p);
  }
  return out;
}

const FILES = ROOTS.flatMap((r) => walk(r)).map((path) => ({
  path,
  rel: relative(PKGS, path),
  src: readFileSync(path, "utf8"),
}));

/** The argument text of a call starting right after `(` at `open`. */
function firstArg(src: string, open: number): string {
  let i = open;
  while (/\s/.test(src[i]!)) i++;
  if (src[i] !== "{") {
    // Not a literal: read up to the first comma at depth 0.
    let depth = 0;
    let j = i;
    for (; j < src.length; j++) {
      const c = src[j]!;
      if ("({[<".includes(c)) depth++;
      else if (")}]>".includes(c)) depth--;
      else if (c === "," && depth === 0) break;
    }
    return src.slice(i, j);
  }
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}" && --depth === 0) return src.slice(i, j + 1);
  }
  return src.slice(i);
}

const CALL = /\bexecutePlaybookRun\(/g;
const SLOT_CALL = /\b(getPlaybookRunner|getSessionScheduler)\(\)/g;

function callSites(re: RegExp) {
  const sites: { rel: string; src: string; index: number; name: string }[] = [];
  for (const f of FILES) {
    for (const m of f.src.matchAll(re)) {
      const before = f.src.slice(Math.max(0, m.index! - 40), m.index!);
      // Skip the definitions themselves.
      if (/function\s*$/.test(before)) continue;
      sites.push({
        rel: f.rel,
        src: f.src,
        index: m.index!,
        name: m[1] ?? m[0],
      });
    }
  }
  return sites;
}

describe("tripwire: every playbook_run path honours the node's mode", () => {
  const calls = callSites(CALL);
  const slots = callSites(SLOT_CALL);

  it("the scan is not vacuous — it sees what it hunts", () => {
    expect(FILES.length).toBeGreaterThan(200);
    // Today: the loop-child and the top-level call in automation-executor.ts.
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(slots.map((s) => s.name).sort()).toEqual(
      expect.arrayContaining(["getPlaybookRunner", "getSessionScheduler"])
    );
    // Self-check on a literal sample: the arg reader sees both shapes.
    const lit = "executePlaybookRun({ a: 1, mode: data.mode }, ctx)";
    expect(firstArg(lit, lit.indexOf("(") + 1)).toContain("mode: data.mode");
    const cast = "executePlaybookRun(childNode.data as X, ctx)";
    expect(firstArg(cast, cast.indexOf("(") + 1)).toBe("childNode.data as X");
  });

  it("A. every executePlaybookRun call forwards the mode (wholesale data or `mode: x.mode`)", () => {
    const offenders = calls
      .map((c) => ({
        ...c,
        arg: firstArg(c.src, c.index + "executePlaybookRun(".length),
      }))
      .filter(
        (c) =>
          !/^\w+\.data\b/.test(c.arg) && !/\bmode:\s*\w+\.mode\b/.test(c.arg)
      )
      .map((c) => `${c.rel}: ${c.arg.slice(0, 80)}`);
    expect(offenders).toEqual([]);
  });

  it("B. the runner/scheduler slots are reached only after the propose branch returns", () => {
    const step = FILES.find((f) =>
      f.rel.endsWith("jobs/src/workers/steps/playbook-run.ts")
    );
    expect(step).toBeDefined();
    const branch = step!.src.indexOf('if (mode === "propose") {');
    expect(branch).toBeGreaterThan(-1);
    // The branch files the proposal and returns — it does not fall through.
    const body = firstArg(
      step!.src,
      branch + 'if (mode === "propose") '.length
    );
    expect(body).toContain("proposeRulePlaybookRun(");
    expect(body).toMatch(/\breturn\b/);

    const misplaced = slots
      .filter(
        (s) =>
          !s.rel.endsWith("jobs/src/workers/steps/playbook-run.ts") ||
          s.index < branch
      )
      .map((s) => `${s.rel}@${s.index}: ${s.name}`);
    expect(misplaced).toEqual([]);
  });
});
