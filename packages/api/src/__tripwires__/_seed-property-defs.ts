/**
 * Shared, DERIVED fixture for the schema-door tripwires: every property def
 * `ensure-system-profiles.ts` seeds, extracted from the seed's own source with
 * the TypeScript parser.
 *
 * Nothing here is hand-listed. A new seeded property joins every scan that
 * imports this file by existing; a seed shape the parser cannot evaluate (a
 * spread, a call, a variable) is DROPPED — which is why `SEED_ENUM_SITE_COUNT`
 * is counted independently from the raw text, so a consumer can assert the
 * two methods agree instead of trusting either one.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import { PropertyValueType } from "@synap/database";

const here = fileURLToPath(new URL(".", import.meta.url));

export const SEED_FILE = resolve(
  here,
  "..",
  "..",
  "..",
  "database",
  "src",
  "utils",
  "ensure-system-profiles.ts"
);

export const SEED_SOURCE = readFileSync(SEED_FILE, "utf8");

/**
 * Evaluate a literal expression. Returns `undefined` for anything non-literal —
 * callers treat that as "not extractable", never as a substituted value.
 */
function literal(node: ts.Expression): unknown {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isArrayLiteralExpression(node)) {
    const out: unknown[] = [];
    for (const el of node.elements) {
      if (ts.isSpreadElement(el)) return undefined;
      const v = literal(el);
      if (v === undefined) return undefined;
      out.push(v);
    }
    return out;
  }
  if (ts.isObjectLiteralExpression(node)) return objectLiteral(node);
  // `PropertyValueType.STRING` → resolved against the REAL enum, so a renamed
  // member reads as `undefined` (and drops the def) instead of as its own text.
  if (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "PropertyValueType"
  ) {
    return (PropertyValueType as unknown as Record<string, string>)[
      node.name.text
    ];
  }
  return undefined;
}

function objectLiteral(
  node: ts.ObjectLiteralExpression
): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const prop of node.properties) {
    if (!ts.isPropertyAssignment(prop)) return undefined;
    const key =
      ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)
        ? prop.name.text
        : undefined;
    if (key === undefined) return undefined;
    const value = literal(prop.initializer);
    if (value === undefined) return undefined;
    out[key] = value;
  }
  return out;
}

function everyObjectLiteral(): Record<string, unknown>[] {
  const src = ts.createSourceFile(
    SEED_FILE,
    SEED_SOURCE,
    ts.ScriptTarget.ES2022,
    true
  );
  const found: Record<string, unknown>[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      const obj = objectLiteral(node);
      if (obj) found.push(obj);
    }
    ts.forEachChild(node, visit);
  };
  visit(src);
  return found;
}

export const ALL_LITERALS = everyObjectLiteral();

/** A seeded property DEFINITION: it has a slug AND declares a valueType. */
export const SEEDED_DEFS = ALL_LITERALS.filter(
  (o) => typeof o.slug === "string" && typeof o.valueType === "string"
);

/** A seeded profile↔property LINK: a slug carrying `required: true`. */
export const SEEDED_REQUIRED_LINKS = ALL_LITERALS.filter(
  (o) =>
    typeof o.slug === "string" &&
    o.valueType === undefined &&
    o.required === true
);

export function constraintsOf(
  def: Record<string, unknown>
): Record<string, unknown> {
  return (def.constraints as Record<string, unknown> | undefined) ?? {};
}

export const ENUM_DEFS = SEEDED_DEFS.filter((d) =>
  Array.isArray(constraintsOf(d).enum)
);

/**
 * `enum: [` sites counted from the RAW TEXT, comments stripped — an
 * independent measurement of the same population `ENUM_DEFS` parses. In the
 * seed, `enum:` is only ever a constraints key. 27 on 2026-09-12.
 */
export const SEED_ENUM_SITE_COUNT = (
  SEED_SOURCE.replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .match(/\benum:\s*\[/g) ?? []
).length;
