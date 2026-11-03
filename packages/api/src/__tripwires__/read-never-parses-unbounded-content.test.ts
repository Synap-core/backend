/**
 * TRIPWIRE `read-never-parses-unbounded-content` — no pod code path may run the
 * markdown PARSE on stored content it has not bounded.
 *
 * WHY: on 3 Nov 2026 the founder's pod froze. A document READ ran the markdown
 * parse (diagnostics, readable form, sections) on 46-126 MB stored videos,
 * synchronously, 60-110 s per read, so the pod answered nothing else and its
 * health check restarted it. backend#731 added ONE gate, `readsAsMarkdown`
 * (services/document-patch/read-document.ts), and backend#732 a second door
 * on the same rule, `readOmitsStoredBody` (bytes left in storage). This guard
 * makes the next read path that forgets the gate go red.
 *
 * WHAT A "PARSE" IS (derived, never listed): every unit that reaches the
 * mdast parser. The seed is each `@synap-core/markdown-core` unit that calls
 * a unified processor's `.parse(` (today `parseMarkdownWithDiagnostics`;
 * `JSON.parse` excluded). Parsing then PROPAGATES to every caller, inside
 * markdown-core (collectDiagnostics, readableMarkdown, locateEmbeds,
 * markdownToPlainText, listSections, segmentSlides, segmentPassages,
 * leadingHeading, bodyWithoutTitleHeading, resolveDocumentTitle,
 * isSameTitle, stripInlineFormatting…) and through the pod's own wrappers
 * (diagnoseDocument, diagnoseForDocument, currentDiagnostics, the api
 * `readableMarkdown`…). Measured on 1 MB of random bytes decoded as UTF-8
 * (what a video read produced): parseMarkdown 1007 ms, collectDiagnostics
 * 1084 ms, readableMarkdown 1824 ms, locateEmbeds 904 ms,
 * markdownToPlainText 927 ms, segmentPassages 1787 ms; ~1 s per MB, so a
 * 126 MB video is the 2-minute freeze.
 *
 * NOT a parse, on purpose: the line scanner `scanContainers` (and so the api
 * `parseSections` / `listDocumentSections` built on it). It splits lines and
 * matches openers: 3 ms on the same 1 MB, linear, ~300x cheaper than the
 * parse. A guard that counted it would list every section edit as a parse
 * and drown the signal. (#731 gates `listDocumentSections` in the agent
 * projection anyway; that call simply is not what this guard watches.)
 *
 * HOW (TypeScript AST, nothing below lists a call site):
 *  1. Parse every non-test source file of every `packages/<pkg>/src` and of
 *     `apps/api/src` (the pod process: the API, its reactors and its pg-boss
 *     workers run in it) into UNITS: a function, a method, or an anonymous
 *     function bound at module level to a variable or an object property
 *     (`documentsRouter.getDocument`, a router procedure). An anonymous
 *     callback inside a function belongs to that function.
 *  2. Edges are identifier REFERENCES (a call, or a function passed as a
 *     value) resolved through imports: relative imports by file, workspace
 *     packages by their `package.json` name and subpath, following
 *     `export … from` re-exports; `this.m()` to the same class.
 *  3. A unit that references the gate (`readsAsMarkdown` or
 *     `readOmitsStoredBody`, resolved to read-document.ts, so a same-named
 *     local function does not count) is GATED and does not propagate.
 *  4. A unit on BOUNDED (its input is bounded: the limit is cited) or
 *     ACKNOWLEDGED (known debt, may only shrink) is judged and does not
 *     propagate either.
 *  5. RED when a parsing unit outside markdown-core has no caller (a door: a
 *     router procedure, a reactor, a worker handler, an unresolved callee)
 *     and is neither gated nor listed.
 *
 * NON-VACUITY: > 1,500 files parsed; the seed is exactly the processor's
 * parse; the known wrappers parse; the three #731 doors are seen GATED; and
 * the same analyzer, fed a literal ungated read next to its gated twin,
 * flags the one and not the other (self-check below).
 *
 * WHAT IT DOES NOT SEE (stated, measured where it could be):
 *  - Granularity is the UNIT: a gate anywhere in a unit gates all of it, and
 *    a gated unit's callees are trusted. Verified: with `parsed = true` in
 *    `projectAgentDocument` the door scan stays GREEN (hub `getDocument`
 *    still references the gate for its diagnostics); what goes red is the
 *    "#731 doors are gated" check and the driven projection test below.
 *  - A call through a value it cannot name: `obj.method()` on anything but
 *    `this` or a namespace import, a callback stored in a registry, a
 *    dynamic `import()`. Such a callee is a "door" (no resolved caller), so a
 *    parse behind it still shows up, at the callee.
 *  - Code outside the pod process: `apps/pod-admin` (its own Next server, it
 *    parses in the browser or its own process, never on the pod's thread),
 *    the intelligence service, relay, browser.
 *  - Whether the gate DOMINATES the parse (it reads that the unit consults
 *    it, not that the branch is right). The driven test below pins the
 *    branch for the agent projection only.
 *  - Judged entries (BOUNDED, ACKNOWLEDGED) stop propagation: a new caller
 *    of a judged unit is not checked. Judge the door, not a shared helper.
 */
import { describe, expect, it, vi } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  MARKDOWN_READ_MAX_CHARS,
  projectAgentDocument,
  unparsedDiagnostics,
} from "../services/document-patch/read-document.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../..");
const CORE_PKG = "packages/markdown-core";
const GATE_FILE = "packages/api/src/services/document-patch/read-document.ts";
const GATES = ["readsAsMarkdown", "readOmitsStoredBody"] as const;
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "__tests__",
  "__tripwires__",
  "__fixtures__",
]);

/**
 * Parsing doors whose input is BOUNDED before the parse. Each reason cites
 * the limit. A unit here must still parse (a stale entry goes red).
 */
const BOUNDED: Record<string, string> = {
  // `loadDocumentBodyTexts` (database utils/document-body-text.ts) decodes at
  // most TEXT_PREVIEW_LIMIT = 64,000 bytes of a body
  // (`documentVersionContentPreview`, document-version-storage.ts).
  "packages/search/src/services/indexing-service.ts#IndexingService.loadDocumentBodies":
    "markdownToPlainText on loadDocumentBodyTexts text: at most 64,000 bytes (TEXT_PREVIEW_LIMIT)",
  "packages/jobs/src/workers/entity-embedding.ts#handleEntityEmbedding":
    "markdownToPlainText on loadDocumentBodyTexts text: at most 64,000 bytes (TEXT_PREVIEW_LIMIT)",
  "packages/jobs/src/workers/document-passages.ts#handleDocumentPassages":
    "segmentPassages / markdownToPlainText on loadDocumentBodyTexts text: at most 64,000 bytes (TEXT_PREVIEW_LIMIT)",
  "packages/api/src/services/knowledge/synthesize.ts#buildSynthesisContext":
    "bodyExcerpt segments rec.content, retrieve.ts's loadDocumentBodyTexts text: at most 64,000 bytes (TEXT_PREVIEW_LIMIT)",
};

/**
 * Parsing doors that run the parse on content NOTHING bounds: known debt,
 * none of them a plain read. May only SHRINK (the ceiling is this list's
 * size). To leave it: gate with `readsAsMarkdown` (the ONE rule), or bound
 * the input and move the entry to BOUNDED with the limit cited.
 */
const ACKNOWLEDGED: Record<string, string> = {
  "packages/database/src/utils/claim-document-revision.ts#namedDocumentBody":
    "write: a markdown document being created (create, upload, capture, intake); resolveDocumentTitle parses its first block, which runs to the first blank line; no size cap on the input",
  "packages/api/src/services/document-patch/apply-document-patch.ts#applyDocumentPatch":
    "write: diagnoses the document being edited (stored body + the patch); loadPatchDocument checks neither its type nor its size",
  "packages/api/src/services/document-patch/apply-document-patch.ts#suggestDocumentPatch":
    "write: diagnoses the proposed body (stored body + the patch); same load as applyDocumentPatch",
  "packages/api/src/services/document-patch/apply-document-patch.ts#applyApprovedDocumentPatch":
    "write: diagnoses the approved body (stored body + the patch); same load as applyDocumentPatch",
  "packages/api/src/services/document-patch/undo-document-edit.ts#undoDocumentEdit":
    "write: diagnoses the body an undo restores (stored body - one edit); same load as applyDocumentPatch",
  "packages/api/src/services/capabilities/builtin-verbs.ts#documentFreezeChartsHandler":
    "verb input: a report flow's assembled markdown, not a stored body; documentFreezeChartsParams.markdown has no .max()",
  "packages/api/src/services/document-charts/stamp-run-diagnostics.ts#stampRunDiagnostics":
    "write: the owner's run stamps a document it created (a report); reads its stored body with no type or size check",
  "packages/api/src/services/document-title/backfill-title-heading.ts#backfillOne":
    "one-off backfill over type = 'markdown' rows; leadingHeading parses the first block only, to the first blank line",
};
const ACKNOWLEDGED_CEILING = 8;

// ─── The analyzer ────────────────────────────────────────────────────────────

interface Unit {
  key: string;
  file: string;
  /** Names a reference resolves to: `f`, or `Class.m` for a method. */
  name: string;
  refs: Set<string>;
  callsProcessorParse: boolean;
}

interface FileInfo {
  rel: string;
  sf: ts.SourceFile;
  /** local name → { spec, imported } (`*` for a namespace import). */
  imports: Map<string, { spec: string; imported: string }>;
  /** exported name → { spec | null, local } for `export { a as b } [from]`. */
  reexports: Map<string, { spec: string | null; local: string }>;
  starExports: string[];
  units: Map<string, Unit>;
}

export interface Analysis {
  files: number;
  units: Map<string, Unit>;
  parsing: Set<string>;
  gated: Set<string>;
  seed: string[];
  /** Parsing units outside markdown-core with no resolved caller. */
  doors: string[];
  pathTo: (key: string) => string;
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (
      /\.tsx?$/.test(name) &&
      !/\.(test|spec)\.tsx?$/.test(name) &&
      !name.endsWith(".d.ts")
    )
      out.push(p);
  }
  return out;
}

/** The pod process's source: every package's `src`, and `apps/api/src`. */
export function podSources(): Map<string, string> {
  const roots = readdirSync(join(REPO, "packages"))
    .map((p) => `packages/${p}/src`)
    .concat("apps/api/src");
  const out = new Map<string, string>();
  for (const root of roots)
    for (const abs of sourceFiles(join(REPO, root)))
      out.set(relative(REPO, abs), readFileSync(abs, "utf8"));
  return out;
}

function packageDirs(): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of readdirSync(join(REPO, "packages"))) {
    const pj = join(REPO, "packages", p, "package.json");
    if (existsSync(pj))
      out.set(JSON.parse(readFileSync(pj, "utf8")).name, `packages/${p}`);
  }
  return out;
}

const FUNCTION_LIKE = (n: ts.Node) =>
  ts.isFunctionDeclaration(n) ||
  ts.isMethodDeclaration(n) ||
  ts.isArrowFunction(n) ||
  ts.isFunctionExpression(n) ||
  ts.isConstructorDeclaration(n) ||
  ts.isGetAccessorDeclaration(n) ||
  ts.isSetAccessorDeclaration(n);

/** Whether `n` sits inside a function-like node (stopping at `stop`). */
function insideFunction(n: ts.Node): boolean {
  for (let p = n.parent; p; p = p.parent) if (FUNCTION_LIKE(p)) return true;
  return false;
}

function propName(n: ts.PropertyName): string | null {
  return ts.isIdentifier(n) || ts.isStringLiteral(n) ? n.text : null;
}

/** The module-level dotted path of a variable / property chain. */
function boundPath(n: ts.Node): string | null {
  const parts: string[] = [];
  for (let p: ts.Node | undefined = n; p; p = p.parent) {
    if (ts.isPropertyAssignment(p)) {
      const k = propName(p.name);
      if (!k) return null;
      parts.unshift(k);
    } else if (ts.isVariableDeclaration(p)) {
      if (!ts.isIdentifier(p.name)) return null;
      parts.unshift(p.name.text);
      return parts.join(".");
    } else if (ts.isPropertyDeclaration(p)) {
      const k = propName(p.name);
      const cls = p.parent;
      if (!k || !ts.isClassLike(cls) || !cls.name) return null;
      return [cls.name.text, k, ...parts].join(".");
    } else if (FUNCTION_LIKE(p) && p !== n) return null;
    else if (ts.isSourceFile(p)) return null;
  }
  return null;
}

/**
 * The unit an anonymous function IS, when it is its own unit: bound (through
 * a call chain such as `proc.input(x).query(fn)`) to a module-level
 * variable or object property. Otherwise it belongs to its enclosing unit.
 */
function anonymousUnitName(fn: ts.Node): string | null {
  if (insideFunction(fn)) return null;
  let p: ts.Node = fn.parent;
  while (
    p &&
    (ts.isCallExpression(p) ||
      ts.isPropertyAccessExpression(p) ||
      ts.isParenthesizedExpression(p) ||
      ts.isAsExpression(p) ||
      ts.isSatisfiesExpression(p) ||
      ts.isAwaitExpression(p))
  )
    p = p.parent;
  if (
    ts.isPropertyAssignment(p) ||
    ts.isVariableDeclaration(p) ||
    ts.isPropertyDeclaration(p)
  )
    return boundPath(p);
  return null;
}

function unitNameOf(fn: ts.Node): string | null {
  if (ts.isFunctionDeclaration(fn)) return fn.name?.text ?? "default";
  if (
    ts.isMethodDeclaration(fn) ||
    ts.isGetAccessorDeclaration(fn) ||
    ts.isSetAccessorDeclaration(fn) ||
    ts.isConstructorDeclaration(fn)
  ) {
    const owner = fn.parent;
    const m = ts.isConstructorDeclaration(fn)
      ? "constructor"
      : propName(fn.name);
    if (!m) return null;
    if (ts.isClassLike(owner)) return `${owner.name?.text ?? "default"}.${m}`;
    if (ts.isObjectLiteralExpression(owner)) {
      if (insideFunction(owner)) return null;
      const base = boundPath(owner.parent);
      return base ? `${base}.${m}` : null;
    }
    return null;
  }
  return anonymousUnitName(fn);
}

function isTypePosition(n: ts.Node): boolean {
  for (let p = n.parent; p; p = p.parent) {
    if (ts.isTypeNode(p) || ts.isTypeAliasDeclaration(p)) return true;
    if (ts.isInterfaceDeclaration(p)) return true;
    if (ts.isExpression(p) || ts.isStatement(p)) return false;
  }
  return false;
}

function indexFile(rel: string, text: string): FileInfo {
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true);
  const info: FileInfo = {
    rel,
    sf,
    imports: new Map(),
    reexports: new Map(),
    starExports: [],
    units: new Map(),
  };
  const moduleUnit: Unit = {
    key: `${rel}#<module>`,
    file: rel,
    name: "<module>",
    refs: new Set(),
    callsProcessorParse: false,
  };
  info.units.set("<module>", moduleUnit);

  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
      const spec = st.moduleSpecifier.text;
      const c = st.importClause;
      if (!c || c.isTypeOnly) continue;
      if (c.name) info.imports.set(c.name.text, { spec, imported: "default" });
      const nb = c.namedBindings;
      if (nb && ts.isNamespaceImport(nb))
        info.imports.set(nb.name.text, { spec, imported: "*" });
      else if (nb)
        for (const el of nb.elements)
          if (!el.isTypeOnly)
            info.imports.set(el.name.text, {
              spec,
              imported: (el.propertyName ?? el.name).text,
            });
    } else if (ts.isExportDeclaration(st) && !st.isTypeOnly) {
      const spec =
        st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)
          ? st.moduleSpecifier.text
          : null;
      if (!st.exportClause && spec) info.starExports.push(spec);
      else if (st.exportClause && ts.isNamedExports(st.exportClause))
        for (const el of st.exportClause.elements)
          info.reexports.set(el.name.text, {
            spec,
            local: (el.propertyName ?? el.name).text,
          });
    }
  }

  const unitFor = (n: ts.Node): Unit => {
    for (let p: ts.Node | undefined = n; p; p = p.parent) {
      if (!FUNCTION_LIKE(p)) continue;
      const name = unitNameOf(p);
      if (name === null) continue;
      let u = info.units.get(name);
      if (!u) {
        u = {
          key: `${rel}#${name}`,
          file: rel,
          name,
          refs: new Set(),
          callsProcessorParse: false,
        };
        info.units.set(name, u);
      }
      return u;
    }
    return moduleUnit;
  };

  const visit = (n: ts.Node) => {
    if (FUNCTION_LIKE(n)) unitFor(n); // a unit exists even with no refs
    if (
      ts.isIdentifier(n) &&
      !isTypePosition(n) &&
      // `import { a as b }` / `export { a as b }`: both names are bindings.
      !ts.isImportSpecifier(n.parent) &&
      !ts.isExportSpecifier(n.parent)
    ) {
      const p = n.parent;
      const declName =
        (ts.isFunctionDeclaration(p) ||
          ts.isVariableDeclaration(p) ||
          ts.isParameter(p) ||
          ts.isImportSpecifier(p) ||
          ts.isImportClause(p) ||
          ts.isNamespaceImport(p) ||
          ts.isExportSpecifier(p) ||
          ts.isMethodDeclaration(p) ||
          ts.isPropertyDeclaration(p) ||
          ts.isClassDeclaration(p) ||
          ts.isBindingElement(p)) &&
        (p as { name?: ts.Node }).name === n;
      const isPropKey =
        (ts.isPropertyAssignment(p) && p.name === n) ||
        (ts.isPropertyAccessExpression(p) && p.name === n);
      if (!declName && !isPropKey) unitFor(n).refs.add(n.text);
      if (ts.isShorthandPropertyAssignment(p)) unitFor(n).refs.add(n.text);
    }
    if (ts.isPropertyAccessExpression(n) && !isTypePosition(n)) {
      const target = n.expression;
      if (target.kind === ts.SyntaxKind.ThisKeyword) {
        const cls = ts.findAncestor(n, ts.isClassLike);
        if (cls?.name)
          unitFor(n).refs.add(`this:${cls.name.text}.${n.name.text}`);
      } else if (ts.isIdentifier(target)) {
        unitFor(n).refs.add(`ns:${target.text}.${n.name.text}`);
      }
      if (
        n.name.text === "parse" &&
        ts.isCallExpression(n.parent) &&
        n.parent.expression === n &&
        !(ts.isIdentifier(target) && target.text === "JSON")
      )
        unitFor(n).callsProcessorParse = true;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return info;
}

export function analyze(
  sources: Map<string, string>,
  judged: ReadonlySet<string>
): Analysis {
  const pkgs = packageDirs();
  const files = new Map<string, FileInfo>();
  for (const [rel, text] of sources) files.set(rel, indexFile(rel, text));

  const fileFor = (from: string, spec: string): string | null => {
    let base: string;
    if (spec.startsWith(".")) base = join(dirname(from), spec);
    else {
      const name = [...pkgs.keys()]
        .filter((p) => spec === p || spec.startsWith(p + "/"))
        .sort((a, b) => b.length - a.length)[0];
      if (!name) return null;
      const sub = spec.slice(name.length + 1);
      base = join(pkgs.get(name)!, "src", sub || "index");
    }
    base = base.replace(/\.(m?js|tsx?)$/, "");
    for (const c of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`])
      if (files.has(c)) return c;
    return null;
  };

  const lookupExport = (
    file: string,
    name: string,
    seen = new Set<string>()
  ): Unit | null => {
    const tag = `${file}::${name}`;
    if (seen.has(tag)) return null;
    seen.add(tag);
    const f = files.get(file);
    if (!f) return null;
    const re = f.reexports.get(name);
    if (re) {
      if (re.spec === null) return localOrImport(file, re.local, seen);
      const t = fileFor(file, re.spec);
      return t ? lookupExport(t, re.local, seen) : null;
    }
    const own = localOrImport(file, name, seen);
    if (own) return own;
    for (const spec of f.starExports) {
      const t = fileFor(file, spec);
      const hit = t ? lookupExport(t, name, seen) : null;
      if (hit) return hit;
    }
    return null;
  };

  const localOrImport = (
    file: string,
    name: string,
    seen = new Set<string>()
  ): Unit | null => {
    const f = files.get(file)!;
    const own = f.units.get(name);
    if (own) return own;
    const imp = f.imports.get(name);
    if (imp && imp.imported !== "*") {
      const t = fileFor(file, imp.spec);
      return t ? lookupExport(t, imp.imported, seen) : null;
    }
    return null;
  };

  /** Every unit a reference token of `u` resolves to. */
  const resolveRef = (u: Unit, ref: string): Unit | null => {
    if (ref.startsWith("this:"))
      return files.get(u.file)!.units.get(ref.slice(5)) ?? null;
    if (ref.startsWith("ns:")) {
      const [ns, member] = ref.slice(3).split(".");
      const imp = files.get(u.file)!.imports.get(ns!);
      if (!imp || imp.imported !== "*") return null;
      const t = fileFor(u.file, imp.spec);
      return t ? lookupExport(t, member!) : null;
    }
    return localOrImport(u.file, ref);
  };

  const units = new Map<string, Unit>();
  for (const f of files.values())
    for (const u of f.units.values()) units.set(u.key, u);

  const edges = new Map<string, Set<string>>();
  const callers = new Map<string, Set<string>>();
  for (const u of units.values()) {
    const out = new Set<string>();
    for (const ref of u.refs) {
      const t = resolveRef(u, ref);
      if (t && t.key !== u.key) out.add(t.key);
    }
    edges.set(u.key, out);
    for (const t of out) {
      if (!callers.has(t)) callers.set(t, new Set());
      callers.get(t)!.add(u.key);
    }
  }

  const gateKeys = new Set(GATES.map((g) => `${GATE_FILE}#${g}`));
  const gated = new Set<string>();
  for (const [k, out] of edges)
    if ([...out].some((t) => gateKeys.has(t))) gated.add(k);

  const seed = [...units.values()]
    .filter((u) => u.file.startsWith(CORE_PKG + "/") && u.callsProcessorParse)
    .map((u) => u.key);
  const parsing = new Set(seed);
  // `reaches`: would parse if nothing were judged (to catch stale entries).
  const reaches = new Set(seed);
  const hits = (out: Set<string>, set: Set<string>) =>
    [...out].some((t) => set.has(t));
  for (let changed = true; changed;) {
    changed = false;
    for (const [k, out] of edges) {
      if (gated.has(k)) continue;
      if (!reaches.has(k) && hits(out, reaches)) {
        reaches.add(k);
        changed = true;
      }
      // A judged unit is a classified door: it does not propagate.
      if (!judged.has(k) && !parsing.has(k) && hits(out, parsing)) {
        parsing.add(k);
        changed = true;
      }
    }
  }
  for (const k of judged) if (reaches.has(k)) parsing.add(k);

  const doors = [...parsing]
    .filter((k) => !k.startsWith(CORE_PKG + "/"))
    .filter((k) => !judged.has(k))
    .filter((k) => {
      const by = [...(callers.get(k) ?? [])];
      return by.length === 0;
    })
    .sort();

  /** How a unit reaches the parse: `unit → … → markdown-core`, shortest. */
  const pathTo = (from: string): string => {
    const prev = new Map<string, string>([[from, ""]]);
    const queue = [from];
    while (queue.length) {
      const k = queue.shift()!;
      if (seed.includes(k)) {
        const chain: string[] = [];
        for (let c = k; c; c = prev.get(c)!) chain.unshift(c.split("#")[1]!);
        return chain.join(" → ");
      }
      for (const t of edges.get(k) ?? [])
        if (reaches.has(t) && !gated.has(t) && !prev.has(t)) {
          prev.set(t, k);
          queue.push(t);
        }
    }
    return "?";
  };

  return { files: files.size, units, parsing, gated, seed, doors, pathTo };
}

// ─── The guard ───────────────────────────────────────────────────────────────

const JUDGED = new Set([...Object.keys(BOUNDED), ...Object.keys(ACKNOWLEDGED)]);
const SOURCES = podSources();
const A = analyze(SOURCES, JUDGED);
const K = (file: string, name: string) => `${file}#${name}`;

describe("read-never-parses-unbounded-content — the scan sees the tree", () => {
  it("parses the whole pod process", () => {
    expect(A.files).toBeGreaterThan(1500);
  });

  it("the seed is the processor's parse, and nothing else", () => {
    expect(A.seed).toEqual([
      K(`${CORE_PKG}/src/processor.ts`, "parseMarkdownWithDiagnostics"),
    ]);
  });

  it("the parse reaches the markdown-core readers and the pod's wrappers", () => {
    for (const k of [
      K(`${CORE_PKG}/src/diagnostics.ts`, "collectDiagnostics"),
      K(`${CORE_PKG}/src/readable.ts`, "readableMarkdown"),
      K(`${CORE_PKG}/src/readable.ts`, "locateEmbeds"),
      K(`${CORE_PKG}/src/plain-text.ts`, "markdownToPlainText"),
      K(`${CORE_PKG}/src/sections.ts`, "segmentPassages"),
      K(
        "packages/api/src/services/document-patch/document-diagnostics.ts",
        "diagnoseDocument"
      ),
      K(
        "packages/api/src/services/document-patch/apply-document-patch.ts",
        "diagnoseForDocument"
      ),
      K(GATE_FILE, "currentDiagnostics"),
      K(GATE_FILE, "readableMarkdown"),
    ])
      expect(A.parsing, k).toContain(k);
    // The line scanner is not a parse (measured ~300x cheaper, header).
    expect(A.parsing).not.toContain(
      K(`${CORE_PKG}/src/scan.ts`, "scanContainers")
    );
  });

  it("sees the #731 doors as gated", () => {
    for (const k of [
      K(GATE_FILE, "projectAgentDocument"),
      K(
        "packages/api/src/routers/hub-protocol/documents.ts",
        "documentsRouter.getDocument"
      ),
      K("packages/api/src/routers/documents.ts", "documentsRouter.get"),
    ])
      expect(A.gated, k).toContain(k);
  });
});

describe("read-never-parses-unbounded-content — every door is gated or judged", () => {
  it("no parsing door is left ungated", () => {
    // A door here runs the markdown parse on content nothing bounded. Gate
    // it with `readsAsMarkdown` (read-document.ts), the ONE rule; if its
    // input is bounded, cite the limit in BOUNDED.
    expect(A.doors.map((k) => `${k}: ${A.pathTo(k)}`)).toEqual([]);
  });

  it("every judged entry still parses (no stale entry)", () => {
    const stale = [...JUDGED].filter((k) => !A.parsing.has(k));
    expect(stale).toEqual([]);
  });

  it("ACKNOWLEDGED only shrinks", () => {
    expect(Object.keys(ACKNOWLEDGED).length).toBeLessThanOrEqual(
      ACKNOWLEDGED_CEILING
    );
  });
});

describe("read-never-parses-unbounded-content — self-check on a literal sample", () => {
  const ungated = "packages/api/src/__synthetic__/ungated-read.ts";
  const gatedTwin = "packages/api/src/__synthetic__/gated-read.ts";
  const withSamples = new Map(SOURCES);
  withSamples.set(
    ungated,
    `import { readableMarkdown } from "../services/document-patch/read-document.js";
     export const sampleRouter = router({
       read: proc.query(async ({ input }) => readableMarkdown(await load(input.id))),
     });`
  );
  withSamples.set(
    gatedTwin,
    `import { readableMarkdown, readsAsMarkdown } from "../services/document-patch/read-document.js";
     export const twinRouter = router({
       read: proc.query(async ({ input }) => {
         const doc = await load(input.id);
         return readsAsMarkdown(doc, doc.content) ? readableMarkdown(doc.content) : doc.content;
       }),
     });`
  );
  const S = analyze(withSamples, JUDGED);

  it("flags the ungated read and not its gated twin", () => {
    expect(S.doors.filter((k) => k.includes("/__synthetic__/"))).toEqual([
      K(ungated, "sampleRouter.read"),
    ]);
    expect(S.gated).toContain(K(gatedTwin, "twinRouter.read"));
  });
});

// ─── Behaviour: the agent projection never parses a file or an oversized body ─

const counts = vi.hoisted(() => ({ readable: 0, sections: 0 }));
vi.mock("@synap-core/markdown-core/readable", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@synap-core/markdown-core/readable")>();
  return {
    ...actual,
    readableMarkdown: (...args: Parameters<typeof actual.readableMarkdown>) => {
      counts.readable += 1;
      return actual.readableMarkdown(...args);
    },
  };
});
vi.mock("../services/session-document/sections.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../services/session-document/sections.js")
    >();
  return {
    ...actual,
    parseSections: (...args: Parameters<typeof actual.parseSections>) => {
      counts.sections += 1;
      return actual.parseSections(...args);
    },
  };
});

describe("read-never-parses-unbounded-content — the projection, driven", () => {
  const row = (type: string, mimeType: string | null) => ({
    id: "d1",
    title: "free-take-v1-draft.mp4",
    type,
    mimeType,
    language: null,
    workspaceId: "ws-1",
    contentRevision: 1,
    currentVersion: 1,
    scope: null,
    refreshAutomationId: null,
    updatedAt: "2026-11-03T00:00:00.000Z",
    createdAt: "2026-11-03T00:00:00.000Z",
  });
  const project = (doc: ReturnType<typeof row>, raw: string) => {
    counts.readable = 0;
    counts.sections = 0;
    return projectAgentDocument(
      doc,
      raw,
      "readable",
      unparsedDiagnostics(doc, raw)
    );
  };
  const SECTION = '::::synap-section{id="a" owner="ai"}\n## A\n::::\n';

  it("a 2 MB video body: returned as stored, never parsed", () => {
    const raw = SECTION + "x".repeat(2_000_000);
    const out = project(row("file", "video/mp4"), raw);
    expect(out.content).toBe(raw);
    expect(out.sections).toEqual([]);
    expect(counts).toEqual({ readable: 0, sections: 0 });
  });

  it("a markdown body over the cap: returned as stored, never parsed", () => {
    const raw = SECTION + "x".repeat(MARKDOWN_READ_MAX_CHARS);
    const out = project(row("markdown", null), raw);
    expect(out.content).toBe(raw);
    expect(counts).toEqual({ readable: 0, sections: 0 });
  });

  it("a markdown body under the cap is still parsed (the counters count)", () => {
    const out = project(row("markdown", null), SECTION);
    expect(counts).toEqual({ readable: 1, sections: 1 });
    expect(out.sections).toHaveLength(1);
  });
});
