/**
 * The code-skill rule — what a code skill's `code` may be, decided ONE way for
 * every door that writes or ships one: the pod's save-time check
 * (`assertSkillCodeAllowed`, `@synap/api` routers/skills.ts) and the catalog
 * validator (`synap catalog validate`, synap-app workspace-templates).
 *
 * The runner runs `code` as the BODY of `async function(args, context)` inside
 * an isolate whose only globals are ECMAScript built-ins plus the skill stdlib
 * (host bridges + web polyfills). {@link checkSkillCode} refuses, before a run
 * ever happens: a syntax error, a reference to a global the runtime does not
 * provide, and code that only defines a function (nothing would call it).
 *
 * Moved here from `@synap/api` (2026-10-28) so the catalog runs the same rule:
 * the catalog's `apollo_search_people` shipped a syntax error for three months
 * because only the pod checked code, at install time (finding f258a5b2). The
 * stdlib bootstrap that INSTALLS these globals stays in `@synap/api`
 * (services/skills/skill-stdlib.ts), which re-exports the lists below.
 */

import * as acorn from "acorn";
import * as acornWalk from "acorn-walk";

/** Bumped when the installed surface changes in a way skills can observe. */
export const SKILL_RUNTIME_VERSION = 1 as const;

/**
 * Pure-ECMAScript globals an isolated-vm isolate exposes natively (verified by
 * enumerating `Object.getOwnPropertyNames(globalThis)` in a fresh isolate — see
 * the tripwire). These need no polyfill; they are allow-listed because a skill
 * may legitimately reference them. NOT a security boundary — the isolate itself
 * is the boundary; this list only tells the save-time scan which references
 * resolve at runtime.
 */
export const SKILL_ECMASCRIPT_GLOBALS = [
  "globalThis",
  "undefined",
  "NaN",
  "Infinity",
  "eval",
  "isFinite",
  "isNaN",
  "parseFloat",
  "parseInt",
  "decodeURI",
  "decodeURIComponent",
  "encodeURI",
  "encodeURIComponent",
  "escape",
  "unescape",
  "Object",
  "Function",
  "Boolean",
  "Symbol",
  "Error",
  "AggregateError",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
  "Number",
  "BigInt",
  "Math",
  "Date",
  "String",
  "RegExp",
  "Array",
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "BigInt64Array",
  "BigUint64Array",
  "Float32Array",
  "Float64Array",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "WeakRef",
  "FinalizationRegistry",
  "ArrayBuffer",
  "SharedArrayBuffer",
  "DataView",
  "Atomics",
  "JSON",
  "Promise",
  "Reflect",
  "Proxy",
  "Intl",
  "Iterator",
  "WebAssembly",
] as const;

/**
 * Web-standard globals the bootstrap polyfills in pure JS (host objects can't
 * cross the isolate boundary, so these are spec-close JS re-implementations,
 * each smoke-tested for native parity). Ordered as installed.
 */
export const SKILL_WEB_GLOBALS = [
  "URLSearchParams",
  "URL",
  "TextEncoder",
  "TextDecoder",
  "btoa",
  "atob",
  "structuredClone",
] as const;

/**
 * Host bridges the bootstrap installs (backed by `ivm.Reference` callbacks the
 * executor sets before eval). These are the governed doors into the pod/host.
 */
export const SKILL_HOST_BRIDGES = [
  "console",
  "hubProtocol",
  "secrets",
  "host",
  "callProvider",
  "propose",
] as const;

/**
 * The two parameters the skill wrapper injects: `execute(args, context)`. They
 * are lexical parameters (not globals) but are allow-listed so a save-time scan
 * of the wrapped body never flags them.
 */
export const SKILL_WRAPPER_PARAMS = ["args", "context"] as const;

/**
 * THE allow-list: every identifier a skill may reference and have resolve at
 * runtime. The backend save-time global-reference scan rejects any free global
 * reference NOT in this set. Derived — never hand-maintained as a flat list.
 */
export const SKILL_ALLOWED_GLOBALS: readonly string[] = Object.freeze([
  ...SKILL_ECMASCRIPT_GLOBALS,
  ...SKILL_WEB_GLOBALS,
  ...SKILL_HOST_BRIDGES,
  ...SKILL_WRAPPER_PARAMS,
]);

/** The derived allow-list — every identifier a skill may reference. */
export const SKILL_RUNTIME_ALLOWED_GLOBALS: ReadonlySet<string> = new Set(
  SKILL_ALLOWED_GLOBALS
);

/** Collect every binding name a pattern node introduces (destructuring-aware). */
function collectPatternNames(
  node: acorn.Node | null | undefined,
  out: Set<string>
): void {
  if (!node) return;
  const n = node as unknown as Record<string, unknown> & { type: string };
  switch (n.type) {
    case "Identifier":
      out.add(n.name as string);
      break;
    case "ObjectPattern":
      for (const p of n.properties as acorn.Node[]) collectPatternNames(p, out);
      break;
    case "Property":
      collectPatternNames(n.value as acorn.Node, out);
      break;
    case "ArrayPattern":
      for (const e of n.elements as (acorn.Node | null)[])
        if (e) collectPatternNames(e, out);
      break;
    case "RestElement":
      collectPatternNames(n.argument as acorn.Node, out);
      break;
    case "AssignmentPattern":
      collectPatternNames(n.left as acorn.Node, out);
      break;
  }
}

/**
 * Parse a skill body and return the free global identifiers it references that
 * are NOT in the runtime allow-list. Uses the SAME async-function wrapper the IS
 * executor uses, so `args`/`context`/top-level `await` parse identically.
 *
 * Detection = (identifiers referenced anywhere) − (identifiers bound anywhere) −
 * allow-list. "Bound anywhere" makes a local shadow of an allowed name safe and
 * never false-positives on locals; only a name that is never declared and not
 * provided by the runtime is flagged. Throws SyntaxError text on a parse failure.
 */
export function scanSkillGlobals(code: string): {
  ok: boolean;
  unknownGlobals: string[];
  parseError?: string;
  /** The code only DEFINES functions: see {@link onlyDefinesFunctions}. */
  onlyDefinesFunctions?: boolean;
} {
  const wrapped = `(async function(args, context){\n${code}\n})`;
  let ast: acorn.Node;
  try {
    ast = acorn.parse(wrapped, { ecmaVersion: 2022, sourceType: "script" });
  } catch (err) {
    return {
      ok: false,
      unknownGlobals: [],
      parseError: err instanceof Error ? err.message : "Syntax error",
    };
  }

  const bound = new Set<string>();
  const referenced = new Set<string>();

  acornWalk.fullAncestor(
    ast,
    (node: acorn.Node, _state: unknown, ancestors: acorn.Node[]) => {
      const n = node as unknown as Record<string, unknown> & { type: string };
      switch (n.type) {
        case "VariableDeclarator":
          collectPatternNames(n.id as acorn.Node, bound);
          return;
        case "FunctionDeclaration":
        case "FunctionExpression":
        case "ArrowFunctionExpression":
          if (n.id) bound.add((n.id as { name: string }).name);
          for (const p of n.params as acorn.Node[])
            collectPatternNames(p, bound);
          return;
        case "ClassDeclaration":
        case "ClassExpression":
          if (n.id) bound.add((n.id as { name: string }).name);
          return;
        case "CatchClause":
          if (n.param) collectPatternNames(n.param as acorn.Node, bound);
          return;
      }
      if (n.type !== "Identifier") return;
      const name = n.name as string;
      const parent = ancestors[ancestors.length - 2] as unknown as
        (Record<string, unknown> & { type: string }) | undefined;
      if (!parent) {
        referenced.add(name);
        return;
      }
      // Exclude identifiers that are NOT variable references:
      if (
        parent.type === "MemberExpression" &&
        parent.property === node &&
        !parent.computed
      )
        return;
      if (
        parent.type === "Property" &&
        parent.key === node &&
        !parent.computed &&
        parent.value !== node
      )
        return;
      if (
        (parent.type === "MethodDefinition" ||
          parent.type === "PropertyDefinition") &&
        parent.key === node &&
        !parent.computed
      )
        return;
      if (parent.type === "LabeledStatement" && parent.label === node) return;
      if (
        (parent.type === "BreakStatement" ||
          parent.type === "ContinueStatement") &&
        parent.label === node
      )
        return;
      if (parent.type === "VariableDeclarator" && parent.id === node) return;
      if (
        (parent.type === "FunctionDeclaration" ||
          parent.type === "FunctionExpression" ||
          parent.type === "ArrowFunctionExpression") &&
        (parent.id === node || (parent.params as acorn.Node[]).includes(node))
      )
        return;
      referenced.add(name);
    }
  );

  const unknownGlobals = [...referenced]
    .filter(
      (name) => !bound.has(name) && !SKILL_RUNTIME_ALLOWED_GLOBALS.has(name)
    )
    .sort();
  return {
    ok: unknownGlobals.length === 0,
    unknownGlobals,
    onlyDefinesFunctions: onlyDefinesFunctions(ast),
  };
}

/**
 * The runner runs a skill's code as the BODY of `async function(args,
 * context)` (runner/skill-isolate.ts). Code that is itself a function —
 * `async (args, context) => { … }` or `function run() { … }` — is defined by
 * that body and never called: every run returns `undefined` and still reports
 * success. Live (skill dogfood_echo, run 12b2997a, 2026-10-28): approved,
 * delivered, no result.
 */
function onlyDefinesFunctions(ast: acorn.Node): boolean {
  const program = ast as unknown as {
    body: Array<{ expression?: { body?: { body?: acorn.Node[] } } }>;
  };
  const statements = program.body[0]?.expression?.body?.body ?? [];
  return (
    statements.length > 0 &&
    statements.every((node) => {
      const s = node as unknown as {
        type: string;
        expression?: { type: string };
      };
      return (
        s.type === "FunctionDeclaration" ||
        (s.type === "ExpressionStatement" &&
          (s.expression?.type === "FunctionExpression" ||
            s.expression?.type === "ArrowFunctionExpression"))
      );
    })
  );
}

/** Why {@link checkSkillCode} refused a skill's code. */
export type SkillCodeProblem =
  | { kind: "syntax"; message: string }
  | { kind: "defines-only"; message: string }
  | { kind: "unknown-globals"; globals: string[]; message: string };

/**
 * THE code-skill rule: `null` when `code` may be saved and shipped, else the
 * one problem to fix, in words an author (person or agent) can act on. Empty
 * or whitespace code passes (a skill without code is not a code skill).
 */
export function checkSkillCode(
  code: string | null | undefined
): SkillCodeProblem | null {
  const trimmed = code?.trim();
  if (!trimmed) return null;
  const scan = scanSkillGlobals(trimmed);
  if (scan.parseError) {
    return {
      kind: "syntax",
      message: `Skill code has a syntax error: ${scan.parseError}`,
    };
  }
  if (scan.onlyDefinesFunctions) {
    return {
      kind: "defines-only",
      message:
        "Skill code only defines a function, so a run would call nothing and return nothing. " +
        "The code is the BODY of a function that receives `args` and `context`: " +
        "write its statements directly and `return` the result " +
        '(e.g. `const text = String(args.text ?? ""); return { echoed: text };`), ' +
        "without a wrapper like `async (args, context) => { … }`.",
    };
  }
  if (!scan.ok) {
    const allowed = [...SKILL_WEB_GLOBALS, ...SKILL_HOST_BRIDGES].join(", ");
    return {
      kind: "unknown-globals",
      globals: scan.unknownGlobals,
      message:
        `Skill references ${scan.unknownGlobals.map((g) => `\`${g}\``).join(", ")}, ` +
        `not provided by skill runtime v${SKILL_RUNTIME_VERSION}. ` +
        `Code skills run in a sandbox with ECMAScript built-ins plus: ${allowed}. ` +
        `Use \`host.fetch(url, opts)\` for HTTP (not \`fetch\`); there is no \`crypto\`, ` +
        `\`process\`, \`require\`, or timers.`,
    };
  }
  return null;
}
