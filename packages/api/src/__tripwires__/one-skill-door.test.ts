import { describe, it, expect } from "vitest";
import ts from "typescript";
import { readFileSync, readdirSync } from "fs";
import { join, relative } from "path";

/**
 * TRIPWIRE — code skills run through ONE door (R2, code-runtime plan v2).
 *
 * `services/skills/run-skill.ts` picks where a code skill runs: the pod's own
 * sandbox (default) or the Intelligence Service (`SKILL_RUNTIME=is`, rollback).
 * Before R2, three doors called the IS themselves (the person's Run and both
 * dry-runs), so the pod's runtime switch moved only some runs and the rest kept
 * running without the agent, the session or the verb act. A door that calls a
 * runtime directly again would silently split the runtime back in two.
 *
 * THE SET IS DERIVED: every non-test source file under the backend's
 * `packages/* /src` and `apps/* /src`. In it:
 *   1. only `run-skill.ts` CALLS a runtime (`runSkillInSandbox`,
 *      `executeSkillViaIS`, `dryRunSkillViaIS`);
 *   2. only the sandbox itself (`run-skill-in-sandbox.ts` and `runner/`)
 *      calls the doors BELOW it — `runIsolate`, `buildSkillBridges`,
 *      `getSkillRunner`, `evaluateSkill` — which run code with no
 *      `active && approved` check: that check lives in `runSkillInSandbox`;
 *   3. only `execute-skill-via-is.ts` names the IS skill routes in a literal
 *      (`/api/skills/execute`, or a template whose tail is exactly `/dry-run`).
 * A call is `name(…)` or `x.name(…)` (a property call: `(await
 * import("…")).runSkillInSandbox(…)`, the pattern used to break import cycles).
 *
 * WHAT IT CANNOT SEE: a runtime called through an alias (`const run =
 * runSkillInSandbox; run(…)`), a destructured or element-access call
 * (`x["runIsolate"](…)`), or a route built without its path in a literal.
 */

const BACKEND_ROOT = join(process.cwd(), "..", "..");

const RUNTIME_CALLS = [
  "runSkillInSandbox",
  "executeSkillViaIS",
  "dryRunSkillViaIS",
];
/** Run code with no approval check: only the sandbox may call them. */
const SANDBOX_INTERNALS = [
  "runIsolate",
  "buildSkillBridges",
  "getSkillRunner",
  "evaluateSkill",
];
const SANDBOX = "packages/api/src/services/skills/run-skill-in-sandbox.ts";
const RUNNER_DIR = "packages/api/src/services/skills/runner/";
const DOOR = "packages/api/src/services/skills/run-skill.ts";
const IS_WIRE = "packages/api/src/services/skills/execute-skill-via-is.ts";

function tsFiles(dir: string, acc: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) tsFiles(p, acc);
    else if (
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".d.ts")
    ) {
      acc.push(p);
    }
  }
  return acc;
}

function sourceRoots(): string[] {
  const roots: string[] = [];
  for (const group of ["packages", "apps"]) {
    const base = join(BACKEND_ROOT, group);
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (entry.isDirectory()) roots.push(join(base, entry.name, "src"));
    }
  }
  return roots;
}

/** Literal texts (strings + template pieces) and called identifiers of a file. */
function scan(file: string, text: string) {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const literals: string[] = [];
  const calls = new Set<string>();
  const visit = (node: ts.Node) => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      literals.push(node.text);
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee)) calls.add(callee.text);
      else if (ts.isPropertyAccessExpression(callee))
        calls.add(callee.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { literals, calls };
}

function namesIsSkillRoute(literals: string[]): boolean {
  return literals.some(
    (l) => l.endsWith("/api/skills/execute") || l === "/dry-run"
  );
}

describe("tripwire: code skills run through one door", () => {
  const files = sourceRoots().flatMap((root) => tsFiles(root));
  const scanned = files
    .filter((f) => {
      const text = readFileSync(f, "utf8");
      return (
        RUNTIME_CALLS.some((c) => text.includes(c)) ||
        SANDBOX_INTERNALS.some((c) => text.includes(c)) ||
        text.includes("/api/skills/execute") ||
        text.includes("/dry-run")
      );
    })
    .map((f) => ({
      rel: relative(BACKEND_ROOT, f),
      ...scan(f, readFileSync(f, "utf8")),
    }));

  it("the scan sees the backend, the door and its callers (non-vacuity)", () => {
    expect(files.length).toBeGreaterThan(1000);
    const door = scanned.find((f) => f.rel === DOOR);
    expect(door, "run-skill.ts not scanned").toBeDefined();
    for (const c of RUNTIME_CALLS) expect(door!.calls.has(c)).toBe(true);
    // The sandbox reaches every internal it guards (else the rule is moot).
    const sandbox = scanned.find((f) => f.rel === SANDBOX);
    expect(sandbox, "run-skill-in-sandbox.ts not scanned").toBeDefined();
    for (const c of ["runIsolate", "buildSkillBridges", "getSkillRunner"])
      expect(sandbox!.calls.has(c), `the sandbox no longer calls ${c}`).toBe(
        true
      );
    expect(
      scanned.some(
        (f) => f.rel.startsWith(RUNNER_DIR) && f.calls.has("evaluateSkill")
      ),
      "no runner file calls evaluateSkill"
    ).toBe(true);
    const wire = scanned.find((f) => f.rel === IS_WIRE);
    expect(wire && namesIsSkillRoute(wire.literals)).toBe(true);
    // The four doors that run a code skill call `runSkill`.
    for (const caller of [
      "packages/api/src/services/capabilities/execute-capability.ts",
      "packages/api/src/routers/skills.ts",
      "packages/api/src/routers/capabilities.ts",
      "packages/api/src/routers/hub-protocol/rest/skills-crud.ts",
    ]) {
      const text = readFileSync(join(BACKEND_ROOT, caller), "utf8");
      expect(
        scan(caller, text).calls.has("runSkill"),
        `${caller} no longer calls runSkill`
      ).toBe(true);
    }
  });

  it("the matcher sees a call and an IS route, not a route string of its own", () => {
    const sample = scan(
      "s.ts",
      "await runSkillInSandbox({}); fetch(`${is}/api/skills/${id}/dry-run`);"
    );
    expect(sample.calls.has("runSkillInSandbox")).toBe(true);
    expect(namesIsSkillRoute(sample.literals)).toBe(true);
    // A property call — how a lazily imported module is called.
    const lazy = scan(
      "l.ts",
      'const r = await (await import("./run-skill-in-sandbox.js")).runSkillInSandbox({}); await mod.runIsolate({});'
    );
    expect(lazy.calls.has("runSkillInSandbox")).toBe(true);
    expect(lazy.calls.has("runIsolate")).toBe(true);
    // A mention is not a call.
    expect(
      scan(
        "m.ts",
        "import { runIsolate } from './x'; const f = runIsolate;"
      ).calls.has("runIsolate")
    ).toBe(false);
    expect(
      namesIsSkillRoute(
        scan("r.ts", 'app.post("/skills/:id/dry-run", h);').literals
      )
    ).toBe(false);
  });

  it("only run-skill.ts calls a skill runtime", () => {
    const offenders = scanned
      .filter((f) => f.rel !== DOOR)
      .filter((f) => RUNTIME_CALLS.some((c) => f.calls.has(c)))
      .map((f) => f.rel);
    expect(
      offenders,
      "These files run a code skill without the one door. Call `runSkill` " +
        "(services/skills/run-skill.ts) instead."
    ).toEqual([]);
  });

  it("only the sandbox calls the doors below it (no approval check there)", () => {
    const offenders = scanned
      .filter((f) => f.rel !== SANDBOX && !f.rel.startsWith(RUNNER_DIR))
      .filter((f) => SANDBOX_INTERNALS.some((c) => f.calls.has(c)))
      .map((f) => f.rel);
    expect(
      offenders,
      "These files run skill code below the one door, where nothing checks " +
        "that the skill is active and approved. Call `runSkill` " +
        "(services/skills/run-skill.ts) instead."
    ).toEqual([]);
  });

  it("only execute-skill-via-is.ts names an IS skill route", () => {
    const offenders = scanned
      .filter((f) => f.rel !== IS_WIRE)
      .filter((f) => namesIsSkillRoute(f.literals))
      .map((f) => f.rel);
    expect(
      offenders,
      "These files call the Intelligence Service's skill routes directly. " +
        "Go through `runSkill` (services/skills/run-skill.ts)."
    ).toEqual([]);
  });
});
