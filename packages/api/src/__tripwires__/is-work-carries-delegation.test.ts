import { describe, it, expect } from "vitest";
import ts from "typescript";
import { readFileSync, readdirSync } from "fs";
import { join, relative } from "path";

/**
 * TRIPWIRE — every pod→IS call that STARTS IS WORK carries the per-turn
 * delegation (D4, SECURITY-PLAN-R1 §3).
 *
 * An IS turn calls back into this pod's hub. With the delegation it does so as
 * the operator THIS pod chose, on a token that expires; without it the IS falls
 * back to its stored `is_internal` key, the credential the cut-over deletes. A
 * new door that POSTs a turn to the IS and forgets the header would work today
 * and break silently at the cut-over — so it fails here first.
 *
 * THE SET IS DERIVED: every non-test source file under the backend's
 * `packages/* /src` and `apps/* /src` that names one of the IS work endpoints
 * in a string or template literal. Endpoints that start an agent or skill and
 * therefore call the hub back:
 */
const IS_WORK_ENDPOINTS = [
  "/api/chat/stream",
  "/api/skills/execute",
  "/api/tasks/execute",
  "/api/proactive-scan",
];
/**
 * Each such file must CALL `isDelegationHeaders(` (@synap/database).
 *
 * WHAT IT CANNOT SEE (measured by mutation, see the lane report): granularity
 * is the FILE — a file with two IS calls where one forgets the header stays
 * green as long as the other mints. It also cannot see an endpoint built
 * without its path in one literal (e.g. `${base}${path}` with `path` passed in),
 * and it trusts the endpoint list above: an IS route that starts hub-calling
 * work under a new path must be added to it.
 */

const BACKEND_ROOT = join(process.cwd(), "..", "..");

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
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      calls.add(node.expression.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { literals, calls };
}

function namesIsWork(literals: string[]): boolean {
  return literals.some((l) => IS_WORK_ENDPOINTS.some((e) => l.endsWith(e)));
}

describe("tripwire: pod→IS work carries the per-turn delegation", () => {
  const files = sourceRoots().flatMap((root) => tsFiles(root));
  const isWorkFiles = files.filter((f) => {
    const text = readFileSync(f, "utf8");
    if (!IS_WORK_ENDPOINTS.some((e) => text.includes(e))) return false;
    return namesIsWork(scan(f, text).literals);
  });

  it("the scan sees the backend and the known IS-work doors (non-vacuity)", () => {
    expect(files.length).toBeGreaterThan(1000);
    const rel = isWorkFiles.map((f) => relative(BACKEND_ROOT, f));
    for (const known of [
      "packages/intelligence-client/src/intelligence-hub-client.ts",
      "packages/intelligence-client/src/is-headless-transport.ts",
      "packages/api/src/services/skills/execute-skill-via-is.ts",
      "packages/jobs/src/workers/proactive-intelligence.ts",
    ]) {
      expect(rel).toContain(known);
    }
    expect(isWorkFiles.length).toBeGreaterThanOrEqual(8);
  });

  it("the matcher can still see a literal sample", () => {
    const sample = scan(
      "sample.ts",
      "await fetch(`${isUrl}/api/chat/stream`, { headers: { ...isDelegationHeaders({}) } });"
    );
    expect(namesIsWork(sample.literals)).toBe(true);
    expect(sample.calls.has("isDelegationHeaders")).toBe(true);
    // A comment naming the endpoint is not a call site.
    expect(namesIsWork(scan("c.ts", "// POST /api/chat/stream").literals)).toBe(
      false
    );
  });

  it("every file that starts IS work mints isDelegationHeaders", () => {
    const offenders = isWorkFiles
      .filter(
        (f) =>
          !scan(f, readFileSync(f, "utf8")).calls.has("isDelegationHeaders")
      )
      .map((f) => relative(BACKEND_ROOT, f));
    expect(
      offenders,
      "These files POST work to the Intelligence Service without the per-turn " +
        "delegation. Spread `...isDelegationHeaders({ isUrl, operatorUserId, " +
        "agentUserId, channelId, runId })` (@synap/database) into the request headers."
    ).toEqual([]);
  });
});
