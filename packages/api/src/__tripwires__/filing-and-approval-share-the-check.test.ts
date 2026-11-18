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
 *      the one filing check's `capability.run` entry calls
 *      `recipeRunRefusalAtFiling`, and it calls the check.
 *   3. THE ONE FILING CHECK (`can-apply.ts`, plan 8032a127 D1). The door
 *      that inserts every API-filed pending row, `createPendingProposalRow`,
 *      calls `proposalCannotApply` before `insertPendingProposal` (a caller
 *      that asked it itself, before its transaction, files with
 *      `canApplyAsked`: `createProposal`); a revision
 *      asks it too (`checkRevisedPayload`), and no door-local copy is left
 *      (`REVISED_PAYLOAD_VALIDATORS`, `executeCapability`'s own recipe call).
 *      Every entry of its table is DERIVED from the source and must name the
 *      function its approval runs (`APPROVAL_TWINS` below): an entry with no
 *      proven twin goes red, so a new kind joins by existing.
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

const CAN_APPLY = join(API_SRC, "services", "proposals", "can-apply.ts");
const PERMISSION_CHECK = join(API_SRC, "utils", "permission-check.ts");
const PROPOSALS_SERVICE = join(
  API_SRC,
  "services",
  "proposals",
  "proposals-service.ts"
);
const PLAYBOOKS_ROUTER = join(API_SRC, "routers", "playbooks.ts");
const PLAYBOOK_EXECUTOR = join(
  API_SRC,
  "routers",
  "proposals",
  "executors",
  "playbook.ts"
);
const MATERIALIZER = join(JOBS_SRC, "workers", "materializer.ts");

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

    it("executeCapability keeps no copy: the check runs inside createPendingProposal, and its refusal is mapped", () => {
      const execute = namedFunction(
        parse(EXECUTE_CAPABILITY),
        "executeCapability"
      );
      expect(firstCallAt(execute, "createPendingProposal")).toBeGreaterThan(0);
      let ownCall = false;
      walk(execute, (n) => {
        if (
          ts.isCallExpression(n) &&
          calleeName(n) === "recipeRunRefusalAtFiling"
        )
          ownCall = true;
      });
      expect(ownCall).toBe(false);
      let mapped = false;
      walk(execute, (n) => {
        if (ts.isCallExpression(n) && calleeName(n) === "filingRefusalOf")
          mapped = true;
      });
      expect(mapped).toBe(true);
    });
  });

  describe("the one filing check: proposalCannotApply", () => {
    /**
     * Each entry of `CAN_APPLY`: the function it calls (`calls`, defined in
     * `callsIn`), the function both sides share (`shared`), and where the
     * APPROVAL calls it (a function of a file, or the file alone when the
     * approval replays through a router procedure).
     */
    const APPROVAL_TWINS: Record<
      string,
      {
        calls: string;
        callsIn: string;
        shared: string;
        approval: { file: string; fn?: string };
      }
    > = {
      "capability.run": {
        calls: "recipeRunRefusalAtFiling",
        callsIn: BUILTIN_VERBS,
        shared: "planRecipeRun",
        approval: { file: HOSTED_VERBS, fn: "queueRecipeRun" },
      },
      "playbook/create": {
        calls: "assertRevisedPlaybookPayload",
        callsIn: PLAYBOOKS_ROUTER,
        shared: "assertPlaybookDefinitionWritable",
        approval: { file: PLAYBOOKS_ROUTER },
      },
      "playbook/update": {
        calls: "assertRevisedPlaybookPayload",
        callsIn: PLAYBOOKS_ROUTER,
        shared: "assertPlaybookDefinitionWritable",
        approval: { file: PLAYBOOKS_ROUTER },
      },
      "command/execute": {
        calls: "commandPolicyRefusal",
        callsIn: "",
        shared: "commandPolicyRefusal",
        approval: { file: MATERIALIZER },
      },
      "focus_session/update": {
        calls: "detectServerStampedWrites",
        callsIn: "",
        shared: "detectServerStampedWrites",
        approval: { file: UPDATE_SESSION, fn: "mergeExpectedOutputs" },
      },
    };

    /** `callee` is called by `fn` of `file`, or anywhere in `file`. */
    function reaches(file: string, fn: string | undefined, callee: string) {
      if (fn) return calls(file, fn, callee);
      let hit = false;
      walk(parse(file), (n) => {
        if (ts.isCallExpression(n) && calleeName(n) === callee) hit = true;
      });
      return hit;
    }

    /** The entries of `CAN_APPLY`, each with the calls its function makes. */
    function canApplyEntries(): Map<string, Set<string>> {
      const out = new Map<string, Set<string>>();
      walk(parse(CAN_APPLY), (n) => {
        if (
          ts.isVariableDeclaration(n) &&
          ts.isIdentifier(n.name) &&
          n.name.text === "CAN_APPLY" &&
          n.initializer &&
          ts.isObjectLiteralExpression(n.initializer)
        ) {
          for (const p of n.initializer.properties) {
            if (!ts.isPropertyAssignment(p) || !ts.isStringLiteral(p.name))
              continue;
            const called = new Set<string>();
            walk(p.initializer, (c) => {
              if (ts.isCallExpression(c)) {
                const name = calleeName(c);
                if (name) called.add(name);
              }
            });
            out.set(p.name.text, called);
          }
        }
      });
      return out;
    }

    it("createPendingProposalRow asks it before the row is inserted", () => {
      const row = namedFunction(parse(PERMISSION_CHECK), "createPendingProposalRow");
      const check = firstCallAt(row, "proposalCannotApply");
      const insert = firstCallAt(row, "insertPendingProposal");
      expect(insert).toBeGreaterThan(0);
      expect(check).toBeGreaterThan(0);
      expect(check).toBeLessThan(insert);
    });

    it("a caller that files with `canApplyAsked` asked the check itself first (createProposal, before its transaction)", () => {
      const sf = parse(PERMISSION_CHECK);
      const skips: Array<{ fn: FnNode | null; at: number }> = [];
      const visit = (n: ts.Node, fn: FnNode | null): void => {
        const inner = isFn(n) ? n : fn;
        if (
          ts.isCallExpression(n) &&
          calleeName(n) === "createPendingProposalRow" &&
          n.arguments[2] &&
          /canApplyAsked/.test(n.arguments[2].getText())
        )
          skips.push({ fn: inner, at: n.getStart() });
        n.forEachChild((c) => visit(c, inner));
      };
      visit(sf, null);
      // Non-vacuity: createProposal's call is seen.
      expect(skips.length).toBeGreaterThanOrEqual(1);
      const unasked = skips.filter((s) => {
        // The call sits in the transaction's callback: ask of the function
        // that opens it, the outermost function holding the call.
        let outer: ts.Node | null = s.fn;
        let top: FnNode | null = s.fn;
        while (outer) {
          if (isFn(outer)) top = outer;
          outer = outer.parent;
        }
        if (!top) return true;
        let asked = -1;
        walk(top, (n) => {
          if (
            asked < 0 &&
            ts.isCallExpression(n) &&
            calleeName(n) === "proposalCannotApply"
          )
            asked = n.getStart();
        });
        return asked < 0 || asked > s.at;
      });
      expect(unasked).toEqual([]);
      const createProposal = namedFunction(sf, "createProposal");
      const asked = firstCallAt(createProposal, "proposalCannotApply");
      const tx = firstCallAt(createProposal, "transaction");
      expect(asked).toBeGreaterThan(0);
      expect(asked).toBeLessThan(tx);
    });

    it("a revision asks the same check, and no revise-only copy is left", () => {
      expect(
        calls(PROPOSALS_SERVICE, "checkRevisedPayload", "proposalCannotApply")
      ).toBe(true);
      expect(readFileSync(PROPOSALS_SERVICE, "utf8")).not.toMatch(
        /REVISED_PAYLOAD_VALIDATORS/
      );
    });

    it("every entry calls the function its approval runs, and has a declared twin", () => {
      const entries = canApplyEntries();
      // Non-vacuity, and a new entry joins by existing: the table must name
      // exactly the entries the source declares.
      expect([...entries.keys()].sort()).toEqual(
        Object.keys(APPROVAL_TWINS).sort()
      );
      const problems: string[] = [];
      for (const [key, called] of entries) {
        const twin = APPROVAL_TWINS[key]!;
        // Directly, or through one local helper of can-apply.ts.
        const entryCalls =
          called.has(twin.calls) ||
          [...called].some((c) => {
            try {
              return calls(CAN_APPLY, c, twin.calls);
            } catch {
              return false;
            }
          });
        if (!entryCalls) problems.push(`${key}: does not call ${twin.calls}`);
        if (
          twin.calls !== twin.shared &&
          !calls(twin.callsIn, twin.calls, twin.shared)
        )
          problems.push(`${key}: ${twin.calls} does not call ${twin.shared}`);
        if (!reaches(twin.approval.file, twin.approval.fn, twin.shared))
          problems.push(
            `${key}: the approval (${relative(API_SRC, twin.approval.file)}${twin.approval.fn ? ` ${twin.approval.fn}` : ""}) does not call ${twin.shared}`
          );
      }
      expect(problems).toEqual([]);
    });

    it("the playbook approval replays the router procedures that run the definition check", () => {
      const replays = readFileSync(PLAYBOOK_EXECUTOR, "utf8");
      expect(replays).toMatch(/playbookCaller\.create\(/);
      expect(replays).toMatch(/playbookCaller\.update\(/);
    });

    it("self-check: the entry scan sees a literal sample's keys and calls", () => {
      const sf = ts.createSourceFile(
        "sample.ts",
        `const CAN_APPLY = { "a/b": async (p) => helper(p), "c": (p) => other(p) };`,
        ts.ScriptTarget.Latest,
        true
      );
      const keys: string[] = [];
      walk(sf, (n) => {
        if (
          ts.isVariableDeclaration(n) &&
          n.initializer &&
          ts.isObjectLiteralExpression(n.initializer)
        )
          for (const p of n.initializer.properties)
            if (ts.isPropertyAssignment(p) && ts.isStringLiteral(p.name))
              keys.push(p.name.text);
      });
      expect(keys).toEqual(["a/b", "c"]);
    });
  });
});
