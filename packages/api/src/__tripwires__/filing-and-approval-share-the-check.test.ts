import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * GUARD: a proposal that cannot apply is refused when it is FILED by the SAME
 * function its approval runs (W3, D1 slice 1; findings 68a89ded and
 * 7d7bc8aa, proposals a6a39fcd, 768f3e27, 3a1876af). A filing check that is a
 * copy drifts from the approval and refuses what would apply, or files what
 * will not: one function, called on both paths.
 *
 *   1. SESSION-UPDATE STAMPS. The check is `detectServerStampedWrites`.
 *      Approval: the `focus_session/update` executor → `applyOutputMutations`
 *      → `mergeExpectedOutputs` → the check. Filing: `fileableExpectedOutputs`
 *      → the check, called BEFORE the filing call by every door that files a
 *      `focus_session` `update` whose `data` carries `expectedOutputs`. The
 *      doors are DERIVED: every `checkPermissionOrPropose` /
 *      `checkAutomationWriteOrPropose` call in the api and jobs sources with
 *      `subjectType: "focus_session"`, `action: "update"` and an
 *      `expectedOutputs` key anywhere in its `data` literal. A new door joins
 *      by existing.
 *   2. RECIPE RUNS. The check is `planRecipeRun`. Approval: the
 *      `computer.run_recipe` handler → `queueRecipeRun` → the check. Filing:
 *      `executeCapability` calls `recipeRunRefusalAtFiling` before
 *      `createPendingProposal`, and it calls the check.
 *
 * Behaviour is proven elsewhere (`fileable-expected-outputs.test.ts`,
 * governance-seams M5b, `focus-sessions.patch-stamps.test.ts`,
 * `hosted-verbs.pglite.test.ts`, `execute-capability.recipe-at-filing.test.ts`);
 * this guard holds the WIRING.
 *
 * Does NOT cover: that the value filed is the one the check returned (a door
 * that calls `fileableExpectedOutputs` and then files the raw list passes);
 * a filing door whose `data` gets `expectedOutputs` through a spread of a
 * variable (`...patch`), which no literal shows; the executor link is checked
 * per FILE (`executors/focus-session.ts` calls `applyOutputMutations`), not
 * per function; a call guarded by a condition that is never true.
 */

const here = fileURLToPath(new URL(".", import.meta.url));
const API_SRC = resolve(here, "..");
const JOBS_SRC = resolve(API_SRC, "..", "..", "jobs", "src");

const UPDATE_SESSION = join(
  API_SRC,
  "services",
  "focus-sessions",
  "update-session.ts"
);
const SESSION_EXECUTOR = join(
  API_SRC,
  "routers",
  "proposals",
  "executors",
  "focus-session.ts"
);
const HOSTED_VERBS = join(API_SRC, "services", "host-jobs", "hosted-verbs.ts");
const BUILTIN_VERBS = join(
  API_SRC,
  "services",
  "capabilities",
  "builtin-verbs.ts"
);
const EXECUTE_CAPABILITY = join(
  API_SRC,
  "services",
  "capabilities",
  "execute-capability.ts"
);

const FILING_CALLS = new Set([
  "checkPermissionOrPropose",
  "checkAutomationWriteOrPropose",
]);

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true
  );
}

function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  node.forEachChild((c) => walk(c, visit));
}

type FnNode =
  | ts.FunctionDeclaration
  | ts.ArrowFunction
  | ts.FunctionExpression
  | ts.MethodDeclaration;

function isFn(n: ts.Node): n is FnNode {
  return (
    ts.isFunctionDeclaration(n) ||
    ts.isArrowFunction(n) ||
    ts.isFunctionExpression(n) ||
    ts.isMethodDeclaration(n)
  );
}

/** The name of a call's callee (`f(…)`, `await import(…).f`, `x.f(…)`). */
function calleeName(call: ts.CallExpression): string | null {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return null;
}

/** The calls made directly in `fn`'s body, not in a nested function. */
function directCalls(fn: ts.Node): ts.CallExpression[] {
  const out: ts.CallExpression[] = [];
  const visit = (n: ts.Node, top: boolean): void => {
    if (!top && isFn(n)) return;
    if (ts.isCallExpression(n)) out.push(n);
    n.forEachChild((c) => visit(c, false));
  };
  visit(fn, true);
  return out;
}

/** A top-level `function name` or `const name = (…) => …`. */
function namedFunction(sf: ts.SourceFile, name: string): FnNode {
  let found: FnNode | null = null;
  walk(sf, (n) => {
    if (found) return;
    if (ts.isFunctionDeclaration(n) && n.name?.text === name) found = n;
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.name.text === name &&
      n.initializer &&
      isFn(n.initializer)
    )
      found = n.initializer;
  });
  if (!found) throw new Error(`${sf.fileName}: no function ${name}`);
  return found;
}

function calls(file: string, fnName: string, callee: string): boolean {
  return directCalls(namedFunction(parse(file), fnName)).some(
    (c) => calleeName(c) === callee
  );
}

/** First position of a direct call to `callee` in `fn`, or -1. */
function firstCallAt(fn: ts.Node, callee: string): number {
  const hit = directCalls(fn).find((c) => calleeName(c) === callee);
  return hit ? hit.getStart() : -1;
}

function stringProp(obj: ts.ObjectLiteralExpression, key: string) {
  for (const p of obj.properties) {
    if (
      ts.isPropertyAssignment(p) &&
      p.name.getText() === key &&
      ts.isStringLiteral(p.initializer)
    )
      return p.initializer.text;
  }
  return null;
}

/** `data: { … expectedOutputs … }`, at any depth of the literal. */
function dataCarriesExpectedOutputs(obj: ts.ObjectLiteralExpression): boolean {
  const data = obj.properties.find(
    (p): p is ts.PropertyAssignment =>
      ts.isPropertyAssignment(p) && p.name.getText() === "data"
  );
  if (!data) return false;
  let carries = false;
  walk(data.initializer, (n) => {
    if (
      (ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n)) &&
      n.name.getText() === "expectedOutputs"
    )
      carries = true;
  });
  return carries;
}

function* sources(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (["node_modules", "__tests__", "__tripwires__"].includes(e.name))
        continue;
      yield* sources(p);
    } else if (
      p.endsWith(".ts") &&
      !p.endsWith(".test.ts") &&
      !p.endsWith(".d.ts")
    ) {
      yield p;
    }
  }
}

interface FilingDoor {
  where: string;
  /** The filing call's position, and the function holding it. */
  at: number;
  fn: FnNode | null;
}

/** Every door that files a session update carrying `expectedOutputs`. */
function stampFilingDoors(): FilingDoor[] {
  const doors: FilingDoor[] = [];
  for (const root of [API_SRC, JOBS_SRC]) {
    for (const file of sources(root)) {
      const text = readFileSync(file, "utf8");
      if (!text.includes("focus_session")) continue;
      const sf = parse(file);
      const visit = (n: ts.Node, fn: FnNode | null): void => {
        const inner = isFn(n) ? n : fn;
        if (
          ts.isCallExpression(n) &&
          FILING_CALLS.has(calleeName(n) ?? "") &&
          n.arguments[0] &&
          ts.isObjectLiteralExpression(n.arguments[0])
        ) {
          const arg = n.arguments[0];
          if (
            stringProp(arg, "subjectType") === "focus_session" &&
            stringProp(arg, "action") === "update" &&
            dataCarriesExpectedOutputs(arg)
          ) {
            const line = sf.getLineAndCharacterOfPosition(n.getStart()).line;
            doors.push({
              where: `${relative(API_SRC, file)}:${line + 1}`,
              at: n.getStart(),
              fn: inner,
            });
          }
        }
        n.forEachChild((c) => visit(c, inner));
      };
      visit(sf, null);
    }
  }
  return doors;
}

describe("filing and approval share the check", () => {
  describe("session-update stamps: detectServerStampedWrites", () => {
    it("the approval reaches the check: executor → applyOutputMutations → mergeExpectedOutputs → check", () => {
      let executorApplies = false;
      walk(parse(SESSION_EXECUTOR), (n) => {
        if (ts.isCallExpression(n) && calleeName(n) === "applyOutputMutations")
          executorApplies = true;
      });
      expect(executorApplies).toBe(true);
      expect(
        calls(UPDATE_SESSION, "applyOutputMutations", "mergeExpectedOutputs")
      ).toBe(true);
      expect(
        calls(
          UPDATE_SESSION,
          "mergeExpectedOutputs",
          "detectServerStampedWrites"
        )
      ).toBe(true);
    });

    it("the filing check is the same check: fileableExpectedOutputs → detectServerStampedWrites", () => {
      expect(
        calls(
          UPDATE_SESSION,
          "fileableExpectedOutputs",
          "detectServerStampedWrites"
        )
      ).toBe(true);
    });

    it("every door that files a slot list runs fileableExpectedOutputs before it files", () => {
      const doors = stampFilingDoors();
      // Non-vacuity: the two doors known today are seen (the MCP door and the
      // Hub PATCH). A scan that sees neither proves nothing.
      expect(doors.map((d) => d.where.split(":")[0])).toEqual(
        expect.arrayContaining([
          "services/focus-sessions/update-session.ts",
          "routers/hub-protocol/rest/focus-sessions.ts",
        ])
      );
      const unchecked = doors
        .filter((d) => {
          if (!d.fn) return true;
          const at = firstCallAt(d.fn, "fileableExpectedOutputs");
          return at < 0 || at > d.at;
        })
        .map((d) => d.where);
      expect(unchecked).toEqual([]);
    });

    it("self-check: the scan sees a door in a literal sample, and misses one without the slot list", () => {
      const sample = ts.createSourceFile(
        "sample.ts",
        `async function door() {
           return checkPermissionOrPropose({ subjectType: "focus_session", action: "update",
             data: { id, ...(x ? { expectedOutputs: x } : {}) } });
         }
         async function other() {
           return checkPermissionOrPropose({ subjectType: "focus_session", action: "update",
             data: { id, status } });
         }`,
        ts.ScriptTarget.Latest,
        true
      );
      const seen: string[] = [];
      walk(sample, (n) => {
        if (
          ts.isCallExpression(n) &&
          ts.isObjectLiteralExpression(n.arguments[0]!) &&
          dataCarriesExpectedOutputs(
            n.arguments[0] as ts.ObjectLiteralExpression
          )
        ) {
          let up: ts.Node = n;
          while (!ts.isFunctionDeclaration(up)) up = up.parent;
          seen.push(up.name!.text);
        }
      });
      expect(seen).toEqual(["door"]);
    });
  });

  describe("recipe runs: planRecipeRun", () => {
    it("the approval reaches the check: computer.run_recipe → runRecipeHandler → queueRecipeRun → check", () => {
      const builtin = readFileSync(BUILTIN_VERBS, "utf8");
      expect(builtin).toMatch(/"computer\.run_recipe":\s*runRecipeHandler,/);
      expect(calls(BUILTIN_VERBS, "runRecipeHandler", "queueRecipeRun")).toBe(
        true
      );
      expect(calls(HOSTED_VERBS, "queueRecipeRun", "planRecipeRun")).toBe(true);
    });

    it("the filing check is the same check: recipeRunRefusalAtFiling → planRecipeRun", () => {
      expect(
        calls(BUILTIN_VERBS, "recipeRunRefusalAtFiling", "planRecipeRun")
      ).toBe(true);
    });

    it("executeCapability runs the filing check before the proposal is filed", () => {
      const execute = namedFunction(
        parse(EXECUTE_CAPABILITY),
        "executeCapability"
      );
      const check = firstCallAt(execute, "recipeRunRefusalAtFiling");
      const file = firstCallAt(execute, "createPendingProposal");
      expect(file).toBeGreaterThan(0);
      expect(check).toBeGreaterThan(0);
      expect(check).toBeLessThan(file);
    });
  });
});
