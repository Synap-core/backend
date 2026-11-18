/**
 * TRIPWIRE — `withdrawReason` holds an AUTHOR's own words, never a helper's.
 *
 * A withdrawn proposal says why it ended twice: `data.ended.reason` (a token
 * the end line turns into a sentence in the reader's language) and, when its
 * author gave one, `withdrawReason` (the author's words, quoted as theirs).
 * Helpers once stored their own English there: "Replaced by rerun <id>",
 * "Sent from <provider> directly; this draft was not needed.", "Superseded by
 * a fresher cleanup pack.", "Replaced by a newer version". Every surface then
 * quoted a sentence nobody wrote, in English, as the author's (finding
 * 156068a6). A helper's end is its `ended.reason`; only the withdraw door
 * writes `withdrawReason`, and only from what its caller wrote.
 *
 * Scanned set, DERIVED: every non-test `.ts`/`.tsx` under `packages/<pkg>/src`
 * and `apps/<app>` (walked: a new package or file joins by existing), parsed
 * with the TypeScript compiler. An offender, outside {@link AUTHOR_DOORS}:
 *  - an object-literal property NAMED `withdrawReason` (`withdrawReason: x`,
 *    the shorthand `{ withdrawReason }`, a quoted or computed key): the
 *    `ended` stamp handed to `transitionProposal`, a JSON stamp, a payload;
 *  - SQL text that BUILDS the key: `jsonb_build_object(… 'withdrawReason', …)`
 *    or a `'{withdrawReason}'` path (`jsonb_set`);
 *  - outside {@link WITHDRAW_CALLERS}, a call `<x>.withdraw({ proposalId,
 *    reason })` (the tRPC procedure's input): it stores its `reason` as the
 *    author's words, so a helper calling it with its own sentence is the same
 *    defect one hop away (the rerun did exactly that).
 *
 * NOT covered, measured by the self-checks below: a key built from a variable
 * (`{ [k]: v }` with `const k = "withdrawReason"`), SQL assembled with
 * `sql.raw` from strings, and a reason passed to `withdrawOwnProposal` as
 * `{ reason: "author", withdrawReason }` from INSIDE an allowed door (the door
 * is trusted to pass its caller's words). Reads (`data->>'withdrawReason'`,
 * `ended.withdrawReason`, a type's `withdrawReason?: string`) are not writes.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../..");

const KEY = "withdrawReason";

/**
 * Where `withdrawReason` may be written: file → the enclosing named function
 * or object property (null = the whole file), and why.
 */
const AUTHOR_DOORS: ReadonlyArray<{
  file: string;
  within: string | null;
  why: string;
}> = [
  {
    file: "packages/api/src/routers/proposals.ts",
    within: "withdraw",
    why: "the tRPC procedure: its `reason` is the caller's own words (zod input)",
  },
  {
    file: "packages/api/src/routers/proposals.ts",
    within: "withdrawOwnProposal",
    why: "THE withdraw door: stores `end.withdrawReason`, which only an author's `end` carries",
  },
  {
    file: "packages/types/src/proposals/ended.ts",
    within: null,
    why: "the read model: builds the read object from the stored stamp (no write)",
  },
];

/** Who may call `<x>.withdraw({ reason })`, and whose words `reason` is. */
const WITHDRAW_CALLERS: Readonly<Record<string, string>> = {
  "packages/api/src/routers/mcp/handlers/build.ts":
    "the agent's own `reason` argument, routed to withdraw when it rejects its own proposal",
};

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

function sourceFiles(): string[] {
  const files: string[] = [];
  for (const pkg of readdirSync(join(REPO, "packages"))) {
    const src = join(REPO, "packages", pkg, "src");
    if (existsSync(src)) walk(src, files);
  }
  for (const app of readdirSync(join(REPO, "apps"))) {
    const dir = join(REPO, "apps", app);
    if (statSync(dir).isDirectory()) walk(dir, files);
  }
  return files;
}

/** SQL text that builds the key (never one that only reads it). */
const SQL_BUILDS_KEY = new RegExp(
  String.raw`jsonb_build_object\((?:[^()]|\([^()]*\))*?['"]${KEY}['"]|'\{${KEY}\}'`
);

function nameText(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  if (
    ts.isComputedPropertyName(name) &&
    ts.isStringLiteralLike(name.expression)
  )
    return name.expression.text;
  return null;
}

/** The nearest enclosing named function or object property, outermost last. */
function enclosingNames(node: ts.Node): string[] {
  const names: string[] = [];
  for (let n = node.parent; n; n = n.parent) {
    if (
      (ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) &&
      n.name
    ) {
      const t = nameText(n.name);
      if (t) names.push(t);
    } else if (ts.isPropertyAssignment(n)) {
      const t = nameText(n.name);
      if (t) names.push(t);
    } else if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) {
      names.push(n.name.text);
    }
  }
  return names;
}

interface Site {
  file: string;
  line: number;
  kind: "property" | "sql" | "withdraw-call";
  within: string[];
}

function scanSource(file: string, text: string): Site[] {
  const sf = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const sites: Site[] = [];
  const at = (node: ts.Node, kind: Site["kind"]) =>
    sites.push({
      file,
      line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
      kind,
      within: enclosingNames(node),
    });
  const visit = (node: ts.Node): void => {
    if (
      (ts.isPropertyAssignment(node) ||
        ts.isShorthandPropertyAssignment(node)) &&
      nameText(node.name) === KEY
    ) {
      at(node, "property");
    } else if (
      (ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateExpression(node) ||
        ts.isStringLiteral(node)) &&
      SQL_BUILDS_KEY.test(node.getText(sf))
    ) {
      at(node, "sql");
    } else if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "withdraw" &&
      node.arguments.some((a) => {
        if (!ts.isObjectLiteralExpression(a)) return false;
        const keys = new Set(
          a.properties.flatMap((p) =>
            !ts.isSpreadAssignment(p) && p.name ? [nameText(p.name)] : []
          )
        );
        // The tRPC procedure's input: a proposal and its author's words.
        return keys.has("proposalId") && keys.has("reason");
      })
    ) {
      at(node, "withdraw-call");
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return sites;
}

function allowed(site: Site): boolean {
  if (site.kind === "withdraw-call") return site.file in WITHDRAW_CALLERS;
  return AUTHOR_DOORS.some(
    (d) =>
      d.file === site.file &&
      (d.within === null || site.within.includes(d.within))
  );
}

describe("withdrawReason holds an author's words: no helper writes it", () => {
  const files = sourceFiles();
  const sites = files.flatMap((abs) =>
    scanSource(relative(REPO, abs), readFileSync(abs, "utf8"))
  );

  it("sees the tree and the doors it allows (non-vacuity)", () => {
    expect(files.length).toBeGreaterThan(1000);
    // Every allowed door is still written through: a door that moved or was
    // renamed leaves a stale entry, never a silent widening.
    for (const d of AUTHOR_DOORS.filter((x) => x.within !== null)) {
      expect(
        sites.some(
          (s) =>
            s.kind !== "withdraw-call" &&
            s.file === d.file &&
            s.within.includes(d.within!)
        ),
        `${d.file} › ${d.within}: no write seen — stale entry or blind scan`
      ).toBe(true);
    }
    for (const file of Object.keys(WITHDRAW_CALLERS)) {
      expect(
        sites.some((s) => s.kind === "withdraw-call" && s.file === file),
        `${file}: no withdraw({ reason }) call seen — stale entry`
      ).toBe(true);
    }
  });

  it("the classifier sees each write form and skips reads (self-check)", () => {
    const sample = [
      "const a = { ended: { reason: 'author', withdrawReason: words } };",
      "const b = { withdrawReason };",
      "const c = { ['withdrawReason']: 'x' };",
      "const d = sql`x || jsonb_build_object('supersededBy', ${id}::text, 'withdrawReason', ${r}::text)`;",
      "const e = sql`jsonb_set(data, '{withdrawReason}', to_jsonb(${r}::text))`;",
      "async function f() { await caller.withdraw({ proposalId, reason: `Replaced by ${x}` }); }",
      // Reads and types: never sites.
      "interface T { withdrawReason?: string; }",
      "type U = { reason: 'author'; withdrawReason?: string };",
      "const g = sql`select data->>'withdrawReason' as words`;",
      "const h = row.ended.withdrawReason;",
      "const i = new Set(['withdrawReason']);",
      "await caller.withdraw({ proposalId });",
      // The door's own end (a reason token), not the procedure's input.
      "await args.withdraw(p.id, { reason: 'superseded' });",
    ].join("\n");
    const found = scanSource("sample.ts", sample).map(
      (s) => `${s.line}:${s.kind}`
    );
    expect(found).toEqual([
      "1:property",
      "2:property",
      "3:property",
      "4:sql",
      "5:sql",
      "6:withdraw-call",
    ]);
  });

  it("no helper writes withdrawReason or hands the withdraw door its own words", () => {
    const offenders = sites
      .filter((s) => !allowed(s))
      .map(
        (s) =>
          `${s.file}:${s.line} (${s.kind}${s.within[0] ? ` in ${s.within[0]}` : ""})`
      );
    expect(
      offenders,
      "a helper that ends a proposal says why with `ended: { reason }` " +
        "(add a reason to PROPOSAL_END_REASONS, with its en + fr sentence, " +
        "if none fits), never a sentence stored as `withdrawReason`: " +
        offenders.join(", ")
    ).toEqual([]);
  });
});
