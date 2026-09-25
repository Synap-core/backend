/**
 * TRIPWIRE — the content-kind taxonomy has ONE source: `CONTENT_KINDS` in
 * `@synap-core/types/renderables` (the renderables catalog, which the browser's
 * `@synap-core/capabilities` re-exports).
 *
 * Two copies remain because their packages cannot import it yet, and each is
 * pinned here to the catalog, element for element and in order:
 *   - `@synap/database/schema` — the pod's column vocabulary (the database
 *     package does not depend on `@synap-core/types`);
 *   - the CLI (`synap-cli/src/commands/cell.ts`) — depends on neither types nor
 *     database; read from source text, SKIPPED when the sibling repo is absent
 *     (a missing checkout is not a drift).
 * The Control Plane's copies are guarded by `cp-pod-content-kind-parity`.
 *
 * And no OTHER copy may appear: a derived scan (every non-test source file of
 * synap-backend, the IS and the CLI, AST-parsed) flags any array literal
 * holding ≥ 4 content-kind literals outside the catalog and the two pinned
 * copies. It found `services/surfaces/renderer-usage.ts` (a private copy of the
 * profile kinds), now imported from the catalog (W7a).
 */

import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { CONTENT_KINDS as DATABASE_CONTENT_KINDS } from "@synap/database/schema";
import { CONTENT_KINDS } from "@synap-core/types/renderables";

const REPO_ROOT = join(import.meta.dirname, "../../../../..");
const CLI_CELL = join(REPO_ROOT, "synap-cli/src/commands/cell.ts");

function literalConstKinds(src: string): string[] {
  const m = src.match(
    /export const CONTENT_KINDS\s*=\s*\[([\s\S]*?)\]\s*as const/
  );
  if (!m) throw new Error("CONTENT_KINDS not found — did it move?");
  const code = m[1]!.replace(/\/\/.*$/gm, "");
  return [...code.matchAll(/"([^"]+)"/g)].map((x) => x[1]!);
}

describe("tripwire: one content-kind taxonomy", () => {
  it("the catalog taxonomy is non-empty (non-vacuity)", () => {
    expect(CONTENT_KINDS.length).toBeGreaterThanOrEqual(5);
    expect([...CONTENT_KINDS]).toContain("widget");
  });

  it("the database copy equals the catalog", () => {
    expect([...DATABASE_CONTENT_KINDS]).toEqual([...CONTENT_KINDS]);
  });

  it.skipIf(!existsSync(CLI_CELL))("the CLI copy equals the catalog", () => {
    const cli = literalConstKinds(readFileSync(CLI_CELL, "utf8"));
    expect(cli.length, "extractor found nothing").toBeGreaterThan(0);
    expect(cli).toEqual([...CONTENT_KINDS]);
  });
});

// ─── No other copy (derived scan) ────────────────────────────────────────────

const MONOREPO = REPO_ROOT;
const ALLOWED = new Set([
  "synap-backend/packages/types/src/renderables/content-kinds.ts",
  "synap-backend/packages/database/src/schema/widget-definitions.ts",
  "synap-cli/src/commands/cell.ts",
]);
const KINDS = new Set<string>(CONTENT_KINDS);

function walkSources(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (
      name.startsWith(".") ||
      ["node_modules", "dist", "build", "__tests__", "__fixtures__"].includes(
        name
      )
    )
      continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walkSources(full, out);
    else if (
      /\.(ts|tsx|mjs)$/.test(name) &&
      !/\.(test|spec)\.|\.d\.ts$/.test(name)
    )
      out.push(full);
  }
}

function kindLists(src: string): number {
  const sf = ts.createSourceFile("x.ts", src, ts.ScriptTarget.Latest, true);
  let n = 0;
  const visit = (node: ts.Node) => {
    if (
      ts.isArrayLiteralExpression(node) &&
      node.elements.filter((e) => ts.isStringLiteral(e) && KINDS.has(e.text))
        .length >= 4
    )
      n++;
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return n;
}

describe("tripwire: no other content-kind copy", () => {
  const files: string[] = [];
  for (const r of [
    "synap-backend/packages",
    "synap-backend/apps",
    "synap-intelligence-service/apps",
    "synap-cli/src",
  ])
    if (existsSync(join(MONOREPO, r))) walkSources(join(MONOREPO, r), files);
  const copies = files
    .filter((f) => {
      const src = readFileSync(f, "utf8");
      return src.includes('"entity-card"') && kindLists(src) > 0;
    })
    .map((f) => relative(MONOREPO, f));

  it("non-vacuous: sees the catalog and the pinned database copy", () => {
    expect(files.length).toBeGreaterThan(1000);
    expect(copies).toContain(
      "synap-backend/packages/types/src/renderables/content-kinds.ts"
    );
    expect(copies).toContain(
      "synap-backend/packages/database/src/schema/widget-definitions.ts"
    );
  });

  it("every copy is the catalog or a pinned one", () => {
    expect(copies.filter((f) => !ALLOWED.has(f))).toEqual([]);
  });
});
