/**
 * TRIPWIRE — every `source` handed to the event log is a value the log accepts.
 *
 * `events.source` names the pod door that produced an event. Its ONE
 * vocabulary is `EVENT_SOURCES` (`@synap-core/core`), and
 * `EventRepository.append` validates every event against `SynapEventSchema`,
 * whose `source` is that enum. A value outside it is a ZodError, and most
 * appends are best-effort, so the row is silently never written.
 *
 * Measured on the founder's pod at 3f9b404a (2 Nov 2026): every external send
 * since 31 Jul 2026 (`recordExternalAction`, source `"external-dispatch"`)
 * failed its audit append, 21 times in 6 h. The value was a constant typed
 * `string` and cast inside `auditLog`, so the compiler never saw it. The same
 * scan found three more: `"connection_sync"` (every connection-sync write and
 * run since 13 Sep), `"import"` (the capture-graph proposal's `.requested`
 * event) and `"user"` (a suggested document patch).
 *
 * Derived on both sides: the accepted values are the validator's own
 * (`SynapEventSchema.shape.source`), and the scanned values are every
 * `source` property of an object passed to a door that reaches
 * `EventRepository.append` (AST, every non-test file of every package and
 * app). A string literal is checked through casts, `??`/`||` and ternaries;
 * an identifier is resolved to its `const X = "…"` declaration. Anything else
 * (a forwarded, typed field) is the compiler's: the doors type `source` as
 * `SynapEventSource`.
 */

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { SynapEventSchema } from "@synap-core/core";

const BACKEND_ROOT = join(import.meta.dirname, "../../../..");

/** Functions whose argument object's `source` lands in `events.source`. */
const DOORS = new Set([
  "auditLog",
  "recordDomainMutation",
  "createEventBackedProposal",
  "createAutoApprovedProposal",
  "createUnifiedEvent",
  "createSynapEvent",
]);
/** `<something event-ish>.append(...)` / `.appendBatch(...)`: the repository. */
const APPEND_METHODS = new Set(["append", "appendBatch"]);

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (
        e.name === "node_modules" ||
        e.name === "dist" ||
        e.name === "__tests__" ||
        e.name === "__tripwires__"
      )
        continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (
        /\.tsx?$/.test(e.name) &&
        !/\.(test|spec)\.tsx?$/.test(e.name) &&
        !e.name.endsWith(".d.ts")
      )
        out.push(p);
    }
  };
  for (const top of ["packages", "apps"]) {
    for (const pkg of readdirSync(join(BACKEND_ROOT, top), {
      withFileTypes: true,
    })) {
      if (!pkg.isDirectory()) continue;
      const src = join(BACKEND_ROOT, top, pkg.name, "src");
      try {
        walk(src);
      } catch {
        // a package with no src/ (config-only): nothing to scan
      }
    }
  }
  return out;
}

interface Site {
  file: string;
  line: number;
  door: string;
  values: string[];
  /** The value came through an identifier (a constant), not a literal. */
  viaConstant: boolean;
}

function unwrap(e: ts.Expression): ts.Expression {
  while (
    ts.isAsExpression(e) ||
    ts.isParenthesizedExpression(e) ||
    ts.isNonNullExpression(e) ||
    ts.isSatisfiesExpression(e) ||
    ts.isTypeAssertionExpression(e)
  )
    e = e.expression;
  return e;
}

interface Scope {
  /** `const X = "lit"` declared in this file. */
  local: Map<string, Set<string>>;
  /** Names this file imports. */
  imported: Set<string>;
}

/** `const X = "lit"` declarations of one file, and the names it imports. */
function scopeOf(sf: ts.SourceFile): Scope {
  const local = new Map<string, Set<string>>();
  const imported = new Set<string>();
  const visit = (n: ts.Node): void => {
    if (ts.isImportSpecifier(n)) imported.add(n.name.text);
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.initializer &&
      ts.isVariableDeclarationList(n.parent) &&
      n.parent.flags & ts.NodeFlags.Const
    ) {
      const init = unwrap(n.initializer);
      if (ts.isStringLiteralLike(init)) {
        const set = local.get(n.name.text) ?? new Set<string>();
        set.add(init.text);
        local.set(n.name.text, set);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { local, imported };
}

interface Resolver {
  scope: Scope;
  /** Every file's string constants, by name: what an import can bring in. */
  exported: Map<string, Set<string>>;
}

/** The string values an expression can take, as far as the source shows. */
function valuesOf(
  e: ts.Expression,
  r: Resolver,
  via: { constant: boolean }
): string[] {
  e = unwrap(e);
  if (ts.isStringLiteralLike(e)) return [e.text];
  if (ts.isConditionalExpression(e))
    return [...valuesOf(e.whenTrue, r, via), ...valuesOf(e.whenFalse, r, via)];
  if (
    ts.isBinaryExpression(e) &&
    (e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      e.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  )
    return [...valuesOf(e.left, r, via), ...valuesOf(e.right, r, via)];
  if (ts.isIdentifier(e)) {
    // A constant of this file, else one it imports; a parameter or a `let`
    // resolves to nothing and is left to the compiler.
    const hit =
      r.scope.local.get(e.text) ??
      (r.scope.imported.has(e.text) ? r.exported.get(e.text) : undefined);
    if (hit) {
      via.constant = true;
      return [...hit];
    }
  }
  return [];
}

function calleeDoor(call: ts.CallExpression): string | null {
  const c = call.expression;
  if (ts.isIdentifier(c) && DOORS.has(c.text)) return c.text;
  if (ts.isPropertyAccessExpression(c)) {
    const name = c.name.text;
    if (DOORS.has(name)) return name;
    if (APPEND_METHODS.has(name) && /event/i.test(c.expression.getText()))
      return `${c.expression.getText()}.${name}`;
  }
  return null;
}

function scan(): Site[] {
  const files = sourceFiles().map((path) => ({
    path,
    sf: ts.createSourceFile(
      path,
      readFileSync(path, "utf8"),
      ts.ScriptTarget.Latest,
      true
    ),
  }));
  const scopes = new Map(files.map((f) => [f.path, scopeOf(f.sf)]));
  const exported = new Map<string, Set<string>>();
  for (const sc of scopes.values())
    for (const [name, vals] of sc.local) {
      const set = exported.get(name) ?? new Set<string>();
      for (const v of vals) set.add(v);
      exported.set(name, set);
    }
  const sites: Site[] = [];
  for (const { path, sf } of files) {
    const r: Resolver = { scope: scopes.get(path)!, exported };
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n)) {
        const door = calleeDoor(n);
        if (door) {
          for (const arg of n.arguments) {
            const obj = unwrap(arg);
            if (!ts.isObjectLiteralExpression(obj)) continue;
            for (const p of obj.properties) {
              if (!p.name || !ts.isIdentifier(p.name)) continue;
              if (p.name.text !== "source") continue;
              const via = { constant: false };
              const values = ts.isPropertyAssignment(p)
                ? valuesOf(p.initializer, r, via)
                : ts.isShorthandPropertyAssignment(p)
                  ? valuesOf(p.name, r, via)
                  : [];
              if (values.length === 0) continue;
              sites.push({
                file: relative(BACKEND_ROOT, path),
                line: sf.getLineAndCharacterOfPosition(p.getStart(sf)).line + 1,
                door,
                values,
                viaConstant: via.constant,
              });
            }
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return sites;
}

const accepted = (v: string): boolean =>
  SynapEventSchema.shape.source.safeParse(v).success;

describe("tripwire: every event source a door is handed is in the event-source vocabulary", () => {
  const sites = scan();

  it("the scan reaches the doors (not vacuous)", () => {
    // Anchors: the default every door falls back to, and the outbound door,
    // whose value arrives through a constant.
    expect(sites.length).toBeGreaterThan(20);
    expect(
      sites.some(
        (s) => s.file.endsWith("utils/audit-log.ts") && s.values.includes("api")
      )
    ).toBe(true);
    expect(
      sites.some(
        (s) =>
          s.file.endsWith("connectors/external-dispatch.ts") &&
          s.door === "recordDomainMutation" &&
          s.viaConstant
      )
    ).toBe(true);
  });

  it("the validator rejects a value outside the vocabulary (the check can fail)", () => {
    expect(accepted("api")).toBe(true);
    expect(accepted("not-a-door")).toBe(false);
  });

  it("no door is handed a source EventRepository.append would reject", () => {
    const rejected = sites.flatMap((s) =>
      s.values
        .filter((v) => !accepted(v))
        .map((v) => `${s.file}:${s.line} ${s.door} source "${v}"`)
    );
    expect(rejected).toEqual([]);
  });
});
