/**
 * TRIPWIRE — every HIGH-RISK Synap Core builtin verb re-enters a governed door.
 *
 * ── THE HOLE THIS GUARDS ────────────────────────────────────────────────────
 * When a verb runs through `synap_run_capability`, the governance event key the
 * OUTER gate sees is a COMPILE-TIME CONSTANT:
 *
 *   CAPABILITY_RUN_PROPOSAL = { targetType: "capability", proposalType: "run" }
 *      (packages/capability-gate/src/index.ts)
 *   → decideAgentPolicy({ subjectType: "capability", action: "run", … })
 *
 * The VERB'S IDENTITY NEVER REACHES `decideAgentPolicy`. So at that outer gate:
 *   • rung 2    ADMIN_ACTIONS                        — exact equality on the
 *               event key `capability.run`           → MISSES
 *   • rung 2.08 AGENT_SCHEMA_DEFINITION_EVENT_KEYS   → MISSES
 *   • rung 2.09 AGENT_STRUCTURE_WRITE_EVENT_KEYS     → MISSES
 *   • rung 2.5  DESTRUCTIVE_ACTIONS — matches the BARE ACTION, which is
 *               literally the string "run"           → MISSES
 * and rung 2.8 lets a stored governance rule widen `capability/run` to `auto`.
 *
 * `entity.delete` is safe TODAY only because its builtin handler re-enters the
 * governed `entitiesRouter.delete`, which gates again on the REAL key — TWO
 * GATES IN SERIES. Nothing enforced the second one. This file does.
 *
 * ── WHAT IT ASSERTS ─────────────────────────────────────────────────────────
 *  1. The Core verb set is DERIVED from `SYNAP_CORE_DEFINITION.skills` (parsed
 *     from source, see "why source, not import" below) — a new verb joins the
 *     scan BY EXISTING.
 *  2. A verb is HIGH-RISK if, and only if, the event key it WOULD produce were
 *     its identity to reach the gate would hit one of the four floors above.
 *     That classification is DERIVED from the live governance-policy exports —
 *     no hand-written "dangerous verbs" list to fall behind.
 *  3. Every HIGH-RISK verb's handler must re-enter a tRPC router procedure
 *     whose body reaches `checkPermissionOrPropose`. Resolution is by AST
 *     across all three real hops (handler → router barrel → co-located
 *     procedure module); ANY hop that fails to resolve is a FAILURE, never a
 *     silent pass.
 *  4. Every OTHER verb that re-enters a router is CLASSIFIED — "gated" (and
 *     then actually proven gated) or "ungated" with a written reason. A new
 *     re-entering verb nobody classified is RED.
 *
 * ── WHAT IT DOES **NOT** COVER (measured, not implied) ──────────────────────
 *  a. It is a SOURCE analysis, not a behavioural one. It proves the identifier
 *     `checkPermissionOrPropose` appears inside the target procedure's AST
 *     subtree — NOT that the call is on the path this verb's arguments take.
 *     A procedure that gates one branch and not another passes.
 *  b. Re-entry is only recognised through the `X.createCaller(...)` +
 *     `caller.<proc>(...)` idiom. A handler that re-enters some OTHER governed
 *     door (e.g. market.install → `createPendingProposal`) is NOT seen as
 *     gated by hop 3; such verbs are handled by the classification table with
 *     an explicit reason.
 *  c. The HIGH-RISK derivation matches the verb's BARE ACTION against
 *     DESTRUCTIVE_ACTIONS and the verb's FULL NAME against the three event-key
 *     sets. A verb whose subject is spelled differently from its gate's
 *     subject is NOT matched — measured: `entity_facet.detach` gates as
 *     `facet.detach`, so the event-key sets do not see it (its action
 *     "detach" is also not in DESTRUCTIVE_ACTIONS). It is nevertheless proven
 *     gated here via the classification table.
 *  d. NO compile-time coverage floor is achievable for the verb set.
 *     `SYNAP_CORE_DEFINITION` is annotated `: CapabilityDefinition`, so
 *     `skills[].name` widens to `string` — there is no literal union to
 *     `Exclude` against. Making one would mean adding `as const` to production
 *     code. Recorded as a recommendation, not done here.
 *
 * ── WHY SOURCE, NOT IMPORT ──────────────────────────────────────────────────
 * Importing `ensure-synap-core.ts` / `builtin-verbs.ts` pulls `@synap/database`
 * and the whole router graph into the test process. The scan therefore reads
 * the two files' ASTs. To stop that being a vacuity hole, the parser REFUSES
 * anything it cannot see exactly (a spread, a computed key, a non-literal verb
 * name) instead of skipping it, and every scan carries a non-vacuity floor.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  ADMIN_ACTIONS,
  DESTRUCTIVE_ACTIONS,
  AGENT_SCHEMA_DEFINITION_EVENT_KEYS,
  AGENT_STRUCTURE_WRITE_EVENT_KEYS,
  decideAgentPolicy,
} from "@synap/governance-policy";

const HERE = dirname(fileURLToPath(import.meta.url));
const CAPABILITIES_DIR = resolve(HERE, "../services/capabilities");
const CORE_DEF_FILE = resolve(CAPABILITIES_DIR, "ensure-synap-core.ts");
const VERBS_FILE = resolve(CAPABILITIES_DIR, "builtin-verbs.ts");

// ---------------------------------------------------------------------------
// AST helpers
// ---------------------------------------------------------------------------

function parse(file: string): ts.SourceFile {
  if (!existsSync(file)) {
    throw new Error(`TRIPWIRE CANNOT RUN: source file not found: ${file}`);
  }
  return ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.ESNext,
    /* setParentNodes */ true,
    ts.ScriptKind.TS
  );
}

/** Find `export const <name> = <initializer>` (or a plain `const`). */
function findVarInitializer(
  sf: ts.SourceFile,
  name: string
): ts.Expression | null {
  let found: ts.Expression | null = null;
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer
    ) {
      found = node.initializer;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** Strip `x satisfies T` / `x as T` / `(x)` wrappers. */
function unwrap(expr: ts.Expression): ts.Expression {
  let e = expr;
  for (;;) {
    if (ts.isAsExpression(e) || ts.isSatisfiesExpression(e)) e = e.expression;
    else if (ts.isParenthesizedExpression(e)) e = e.expression;
    else return e;
  }
}

/** `router({...})` / `foo({...})` → the object literal argument. */
function objectLiteralOf(
  expr: ts.Expression
): ts.ObjectLiteralExpression | null {
  const e = unwrap(expr);
  if (ts.isObjectLiteralExpression(e)) return e;
  if (ts.isCallExpression(e) && e.arguments.length === 1) {
    const a = unwrap(e.arguments[0] as ts.Expression);
    if (ts.isObjectLiteralExpression(a)) return a;
  }
  return null;
}

function propertyNameOf(p: ts.ObjectLiteralElementLike): string | null {
  const n = p.name;
  if (!n) return null;
  if (ts.isIdentifier(n)) return n.text;
  if (ts.isStringLiteral(n)) return n.text;
  return null; // computed / numeric → refused by callers
}

/** True when the subtree contains an Identifier with this exact text.
 *  Identifiers come from the AST, so COMMENTS AND PROSE CANNOT MATCH. */
function subtreeReferences(node: ts.Node, identifier: string): boolean {
  let hit = false;
  const visit = (n: ts.Node): void => {
    if (hit) return;
    if (ts.isIdentifier(n) && n.text === identifier) {
      hit = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return hit;
}

/** Resolve a `./x.js` / `../y/z.js` specifier to a real `.ts` file on disk. */
function resolveSpecifier(fromFile: string, spec: string): string | null {
  const base = resolve(dirname(fromFile), spec);
  for (const cand of [
    base.replace(/\.js$/, ".ts"),
    `${base}.ts`,
    resolve(base, "index.ts"),
  ]) {
    if (existsSync(cand)) return cand;
  }
  return null;
}

/**
 * Find the module specifier that binds `name` in this file — via a static
 * `import { name } from "…"` OR a dynamic `const { name } = await import("…")`.
 */
function specifierBinding(sf: ts.SourceFile, name: string): string | null {
  let spec: string | null = null;
  const visit = (node: ts.Node): void => {
    if (spec) return;
    // static: import { name } from "…"
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.importClause?.namedBindings &&
      ts.isNamedImports(node.importClause.namedBindings) &&
      node.importClause.namedBindings.elements.some(
        (el) => el.name.text === name
      )
    ) {
      spec = node.moduleSpecifier.text;
      return;
    }
    // dynamic: const { name } = await import("…")
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.name.elements.some(
        (el) => ts.isIdentifier(el.name) && el.name.text === name
      ) &&
      node.initializer
    ) {
      let init: ts.Node = node.initializer;
      if (ts.isAwaitExpression(init)) init = init.expression;
      if (
        ts.isCallExpression(init) &&
        init.expression.kind === ts.SyntaxKind.ImportKeyword &&
        init.arguments.length >= 1 &&
        ts.isStringLiteral(init.arguments[0] as ts.Node)
      ) {
        spec = (init.arguments[0] as ts.StringLiteral).text;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return spec;
}

// ---------------------------------------------------------------------------
// 1. DERIVE the Core verb set from SYNAP_CORE_DEFINITION.skills
// ---------------------------------------------------------------------------

function readCoreVerbNames(): string[] {
  const sf = parse(CORE_DEF_FILE);
  const def = findVarInitializer(sf, "SYNAP_CORE_DEFINITION");
  if (!def) throw new Error("SYNAP_CORE_DEFINITION not found in source");
  const obj = objectLiteralOf(def);
  if (!obj) throw new Error("SYNAP_CORE_DEFINITION is not an object literal");
  const skillsProp = obj.properties.find((p) => propertyNameOf(p) === "skills");
  if (!skillsProp || !ts.isPropertyAssignment(skillsProp)) {
    throw new Error("SYNAP_CORE_DEFINITION.skills not found");
  }
  const arr = unwrap(skillsProp.initializer);
  if (!ts.isArrayLiteralExpression(arr)) {
    throw new Error("SYNAP_CORE_DEFINITION.skills is not an array literal");
  }
  return arr.elements.map((el, i) => {
    const e = unwrap(el as ts.Expression);
    // REFUSE anything we cannot read exactly — a spread or a computed name
    // must be a FAILURE, never a silently skipped element.
    if (!ts.isObjectLiteralExpression(e)) {
      throw new Error(
        `skills[${i}] is not an object literal (spread/computed?) — the scan ` +
          `cannot see it; widen this parser rather than letting it disappear.`
      );
    }
    const nameProp = e.properties.find((p) => propertyNameOf(p) === "name");
    if (
      !nameProp ||
      !ts.isPropertyAssignment(nameProp) ||
      !ts.isStringLiteral(unwrap(nameProp.initializer))
    ) {
      throw new Error(`skills[${i}].name is not a string literal`);
    }
    return (unwrap(nameProp.initializer) as ts.StringLiteral).text;
  });
}

// ---------------------------------------------------------------------------
// 2. DERIVE the HIGH-RISK classification from the live governance floors
// ---------------------------------------------------------------------------

const FLOOR_EVENT_KEYS = new Set<string>([
  ...ADMIN_ACTIONS,
  ...AGENT_SCHEMA_DEFINITION_EVENT_KEYS,
  ...AGENT_STRUCTURE_WRITE_EVENT_KEYS,
]);

/** Which floor(s) this verb WOULD hit if its identity reached the gate. */
function floorsHitBy(verb: string): string[] {
  const dot = verb.indexOf(".");
  const action = dot >= 0 ? verb.slice(dot + 1) : verb;
  const hits: string[] = [];
  if (DESTRUCTIVE_ACTIONS.includes(action)) hits.push("2.5 DESTRUCTIVE");
  if (ADMIN_ACTIONS.includes(verb)) hits.push("2 ADMIN");
  if (AGENT_SCHEMA_DEFINITION_EVENT_KEYS.includes(verb as never))
    hits.push("2.08 SCHEMA");
  if (AGENT_STRUCTURE_WRITE_EVENT_KEYS.includes(verb as never))
    hits.push("2.09 STRUCTURE");
  return hits;
}

// ---------------------------------------------------------------------------
// 3. DERIVE, per verb, the router re-entry its handler performs
// ---------------------------------------------------------------------------

interface Reentry {
  router: string;
  procedures: string[];
}

function readHandlerReentries(): {
  handlerByVerb: Map<string, string>;
  reentryByVerb: Map<string, Reentry>;
  sf: ts.SourceFile;
} {
  const sf = parse(VERBS_FILE);
  const registry = findVarInitializer(sf, "BUILTIN_VERBS");
  if (!registry) throw new Error("BUILTIN_VERBS not found in source");
  const obj = objectLiteralOf(registry);
  if (!obj) throw new Error("BUILTIN_VERBS is not an object literal");

  const handlerByVerb = new Map<string, string>();
  for (const p of obj.properties) {
    const key = propertyNameOf(p);
    if (!key) {
      throw new Error("BUILTIN_VERBS has a computed key the scan cannot read");
    }
    if (!ts.isPropertyAssignment(p)) {
      throw new Error(`BUILTIN_VERBS["${key}"] is not a plain assignment`);
    }
    const init = unwrap(p.initializer);
    if (!ts.isIdentifier(init)) {
      throw new Error(
        `BUILTIN_VERBS["${key}"] is not a bare handler identifier — widen the ` +
          `parser rather than letting this verb fall out of the scan.`
      );
    }
    handlerByVerb.set(key, init.text);
  }

  const reentryByVerb = new Map<string, Reentry>();
  for (const [verb, handlerName] of handlerByVerb) {
    const decl = findVarInitializer(sf, handlerName);
    if (!decl) {
      throw new Error(
        `handler ${handlerName} (verb ${verb}) has no declaration in ${VERBS_FILE}`
      );
    }
    // find `<X>Router.createCaller(...)` and the variable it is assigned to
    let routerName: string | null = null;
    let callerVar: string | null = null;
    const findCaller = (n: ts.Node): void => {
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.name.text === "createCaller" &&
        ts.isIdentifier(n.expression.expression)
      ) {
        routerName = n.expression.expression.text;
        const parent = n.parent;
        if (
          parent &&
          ts.isVariableDeclaration(parent) &&
          ts.isIdentifier(parent.name)
        ) {
          callerVar = parent.name.text;
        }
      }
      ts.forEachChild(n, findCaller);
    };
    findCaller(decl);
    if (!routerName) continue; // no re-entry — classified elsewhere
    if (!callerVar) {
      throw new Error(
        `${verb}: ${routerName}.createCaller(...) result is not bound to a ` +
          `variable — the scan cannot find which procedure is invoked.`
      );
    }
    const procedures: string[] = [];
    const findProcs = (n: ts.Node): void => {
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        ts.isIdentifier(n.expression.expression) &&
        n.expression.expression.text === callerVar
      ) {
        procedures.push(n.expression.name.text);
      }
      ts.forEachChild(n, findProcs);
    };
    findProcs(decl);
    if (procedures.length === 0) {
      // The caller ESCAPES into a helper (e.g. tool.request passes it to
      // `recordToolDemand({ caller, … })`). Follow exactly ONE hop into that
      // helper's module and collect the `caller.<proc>(…)` calls there. If the
      // hop cannot be made, that is a FAILURE — never a silent skip.
      const escaped = followCallerEscape(sf, decl, callerVar);
      if (escaped.length === 0) {
        throw new Error(
          `${verb}: createCaller(...) bound to \`${callerVar}\` but no ` +
            `\`${callerVar}.<proc>(...)\` call found, and the one-hop escape ` +
            `resolver found none either. Widen the resolver rather than ` +
            `letting this verb drop out of the scan.`
        );
      }
      reentryByVerb.set(verb, { router: routerName, procedures: escaped });
      continue;
    }
    reentryByVerb.set(verb, { router: routerName, procedures });
  }

  return { handlerByVerb, reentryByVerb, sf };
}

/**
 * ONE-HOP escape resolver. When a handler passes its tRPC `caller` into a
 * helper instead of calling a procedure directly, find that helper's module,
 * locate the function, and collect the `caller.<proc>(…)` calls inside it.
 * Returns [] when the hop cannot be made — the caller treats that as a FAILURE.
 */
function followCallerEscape(
  sf: ts.SourceFile,
  handlerDecl: ts.Node,
  callerVar: string
): string[] {
  // Find `helperFn({ …, caller, … })` or `helperFn(caller, …)`.
  let helperName: string | null = null;
  const findEscape = (n: ts.Node): void => {
    if (helperName) return;
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
      const passesCaller = n.arguments.some((a) => {
        if (ts.isIdentifier(a) && a.text === callerVar) return true;
        if (ts.isObjectLiteralExpression(a)) {
          return a.properties.some(
            (p) =>
              (ts.isShorthandPropertyAssignment(p) &&
                p.name.text === callerVar) ||
              (ts.isPropertyAssignment(p) &&
                ts.isIdentifier(p.initializer) &&
                p.initializer.text === callerVar)
          );
        }
        return false;
      });
      if (passesCaller) {
        helperName = n.expression.text;
        return;
      }
    }
    ts.forEachChild(n, findEscape);
  };
  findEscape(handlerDecl);
  if (!helperName) return [];

  const spec = specifierBinding(sf, helperName);
  if (!spec) return [];
  const file = resolveSpecifier(VERBS_FILE, spec);
  if (!file) return [];
  const helperSf = parse(file);

  let fnNode: ts.Node | null = null;
  const findFn = (n: ts.Node): void => {
    if (fnNode) return;
    if (ts.isFunctionDeclaration(n) && n.name && n.name.text === helperName) {
      fnNode = n;
      return;
    }
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.name.text === helperName &&
      n.initializer
    ) {
      fnNode = n.initializer;
      return;
    }
    ts.forEachChild(n, findFn);
  };
  findFn(helperSf);
  if (!fnNode) return [];

  const procs: string[] = [];
  const findProcs = (n: ts.Node): void => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      ts.isIdentifier(n.expression.expression) &&
      n.expression.expression.text === callerVar
    ) {
      procs.push(n.expression.name.text);
    }
    ts.forEachChild(n, findProcs);
  };
  findProcs(fnNode);
  return [...new Set(procs)];
}

// ---------------------------------------------------------------------------
// 4. Resolve router.procedure → does its body reach checkPermissionOrPropose?
// ---------------------------------------------------------------------------

type GateResult =
  | { resolved: true; gated: boolean; where: string }
  | { resolved: false; why: string };

/**
 * A top-level `function f(){…}` / `const f = (…) => …` body in this file, or null.
 */
function topLevelFunctionBody(sf: ts.SourceFile, name: string): ts.Node | null {
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name?.text === name && st.body) {
      return st.body;
    }
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (
          ts.isIdentifier(d.name) &&
          d.name.text === name &&
          d.initializer &&
          (ts.isArrowFunction(d.initializer) ||
            ts.isFunctionExpression(d.initializer))
        ) {
          return d.initializer.body;
        }
      }
    }
  }
  return null;
}

/**
 * Does this procedure body reach `checkPermissionOrPropose` — DIRECTLY, or via
 * ONE hop into a module-level helper declared in the SAME file that the body
 * calls?
 *
 * WHY THE HOP EXISTS (measured, 2026-09-21): `automationsRouter.activate` and
 * `.update` DO gate — through the local `proposeAgentActivation(...)`, which is
 * where the `checkPermissionOrPropose` call actually lives. A
 * direct-reference-only scan read that as UNGOVERNED and would have declared a
 * genuinely gated verb unsafe, which is the kind of false alarm that gets a
 * guard deleted.
 *
 * BOUNDED, AND IT FAILS CLOSED: exactly one hop, same file only, and the callee
 * must be a top-level function declaration or an arrow/function const. A gate
 * two helpers deep, or in another module, still reads as NOT gated — a false
 * negative (too strict), never a false pass. It also cannot tell WHICH branch
 * of the helper runs; see limitation (a) in the header, which this inherits.
 */
function reachesGateWithOneHop(sf: ts.SourceFile, body: ts.Node): boolean {
  if (subtreeReferences(body, "checkPermissionOrPropose")) return true;
  const called = new Set<string>();
  const collect = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
      called.add(n.expression.text);
    }
    ts.forEachChild(n, collect);
  };
  collect(body);
  for (const name of called) {
    const helper = topLevelFunctionBody(sf, name);
    if (helper && subtreeReferences(helper, "checkPermissionOrPropose")) {
      return true;
    }
  }
  return false;
}

function procedureReachesGate(
  verbsSf: ts.SourceFile,
  routerName: string,
  procName: string
): GateResult {
  const spec = specifierBinding(verbsSf, routerName);
  if (!spec) {
    return { resolved: false, why: `no import binding for ${routerName}` };
  }
  const routerFile = resolveSpecifier(VERBS_FILE, spec);
  if (!routerFile) {
    return { resolved: false, why: `cannot resolve "${spec}" on disk` };
  }
  const routerSf = parse(routerFile);
  const routerInit = findVarInitializer(routerSf, routerName);
  if (!routerInit) {
    return { resolved: false, why: `${routerName} not declared in ${spec}` };
  }
  const routerObj = objectLiteralOf(routerInit);
  if (!routerObj) {
    return { resolved: false, why: `${routerName} is not router({ … })` };
  }
  const prop = routerObj.properties.find((p) => propertyNameOf(p) === procName);
  if (!prop || !ts.isPropertyAssignment(prop)) {
    return {
      resolved: false,
      why: `${routerName}.${procName} not found in ${spec}`,
    };
  }

  let body: ts.Node = unwrap(prop.initializer);
  // The file `body` lives in — the one-hop helper lookup is same-file only.
  let bodySf: ts.SourceFile = routerSf;
  let where = `${spec}#${routerName}.${procName}`;

  // Follow ONE level of `nsProcs.<proc>` indirection into a co-located module.
  if (ts.isPropertyAccessExpression(body) && ts.isIdentifier(body.expression)) {
    const ns = body.expression.text;
    const member = body.name.text;
    const nsSpec = specifierBinding(routerSf, ns);
    if (!nsSpec) {
      return { resolved: false, why: `no import binding for ${ns}` };
    }
    const nsFile = resolveSpecifier(routerFile, nsSpec);
    if (!nsFile) {
      return { resolved: false, why: `cannot resolve "${nsSpec}" on disk` };
    }
    const nsSf = parse(nsFile);
    const nsInit = findVarInitializer(nsSf, ns);
    if (!nsInit) {
      return { resolved: false, why: `${ns} not declared in ${nsSpec}` };
    }
    const nsObj = objectLiteralOf(nsInit);
    if (!nsObj) {
      return { resolved: false, why: `${ns} is not an object literal` };
    }
    const memberProp = nsObj.properties.find(
      (p) => propertyNameOf(p) === member
    );
    if (!memberProp || !ts.isPropertyAssignment(memberProp)) {
      return { resolved: false, why: `${ns}.${member} not found in ${nsSpec}` };
    }
    body = unwrap(memberProp.initializer);
    bodySf = nsSf;
    where = `${nsSpec}#${ns}.${member}`;
  }

  return {
    resolved: true,
    gated: reachesGateWithOneHop(bodySf, body),
    where,
  };
}

// ---------------------------------------------------------------------------
// 5. CLASSIFICATION of every re-entering verb.
//    Keys are DERIVED-checked: a re-entering verb missing here is RED.
// ---------------------------------------------------------------------------

/**
 * THREE outcomes, not two. The third exists because a real door was found that
 * hop-3 provably cannot see: `skillsRouter.updateRule` carries no inline
 * `checkPermissionOrPropose` — it `await import(...)`s `updateRuleGoverned`
 * and that delegate does the gating. Recording it as `{ ungated }` would be a
 * FALSEHOOD in the one file whose job is to be true about which doors gate, and
 * recording it as "gated" would make the hop-3 assertion fail. `gatedVia` says
 * exactly where the gate is and is PROVEN by parsing that module — see the
 * "`gatedVia` verbs really do gate" test below. It is never a self-declared
 * exemption.
 */
type Classification =
  | "gated"
  | { ungated: string }
  | { gatedVia: { module: string; fn: string; why: string } };

const REENTRY_CLASS: Record<string, Classification> = {
  "entity.create": "gated",
  "entity.update": "gated",
  "entity.delete": "gated",
  "entity_facet.attach": "gated",
  "entity_facet.update": "gated",
  "entity_facet.detach": "gated",
  "graph.link": "gated",
  "tool.request": "gated",
  "playbook.update": "gated",
  "automation.activate": "gated",
  "automation.update": {
    ungated:
      "automationsRouter.update carries no gate on the path this verb can " +
      "reach. Its ONLY gate call is the activation branch " +
      '(`input.status === "active"` -> proposeAgentActivation), and ' +
      "`automation.update` deliberately does NOT accept `status` at all — the " +
      "lifecycle lives on automation.activate / automation.pause, which are " +
      "also the only paths that compute `nextRunAt`. What is left is a " +
      "definition patch on an object the operator already sees, workspace-write " +
      "gated on the LOADED row (assertWorkspaceWrite) and re-validated " +
      "(event pattern, filters, flow verbs, dataContract). Not " +
      "destructive/admin/structural by the derivation below; `automation.update` " +
      "is absent from AGENT_STRUCTURE_DOOR_CLASS, which classifies only " +
      "create/activate/execute.",
  },
  "automation.pause": {
    ungated:
      "automationsRouter.pause carries no checkPermissionOrPropose, " +
      "deliberately: pausing is DE-ESCALATION — stopping a misbehaving " +
      "automation must not itself wait for review. It is workspace-write gated " +
      "on the loaded row (assertWorkspaceWrite) and fully reversible via " +
      "automation.activate, which DOES propose for an agent.",
  },
  // ── Wave B — lifecycle revision/retire ─────────────────────────────────
  "playbook.archive": "gated",
  "skill.update_rule": {
    gatedVia: {
      module: "../services/rules/update.ts",
      fn: "updateRuleGoverned",
      why:
        "skillsRouter.updateRule has no inline gate; it dynamically imports " +
        "updateRuleGoverned, which calls checkPermissionOrPropose with " +
        "{ subjectType: 'rule' } and the ctx.agentUserId this verb threads " +
        "through the synthesized caller context. Hop-3 resolves neither a " +
        "dynamic import nor a cross-module helper, so the gate is asserted " +
        "against that module directly instead of assumed.",
    },
  },
  "profile.propose_retire": {
    ungated:
      "profilesRouter.proposeRetire has NO execute branch to gate: it calls " +
      "proposeProfileRetire, which files a PENDING proposal unconditionally " +
      "for every caller. There is no verdict for checkPermissionOrPropose to " +
      "make and no attribution miss that could turn this into a direct write " +
      "— the output IS the review item. Its floor " +
      "(assertProfileSchemaWrite, level editor, on the LOADED row) governs " +
      "who may FILE, not what executes. The hard-delete twin " +
      "(profilesRouter.delete) is deliberately not projected as a verb.",
  },
  "view.update": {
    ungated:
      "viewsRouter.update carries no checkPermissionOrPropose (views.ts gates " +
      "only `create` — creating a SURFACE the operator does not know about is " +
      "the act policy wants reviewed). Update is a reversible patch on a view " +
      "the operator already sees, floored on the LOADED row by " +
      "assertViewAccess(write) plus an admin/owner-only floor for the " +
      "workspace Home, and it VALIDATES what it writes (validateViewConfig + " +
      "assertValidRendererRef). Not destructive/admin/structural by the " +
      "derivation below. NOTE the deliberate omission: views.delete IS " +
      "destructive (it also drops the document and its MinIO version blobs) " +
      "and is ungated, so no `view.delete` verb exists — see the exclusion " +
      "note in builtin-verbs.ts.",
  },
  "cell.update": {
    ungated:
      "cellInstancesRouter.updateConfig carries no checkPermissionOrPropose. " +
      "It is OWNER-SCOPED by the UPDATE's own WHERE (id AND userId), so it " +
      "cannot reach another member's placement at all, and " +
      "AGENT_STRUCTURE_DOOR_CLASS already classifies `cell/update` as " +
      '"widenable" (a config patch of an existing placement) in explicit ' +
      'contrast to cell/create and cell/define, which are "floored".',
  },
  "channel.create": {
    ungated:
      "channelsRouter.createChannel has no checkPermissionOrPropose. " +
      "governance-policy documents this deliberately: `channel.create` is " +
      "POLICY-ONLY today (see the ADMIN/DEFAULT_AUTO_APPROVE note in " +
      "governance-policy/src/index.ts) and the builtin verb is grant-gated at " +
      'action="run". Not HIGH-RISK by the derivation below; recorded so the ' +
      "gap is dated rather than invisible.",
  },
  "channel.bind": {
    ungated:
      "channelsRouter.updateChannel has no checkPermissionOrPropose. Binding " +
      "an existing channel is a config patch on a surface the operator already " +
      "sees; not destructive/admin/structural by the derivation below.",
  },
  "document.create": {
    ungated:
      "documentsRouter.create has no checkPermissionOrPropose (documents.ts " +
      "carries no gate call at all). `document.create` IS in DEFAULT_AUTO_APPROVE, " +
      "i.e. policy intends it to auto-run; it is not destructive/admin/structural.",
  },
  "market.scaffold": "gated",
  "document.update": {
    ungated:
      "documentsRouter.update has no checkPermissionOrPropose. Document edits " +
      "are versioned (saveVersion/restoreVersion), so an update is recoverable " +
      "content, not a destructive write.",
  },
};

// ---------------------------------------------------------------------------

describe("TRIPWIRE: HIGH-RISK Synap Core verbs re-enter a governed door", () => {
  const verbs = readCoreVerbNames();
  const { handlerByVerb, reentryByVerb, sf } = readHandlerReentries();

  it("NON-VACUITY: the scans see the things they hunt", () => {
    // The verb list is real and plausibly sized (43 at 2026-09-21; 34 before
    // Wave A's four config-revision verbs and Wave B's five lifecycle verbs).
    expect(verbs.length).toBeGreaterThanOrEqual(38);
    expect(new Set(verbs).size).toBe(verbs.length);
    // Literal samples the scan MUST still be able to see.
    expect(verbs).toContain("entity.delete");
    expect(verbs).toContain("channel.create");
    // The handler registry is real and covers the definition.
    expect(handlerByVerb.size).toBeGreaterThanOrEqual(30);
    for (const v of verbs) {
      expect(handlerByVerb.has(v), `no BUILTIN_VERBS handler for "${v}"`).toBe(
        true
      );
    }
    // The re-entry scan found a plausible number of re-entering handlers.
    expect(reentryByVerb.size).toBeGreaterThanOrEqual(8);
    expect(reentryByVerb.get("entity.delete")).toEqual({
      router: "entitiesRouter",
      procedures: ["delete"],
    });
    // The gate resolver can still SEE a gate it is supposed to find, and can
    // still report its ABSENCE — both directions, so neither is assumed.
    const gatedProbe = procedureReachesGate(sf, "entitiesRouter", "delete");
    expect(gatedProbe).toMatchObject({ resolved: true, gated: true });
    const ungatedProbe = procedureReachesGate(sf, "documentsRouter", "create");
    expect(ungatedProbe).toMatchObject({ resolved: true, gated: false });
    // The floor sets are real.
    expect(DESTRUCTIVE_ACTIONS).toContain("delete");
    expect(ADMIN_ACTIONS.length).toBeGreaterThan(5);
    expect(FLOOR_EVENT_KEYS.size).toBeGreaterThan(10);
  });

  it("PREMISE: the outer capability gate cannot see the verb's identity", () => {
    // This is the hole, stated executably. It is NOT an assertion that the
    // hole is correct — it is a canary: if this ever starts flooring, the
    // verb identity has begun reaching decideAgentPolicy and this tripwire's
    // rationale (and its "ungated" classifications) must be revisited.
    const asCapabilityRun = decideAgentPolicy({
      subjectType: "capability",
      action: "run",
      capabilityGovernance: "auto",
      capabilityExecMode: "auto",
    });
    const asTheRealVerb = decideAgentPolicy({
      subjectType: "entity",
      action: "delete",
      capabilityGovernance: "auto",
      capabilityExecMode: "auto",
    });
    expect(asTheRealVerb.verdict).toBe("propose"); // rung 2.5 floors it
    expect(asCapabilityRun.verdict).toBe("execute"); // the verb's identity is gone
  });

  it("every verb that re-enters a router is CLASSIFIED", () => {
    const unclassified = [...reentryByVerb.keys()].filter(
      (v) => !(v in REENTRY_CLASS)
    );
    expect(
      unclassified,
      `These Core verbs re-enter a tRPC router but are not classified in ` +
        `REENTRY_CLASS. Classify each as "gated" (proven below) or ` +
        `{ ungated: "<why that is safe>" }.`
    ).toEqual([]);
    // And no stale entries claiming to classify a verb that no longer re-enters.
    const stale = Object.keys(REENTRY_CLASS).filter(
      (v) => !reentryByVerb.has(v)
    );
    expect(
      stale,
      "REENTRY_CLASS classifies verbs that no longer re-enter"
    ).toEqual([]);
  });

  it("every `gatedVia` verb's named delegate really does gate", () => {
    const viaEntries = Object.entries(REENTRY_CLASS).flatMap(([verb, cls]) =>
      typeof cls === "object" && "gatedVia" in cls
        ? [[verb, cls.gatedVia] as const]
        : []
    );

    // NON-VACUITY: if this list empties, the loop below asserts nothing. That
    // is fine only if nobody still CLAIMS an indirect gate — which is exactly
    // what emptiness means. But while entries exist, the prover must be seen
    // to work, so assert the known one is still here.
    expect(
      viaEntries.map(([v]) => v),
      "no verb claims an indirect gate — if that is intentional, delete this test"
    ).toContain("skill.update_rule");

    const failures: string[] = [];
    for (const [verb, via] of viaEntries) {
      // 1. The verb must actually re-enter the router it is classified under
      //    (staleness is the previous test's job, but a gatedVia entry that
      //    names a module for a verb nobody calls is worse than stale).
      if (!reentryByVerb.has(verb)) {
        failures.push(`${verb}: classified gatedVia but re-enters no router`);
        continue;
      }
      // 2. The named module must exist on disk.
      const file = resolve(HERE, via.module);
      if (!existsSync(file)) {
        failures.push(`${verb}: gatedVia module not found: ${via.module}`);
        continue;
      }
      // 3. The named FUNCTION in it must reach checkPermissionOrPropose —
      //    parsed, not grepped, so a mention in a comment or an unrelated
      //    function cannot satisfy it.
      const sfVia = parse(file);
      const fnBody = topLevelFunctionBody(sfVia, via.fn);
      if (!fnBody) {
        failures.push(
          `${verb}: ${via.fn} is not a top-level function in ${via.module}`
        );
        continue;
      }
      if (!subtreeReferences(fnBody, "checkPermissionOrPropose")) {
        failures.push(
          `${verb}: ${via.module}#${via.fn} does NOT reach ` +
            `checkPermissionOrPropose — the indirect-gate claim is false.`
        );
      }
    }
    expect(failures).toEqual([]);
  });

  it("every verb classified `gated` actually reaches checkPermissionOrPropose", () => {
    const failures: string[] = [];
    for (const [verb, cls] of Object.entries(REENTRY_CLASS)) {
      if (cls !== "gated") continue;
      const re = reentryByVerb.get(verb);
      if (!re) continue; // staleness is the previous test's job
      for (const proc of re.procedures) {
        const r = procedureReachesGate(sf, re.router, proc);
        if (!r.resolved) {
          failures.push(`${verb}: UNRESOLVABLE — ${r.why}`);
        } else if (!r.gated) {
          failures.push(
            `${verb}: ${re.router}.${proc} (${r.where}) does NOT reach checkPermissionOrPropose`
          );
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("THE SECURITY ASSERTION: every HIGH-RISK verb re-enters a GATED door", () => {
    const highRisk = verbs
      .map((v) => ({ verb: v, floors: floorsHitBy(v) }))
      .filter((x) => x.floors.length > 0);

    // Non-vacuity: the derivation must still classify at least one verb as
    // high-risk, and must still see the one we know about.
    expect(
      highRisk.map((x) => x.verb),
      "the HIGH-RISK derivation matched NOTHING — it has gone blind"
    ).toContain("entity.delete");

    const failures: string[] = [];
    for (const { verb, floors } of highRisk) {
      const re = reentryByVerb.get(verb);
      if (!re) {
        failures.push(
          `${verb} would hit ${floors.join(" + ")} if its identity reached the ` +
            `gate, but its handler re-enters NO governed router — it runs ` +
            `under the outer capability/run gate ONLY, which misses every floor.`
        );
        continue;
      }
      if (REENTRY_CLASS[verb] !== "gated") {
        failures.push(
          `${verb} is HIGH-RISK (${floors.join(" + ")}) but is classified ` +
            `"ungated" — a high-risk verb may never be exempted.`
        );
        continue;
      }
      for (const proc of re.procedures) {
        const r = procedureReachesGate(sf, re.router, proc);
        if (!r.resolved) {
          failures.push(`${verb}: UNRESOLVABLE — ${r.why}`);
        } else if (!r.gated) {
          failures.push(
            `${verb} is HIGH-RISK (${floors.join(" + ")}) and re-enters ` +
              `${re.router}.${proc} (${r.where}), which does NOT reach ` +
              `checkPermissionOrPropose. It is ungoverned.`
          );
        }
      }
    }
    expect(failures).toEqual([]);
  });
});
