/**
 * TRIPWIRE — `proposals.status` is written by ONE door.
 *
 * The door is `transitionProposal` (`packages/database/src/utils/proposal-transition.ts`):
 * one UPDATE that ANDs the transition table's guard (`status IN (the statuses
 * that may become <to>)`) to the caller's own predicate. Before it, about 140
 * writes in 62 files each carried their own `WHERE`, or none (R4, document
 * dffe76b1): the reject door could overwrite an approval, a job relabelled
 * approved proposals "rejected", a second vault door approved with no reviewer
 * and no guard, and three executors never flipped at all (#427).
 *
 * Scanned set, DERIVED: every non-test `.ts`/`.tsx` under `packages/<pkg>/src`
 * and `apps/<app>` (walked, so a new package or file joins by existing),
 * parsed with the TypeScript compiler. An offender is:
 *  - `<x>.update(proposals).set(<arg>)` (also `schema.proposals`, or an
 *    import alias of `proposals`) whose `<arg>` names `status`: a `status`
 *    property, a spread that can carry one (`...(c ? { status } : {})`), or
 *    anything the scan cannot read (a variable, a spread of a variable, a
 *    computed key) — an unreadable `.set` is refused, never assumed clean;
 *  - a SQL template whose text reads `UPDATE proposals SET … status`.
 * Allowed: the door module itself, and one file being retired (below).
 *
 * NOT covered, measured by the self-checks below: a `proposals` table reached
 * through a variable (`const t = proposals; db.update(t)`), a status written
 * through `db.execute(sql.raw(...))` built from strings, and an insert (a new
 * proposal is born with its status; that is not a transition).
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../..");

/** The one door: the only file allowed to write the column. */
const DOOR = "packages/database/src/utils/proposal-transition.ts";
/**
 * Retired by F-finish (backend#451, `fix/backend-truth-quickwins`): the job
 * that relabelled approved vault requests "rejected". Tolerated only while the
 * file still exists; once it is deleted this entry matches nothing.
 */
const RETIRING = new Set([
  "packages/jobs/src/workers/vault-grant-expiry-worker.ts",
]);

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  ".next",
  ".turbo",
  "__tests__",
  "__tripwires__",
  "coverage",
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (
      /\.tsx?$/.test(name) &&
      !/\.(test|spec)\.tsx?$/.test(name) &&
      !name.endsWith(".d.ts")
    )
      out.push(p);
  }
  return out;
}

function sourceRoots(): string[] {
  const roots: string[] = [];
  for (const pkg of readdirSync(join(REPO, "packages"))) {
    const src = join(REPO, "packages", pkg, "src");
    if (existsSync(src)) roots.push(src);
  }
  for (const app of readdirSync(join(REPO, "apps"))) {
    const dir = join(REPO, "apps", app);
    if (statSync(dir).isDirectory()) roots.push(dir);
  }
  return roots;
}

const RAW_SQL = /\bupdate\s+"?proposals"?\s+set\b[\s\S]*?\bstatus\b/i;

interface Scan {
  /** `update(proposals)` call sites seen (status or not): non-vacuity. */
  updateSites: number;
  /** `transitionProposal(` calls seen: non-vacuity. */
  doorCalls: number;
  /** Lines that write the status outside the door. */
  offenders: string[];
}

/** May this spread put a `status` key into the object? Unreadable = yes. */
function spreadMayWriteStatus(expr: ts.Expression): boolean {
  if (ts.isParenthesizedExpression(expr))
    return spreadMayWriteStatus(expr.expression);
  if (ts.isConditionalExpression(expr))
    return (
      spreadMayWriteStatus(expr.whenTrue) ||
      spreadMayWriteStatus(expr.whenFalse)
    );
  if (ts.isBinaryExpression(expr)) {
    const op = expr.operatorToken.kind;
    if (
      op === ts.SyntaxKind.QuestionQuestionToken ||
      op === ts.SyntaxKind.BarBarToken ||
      op === ts.SyntaxKind.AmpersandAmpersandToken
    )
      return (
        spreadMayWriteStatus(expr.left) || spreadMayWriteStatus(expr.right)
      );
    return true;
  }
  if (ts.isObjectLiteralExpression(expr)) return objectWritesStatus(expr);
  if (ts.isAsExpression(expr) || ts.isSatisfiesExpression(expr))
    return spreadMayWriteStatus(expr.expression);
  // `false`, `undefined`, `null`, a string: spreads nothing.
  if (
    expr.kind === ts.SyntaxKind.FalseKeyword ||
    expr.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(expr) && expr.text === "undefined")
  )
    return false;
  return true;
}

function objectWritesStatus(obj: ts.ObjectLiteralExpression): boolean {
  for (const p of obj.properties) {
    if (ts.isSpreadAssignment(p)) {
      if (spreadMayWriteStatus(p.expression)) return true;
      continue;
    }
    const name = p.name;
    if (!name) return true;
    if (ts.isComputedPropertyName(name)) return true;
    const text =
      ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : "";
    if (text === "status") return true;
  }
  return false;
}

function setArgWritesStatus(arg: ts.Expression | undefined): boolean {
  if (!arg) return false;
  if (ts.isParenthesizedExpression(arg))
    return setArgWritesStatus(arg.expression);
  if (ts.isAsExpression(arg) || ts.isSatisfiesExpression(arg))
    return setArgWritesStatus(arg.expression);
  if (ts.isObjectLiteralExpression(arg)) return objectWritesStatus(arg);
  return true; // a variable or a call: unreadable, so refused
}

function scanSource(path: string, text: string): Scan {
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const aliases = new Set(["proposals"]);
  const result: Scan = { updateSites: 0, doorCalls: 0, offenders: [] };
  const where = (node: ts.Node) =>
    `${path}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;

  const isProposalsTable = (e: ts.Expression | undefined): boolean =>
    !!e &&
    ((ts.isIdentifier(e) && aliases.has(e.text)) ||
      (ts.isPropertyAccessExpression(e) && e.name.text === "proposals"));

  const visit = (node: ts.Node): void => {
    if (ts.isImportSpecifier(node)) {
      const imported = (node.propertyName ?? node.name).text;
      if (imported === "proposals") aliases.add(node.name.text);
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee) && callee.text === "transitionProposal") {
        result.doorCalls++;
      }
      if (
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === "update" &&
        isProposalsTable(node.arguments[0])
      ) {
        result.updateSites++;
        // `<x>.update(proposals)` → `.set` → `.set(arg)`
        const access = node.parent;
        if (
          access &&
          ts.isPropertyAccessExpression(access) &&
          access.name.text === "set" &&
          access.parent &&
          ts.isCallExpression(access.parent)
        ) {
          if (setArgWritesStatus(access.parent.arguments[0])) {
            result.offenders.push(where(node));
          }
        }
      }
    }
    if (
      (ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateExpression(node)) &&
      RAW_SQL.test(node.getText(sf))
    ) {
      result.offenders.push(`${where(node)} (raw SQL)`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return result;
}

const FILES = sourceRoots()
  .flatMap((root) => walk(root))
  .map((p) => relative(REPO, p));
const SCANS = FILES.map((rel) => ({
  rel,
  scan: scanSource(rel, readFileSync(join(REPO, rel), "utf8")),
}));

describe("proposals.status has one writer: transitionProposal", () => {
  it("non-vacuity: the walk sees the packages, the door and its callers", () => {
    expect(FILES.length).toBeGreaterThan(1000);
    expect(FILES).toContain(DOOR);
    expect(FILES).toContain("packages/api/src/routers/proposals.ts");
    expect(FILES.some((f) => f.startsWith("packages/jobs/src/"))).toBe(true);
    expect(FILES.some((f) => f.startsWith("apps/pod-admin/"))).toBe(true);
    // The writers moved to the door are seen calling it...
    const doorCalls = SCANS.reduce((n, s) => n + s.scan.doorCalls, 0);
    expect(doorCalls).toBeGreaterThanOrEqual(100);
    // ...and the data-only writes that stay raw are still seen as update sites.
    const updates = SCANS.reduce((n, s) => n + s.scan.updateSites, 0);
    expect(updates).toBeGreaterThanOrEqual(10);
    // The door itself is recognised as a writer (so its exemption is real).
    expect(SCANS.find((s) => s.rel === DOOR)!.scan.offenders.length).toBe(1);
  });

  it("self-check: the detector sees each shape it hunts, and not a read", () => {
    const offends = (src: string) =>
      scanSource("x.ts", src).offenders.length > 0;
    expect(
      offends(`db.update(proposals).set({ status: "approved" }).where(w);`)
    ).toBe(true);
    expect(offends(`tx.update(schema.proposals).set({ "status": S });`)).toBe(
      true
    );
    expect(
      offends(
        `import { proposals as p } from "@synap/database";\ndb.update(p).set({ status: S });`
      )
    ).toBe(true);
    expect(
      offends(
        `db.update(proposals).set({ data, ...(done ? { status: S } : {}) });`
      )
    ).toBe(true);
    expect(offends(`db.update(proposals).set(values).where(w);`)).toBe(true);
    expect(offends(`db.update(proposals).set({ ...rest, updatedAt });`)).toBe(
      true
    );
    expect(
      offends(
        "db.execute(sql`UPDATE proposals SET status = 'rejected' WHERE id = ${id}`);"
      )
    ).toBe(true);
    // Not a status write:
    expect(
      offends(`db.update(proposals).set({ data: x, updatedAt: now }).where(w);`)
    ).toBe(false);
    expect(
      offends(
        `db.update(proposals).set({ ...(c ? { data } : {}), updatedAt });`
      )
    ).toBe(false);
    expect(offends(`db.update(entities).set({ status: "done" });`)).toBe(false);
    expect(
      offends(`db.select().from(proposals).where(eq(proposals.status, S));`)
    ).toBe(false);
  });

  it("no file but the door writes proposals.status", () => {
    const offenders = SCANS.filter(
      (s) => s.rel !== DOOR && !RETIRING.has(s.rel)
    ).flatMap((s) => s.scan.offenders);
    expect(
      offenders,
      "These write proposals.status outside the status door. Use transitionProposal (@synap/database): it adds the transition table's guard to your WHERE, so a decided proposal is never overwritten. A data-only update stays a plain update(proposals)."
    ).toEqual([]);
  });
});
