/**
 * read-patterns.mjs — THE detector for three slow read patterns the pod-latency
 * wave (27 Nov 2026) fixed one by one. Each was proven slow on a live pod:
 *
 * 1. `events-unbounded`: a read of `events` with no time bound. `events` is a
 *    TimescaleDB hypertable (weekly chunks, most compressed); a read with no
 *    constant `timestamp` predicate plans over every chunk (~75-110 ms of
 *    PLANNING per call on a 46-chunk pod). Fix: backend#1347
 *    (`countCloseEvents` in packages/jobs/src/utils/playbook-scorecard.ts).
 * 2. `key-cast-to-text`: a uuid primary key cast to text and compared with a
 *    VALUE (a JSONB `->>` extraction, a parameter, a subquery, a function):
 *    `ar.id::text = m ->> 'automationRunId'`. The cast is on the key, so the
 *    primary-key index cannot be used: every probe is a sequential scan (the
 *    session sweep: 21 s a tick, 32 ms after). Fix: backend#1341, cast the
 *    value instead with `uuidFromTextSql` (packages/database/src/utils/
 *    uuid-from-text.ts). A key compared with another COLUMN
 *    (`l.from_id = s.id::text`) is a join-order choice, not this pattern.
 * 3. `proposal-data-whole`: a list or aggregate read that selects the whole
 *    `proposals.data` JSONB (megabytes for a few thousand rows) when the code
 *    reads one key. Fix: backend#1345 projects
 *    `jsonb_build_object('dispositions', data -> 'dispositions')`.
 *    A single-row read (`.limit(1)`, `findFirst`, `eq(proposals.id, …)`) is
 *    not a list read and is not counted.
 *
 * Static analysis on the TypeScript AST (drizzle builder chains, the
 * relational `db.query.<table>.findMany` API, and SQL text in template and
 * string literals). Regex is used only on SQL TEXT, never to find the code
 * structure. The scanned set is DERIVED: every `.ts`/`.tsx` under
 * `packages/<pkg>/src` and `apps/<app>/src`, minus tests, declarations and
 * build output (`listScannedFiles`).
 *
 * A justified site carries `// read-guard: <reason>` on its line or in the
 * comment block directly above it (the line of `.from(events)`, of the
 * selected `proposals.data`, of a `findMany`, or the line a SQL template
 * starts on). An empty reason, or a marker that justifies no site, is
 * reported so the tripwire can fail on it.
 *
 * DOES NOT SEE (measured limits, see the tripwire's header for the rest):
 * - a query built across files (a `where` from a helper in another module,
 *   a select object exported from elsewhere); same-file `const` initializers
 *   and `<name>.push(…)` arguments ARE followed, one level deep;
 * - events: any comparison on `events.timestamp` in a drizzle chain counts as
 *   a bound, even one against another table's column (a correlated bound does
 *   not exclude chunks at plan time); in SQL text a bound against a bare
 *   `alias.column` or an imported table's column is NOT counted;
 * - key casts: only a column named `id` (the primary key), not foreign keys
 *   (`subject_entity_id::text`); a local alias of a subquery
 *   (`${lastMove.subjectId}`) reads as a value, not a column;
 * - proposals: raw SQL selecting `p.data` (none today; `SELECT * FROM
 *   proposals` IS seen), and whether the caller truly needs the whole value.
 *
 * Self-contained on purpose (node: imports and `typescript` only).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

export const PATTERNS = /** @type {const} */ ([
  "events-unbounded",
  "key-cast-to-text",
  "proposal-data-whole",
]);

export const MARKER = "read-guard:";

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".git",
  "coverage",
  "worktrees",
  "__tests__",
  "__tripwires__",
  "__fixtures__",
  "__mocks__",
  "fixtures",
]);

const isScannedFile = (name) =>
  /\.tsx?$/.test(name) &&
  !name.endsWith(".d.ts") &&
  !/\.(test|spec|stories)\.tsx?$/.test(name);

function walk(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(join(dir, e.name), out);
    } else if (isScannedFile(e.name)) out.push(join(dir, e.name));
  }
  return out;
}

/** Every scanned source file: `packages/<pkg>/src/**` and `apps/<app>/src/**`, absolute, sorted. */
export function listScannedFiles(repoRoot) {
  const out = [];
  for (const top of ["packages", "apps"]) {
    let pkgs;
    try {
      pkgs = readdirSync(join(repoRoot, top), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const p of pkgs)
      if (p.isDirectory()) walk(join(repoRoot, top, p.name, "src"), out);
  }
  return out.sort();
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Local names bound to the drizzle table `table` (named imports, aliases, namespace imports) from a database/schema module. */
function tableBindings(sf, table) {
  const names = new Set();
  const namespaces = new Set();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !st.importClause) continue;
    const spec = st.moduleSpecifier.text;
    if (!/database|schema/.test(spec)) continue;
    const nb = st.importClause.namedBindings;
    if (!nb) continue;
    if (ts.isNamespaceImport(nb)) namespaces.add(nb.name.text);
    else
      for (const el of nb.elements)
        if ((el.propertyName ?? el.name).text === table)
          names.add(el.name.text);
  }
  // The schema module itself declares the table.
  for (const st of sf.statements)
    if (ts.isVariableStatement(st))
      for (const d of st.declarationList.declarations)
        if (
          ts.isIdentifier(d.name) &&
          d.name.text === table &&
          d.initializer &&
          ts.isCallExpression(d.initializer) &&
          /Table$/.test(d.initializer.expression.getText(sf))
        )
          names.add(table);
  const spellings = [...names, ...[...namespaces].map((n) => `${n}.${table}`)];
  const isRef = (node) =>
    (ts.isIdentifier(node) && names.has(node.text)) ||
    (ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      namespaces.has(node.expression.text) &&
      node.name.text === table);
  return { spellings, isRef };
}

/** Every name the file imports (any module): a `${name.col}` placeholder on one of them is a column. */
function importedNames(sf) {
  const out = new Set();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !st.importClause) continue;
    if (st.importClause.name) out.add(st.importClause.name.text);
    const nb = st.importClause.namedBindings;
    if (!nb) continue;
    if (ts.isNamespaceImport(nb)) out.add(nb.name.text);
    else for (const el of nb.elements) out.add(el.name.text);
  }
  return out;
}

/** name → texts that build it in this file: `const name = …` initializers and `name.push(…)` arguments. */
function sameFileBuilders(sf) {
  const out = new Map();
  const add = (k, v) => out.set(k, [...(out.get(k) ?? []), v]);
  const visit = (n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer)
      add(n.name.text, n.initializer.getText(sf));
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === "push" &&
      ts.isIdentifier(n.expression.expression)
    )
      for (const a of n.arguments)
        add(n.expression.expression.text, a.getText(sf));
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** The calls of the method chain `c` sits in (`db.select(…).from(…).where(…)…`), lowest first. */
function chainOf(c) {
  const calls = [];
  let low = c;
  while (
    ts.isCallExpression(low) &&
    ts.isPropertyAccessExpression(low.expression) &&
    ts.isCallExpression(low.expression.expression)
  )
    low = low.expression.expression;
  let cur = low;
  for (;;) {
    calls.push(cur);
    const pa = cur.parent;
    if (
      pa &&
      ts.isPropertyAccessExpression(pa) &&
      pa.expression === cur &&
      pa.parent &&
      ts.isCallExpression(pa.parent) &&
      pa.parent.expression === pa
    )
      cur = pa.parent;
    else break;
  }
  return calls;
}

const methodOf = (call) =>
  ts.isPropertyAccessExpression(call.expression)
    ? call.expression.name.text
    : ts.isIdentifier(call.expression)
      ? call.expression.text
      : "";

/** The argument text of a chain, with same-file builders of every identifier in it appended (one level). */
function chainArgText(sf, calls, builders) {
  const parts = [];
  const seen = new Set();
  for (const call of calls)
    for (const a of call.arguments) {
      parts.push(a.getText(sf));
      const visit = (n) => {
        if (ts.isIdentifier(n) && !seen.has(n.text) && builders.has(n.text)) {
          seen.add(n.text);
          parts.push(...builders.get(n.text));
        }
        ts.forEachChild(n, visit);
      };
      visit(a);
    }
  return parts.join("\n");
}

const SELECT_ROOTS = new Set(["select", "selectDistinct", "selectDistinctOn"]);
const FROM_METHODS = new Set([
  "from",
  "innerJoin",
  "leftJoin",
  "rightJoin",
  "fullJoin",
  "crossJoin",
  "innerJoinLateral",
  "leftJoinLateral",
]);

const isSqlTag = (tag) => /(^|\.)(sql|drizzleSql|raw)$/i.test(tag);

/**
 * The SQL text of a literal: its own text with each `${expr}` kept as the
 * expression's source, except an expression that holds another literal
 * (scanned on its own, so never counted twice).
 */
function literalSqlText(sf, node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    return node.text;
  let s = node.head.text;
  for (const span of node.templateSpans) {
    let nested = false;
    const visit = (n) => {
      if (
        ts.isStringLiteralLike(n) ||
        ts.isTemplateExpression(n) ||
        ts.isNoSubstitutionTemplateLiteral(n)
      )
        nested = true;
      else ts.forEachChild(n, visit);
    };
    visit(span.expression);
    s += "${" + (nested ? "__nested__" : span.expression.getText(sf)) + "}";
    s += span.literal.text;
  }
  return s;
}

/** Whether a literal is SQL: a `sql`/`drizzleSql` tag, a `sql.raw(…)` argument, or text that holds a SELECT. */
function isSqlLiteral(sf, node, text) {
  const p = node.parent;
  if (p && ts.isTaggedTemplateExpression(p) && isSqlTag(p.tag.getText(sf)))
    return true;
  if (p && ts.isCallExpression(p) && isSqlTag(p.expression.getText(sf)))
    return true;
  return /\bselect\b/i.test(text);
}

const SQL_KEYWORDS =
  "WHERE|JOIN|ON|LEFT|RIGHT|INNER|OUTER|FULL|CROSS|GROUP|ORDER|LIMIT|OFFSET|USING|WINDOW|UNION|AND|OR|HAVING|LATERAL|NATURAL|SET|RETURNING|FOR|AS";

/** A column operand: `a.col`, `"t"."col"`, or `${T.col}` on an imported name, not followed by a JSON or call operator. */
function columnOperandAtStart(text, imported) {
  const m = text.match(
    /^\s*\(?\s*(?:(\w+)\."?\w+"?|"\w+"\."\w+"|\$\{\s*(\w+)\.\w+\s*\})/
  );
  if (!m) return false;
  if (m[2] !== undefined && !imported.has(m[2])) return false;
  const after = text.slice(m[0].length);
  return !/^\s*(->|#>|\(|\.)/.test(after);
}

function columnOperandAtEnd(text, imported) {
  const m = text.match(
    /(?:(?<![\w."])(\w+)\."?\w+"?|"\w+"\."\w+"|\$\{\s*(\w+)\.\w+\s*\})\s*\)?\s*$/
  );
  if (!m) return false;
  if (m[2] !== undefined && !imported.has(m[2])) return false;
  const before = text.slice(0, m.index);
  return !/(->>?|#>>?)\s*$/.test(before);
}

const ID_REF = String.raw`(?:(?<![\w."])\w+\."?id"?|"\w+"\."id"|\$\{\s*[\w.]+\.id\s*\})`;
const KEY_CAST_RE = new RegExp(
  String.raw`(?:${ID_REF}\s*::\s*text\b|CAST\s*\(\s*${ID_REF}\s+AS\s+text\s*\))`,
  "gi"
);

/** Key casts in SQL text whose other side is a value, not a column. */
function keyCastSites(text, imported) {
  const out = [];
  for (const m of text.matchAll(KEY_CAST_RE)) {
    const after = text.slice(m.index + m[0].length);
    const before = text.slice(0, m.index);
    const op = after.match(/^\s*(=\s*ANY\s*\(|IN\s*\(|=(?!=)|<>|!=)/i);
    let valueSide;
    if (op) {
      const rest = after.slice(op[0].length);
      valueSide = /^(=\s*ANY|IN)/i.test(op[1].trim())
        ? true
        : !columnOperandAtStart(rest, imported);
    } else if (/(?<![<>!=])=\s*$/.test(before)) {
      valueSide = !columnOperandAtEnd(before.replace(/=\s*$/, ""), imported);
    } else continue;
    if (valueSide) out.push(m.index);
  }
  return out;
}

const EVENTS_FROM_RE = (evPlaceholders) =>
  new RegExp(
    String.raw`(?<!DELETE\s{1,20})\b(?:FROM|JOIN)\s+(?:ONLY\s+)?(?:(?:public\.)?"?events"?|\$\{\s*(?:${evPlaceholders})\s*\})(?![\w."])(?:\s+(?:AS\s+)?(?!(?:${SQL_KEYWORDS})\b)(\w+))?`,
    "gi"
  );

/** Whether SQL text bounds `alias`'s timestamp by a constant (a parameter, now(), a literal). */
function sqlTextBounded(text, alias, evSpellings, imported) {
  const prefix = [
    String.raw`\b${esc(alias)}\.`,
    ...evSpellings.map((s) => String.raw`\$\{\s*${esc(s)}\.`),
    String.raw`(?<![\w."])`,
  ].join("|");
  const fwd = new RegExp(
    String.raw`(?:${prefix})"?timestamp"?\s*\}?\s*(?:>=|>|<=|<|BETWEEN\b)\s*`,
    "gi"
  );
  for (const m of text.matchAll(fwd)) {
    const operand = text.slice(m.index + m[0].length);
    // A correlated bound (another row's column) does not exclude chunks at plan time.
    if (columnOperandAtStart(operand, imported)) continue;
    return true;
  }
  const rev = new RegExp(
    String.raw`(?:>=|>|<=|<)\s*(?:${prefix})"?timestamp"?\b`,
    "i"
  );
  return rev.test(text);
}

/** Every pattern site in one file, with each marker's fate. */
export function findReadPatternSites(fileName, text) {
  const sf = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const lines = text.split("\n");
  const lineOf = (pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;
  const ev = tableBindings(sf, "events");
  const pr = tableBindings(sf, "proposals");
  const imported = importedNames(sf);
  let builders;
  const getBuilders = () => (builders ??= sameFileBuilders(sf));

  /** @type {{pattern: string, line: number, what: string}[]} */
  const raw = [];
  const add = (pattern, line, what) => raw.push({ pattern, line, what });

  const evSpell = ev.spellings.map(esc).join("|");
  const drizzleEvBound = (argText) => {
    if (evSpell) {
      const a = new RegExp(
        String.raw`\b(?:gte|gt|lte|lt|between)\(\s*(?:${evSpell})\.timestamp\b`
      );
      const b = new RegExp(
        String.raw`\$\{\s*(?:${evSpell})\.timestamp\s*\}\s*(?:>=|>|<=|<|BETWEEN\b)`,
        "i"
      );
      const c = new RegExp(
        String.raw`(?:>=|>|<=|<)\s*\$\{\s*(?:${evSpell})\.timestamp\s*\}`
      );
      if (a.test(argText) || b.test(argText) || c.test(argText)) return true;
    }
    return /(?<![\w."])"?timestamp"?\s*(?:>=|>|<=|<|BETWEEN\b)\s*(?:\$\{|\$\d|now\(|'|current_)/i.test(
      argText
    );
  };

  const prSpell = pr.spellings.map(esc).join("|");
  const singleRow = (calls, argText) =>
    calls.some(
      (c) =>
        methodOf(c) === "limit" &&
        c.arguments.length === 1 &&
        c.arguments[0].getText(sf).trim() === "1"
    ) ||
    (prSpell !== "" &&
      new RegExp(String.raw`\beq\(\s*(?:${prSpell})\.id\s*,`).test(argText));

  const visit = (n) => {
    // ── drizzle builder chains ────────────────────────────────────────────
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      FROM_METHODS.has(n.expression.name.text) &&
      n.arguments.length >= 1
    ) {
      const target = n.arguments[0];
      const line = lineOf(n.expression.name.getStart(sf));
      if (ev.isRef(target)) {
        const calls = chainOf(n);
        if (SELECT_ROOTS.has(methodOf(calls[0]))) {
          const argText = chainArgText(sf, calls, getBuilders());
          if (!drizzleEvBound(argText))
            add("events-unbounded", line, `.${n.expression.name.text}(events)`);
        }
      }
      if (pr.isRef(target)) {
        const calls = chainOf(n);
        const root = calls[0];
        if (SELECT_ROOTS.has(methodOf(root))) {
          const argText = chainArgText(sf, calls, getBuilders());
          if (!singleRow(calls, argText)) {
            const sel =
              methodOf(root) === "selectDistinctOn"
                ? root.arguments[1]
                : root.arguments[0];
            if (!sel)
              add("proposal-data-whole", line, ".select() from proposals");
            else {
              let obj = sel;
              if (ts.isIdentifier(sel)) {
                const decl = findConstObject(sf, sel.text);
                if (decl) obj = decl;
              }
              if (ts.isObjectLiteralExpression(obj))
                for (const prop of obj.properties) {
                  if (
                    ts.isPropertyAssignment(prop) &&
                    pr.isRefData(prop.initializer)
                  )
                    add(
                      "proposal-data-whole",
                      lineOf(prop.getStart(sf)),
                      `${prop.name.getText(sf)}: ${prop.initializer.getText(sf)}`
                    );
                  if (
                    ts.isSpreadAssignment(prop) &&
                    ts.isCallExpression(prop.expression) &&
                    prop.expression.expression.getText(sf) ===
                      "getTableColumns" &&
                    prop.expression.arguments[0] &&
                    pr.isRef(prop.expression.arguments[0])
                  )
                    add(
                      "proposal-data-whole",
                      lineOf(prop.getStart(sf)),
                      "...getTableColumns(proposals)"
                    );
                }
            }
          }
        }
      }
    }
    // ── relational API: <db>.query.<table>.findMany(…) ────────────────────
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      ts.isPropertyAccessExpression(n.expression.expression) &&
      ts.isPropertyAccessExpression(n.expression.expression.expression) &&
      n.expression.expression.expression.name.text === "query"
    ) {
      const method = n.expression.name.text;
      const table = n.expression.expression.name.text;
      const line = lineOf(n.expression.name.getStart(sf));
      const arg = n.arguments[0];
      const argText = arg ? arg.getText(sf) : "";
      if (
        table === "events" &&
        (method === "findMany" || method === "findFirst") &&
        !/\b(?:gte|gt|lte|lt|between)\(\s*[\w.]*\btimestamp\b/.test(argText) &&
        !drizzleEvBound(argText)
      )
        add("events-unbounded", line, `query.events.${method}`);
      if (table === "proposals" && method === "findMany") {
        const cols =
          arg && ts.isObjectLiteralExpression(arg)
            ? arg.properties.find(
                (p) =>
                  ts.isPropertyAssignment(p) && p.name.getText(sf) === "columns"
              )
            : undefined;
        let whole = true;
        if (cols && ts.isObjectLiteralExpression(cols.initializer)) {
          const entries = cols.initializer.properties
            .filter(ts.isPropertyAssignment)
            .map((p) => [p.name.getText(sf), p.initializer.getText(sf)]);
          const data = entries.find(([k]) => k === "data");
          const inclusive = entries.some(([, v]) => v === "true");
          whole = data ? data[1] === "true" : !inclusive;
        }
        if (whole) add("proposal-data-whole", line, "query.proposals.findMany");
      }
    }
    // ── SQL text in literals ──────────────────────────────────────────────
    if (
      ts.isTemplateExpression(n) ||
      ts.isNoSubstitutionTemplateLiteral(n) ||
      ts.isStringLiteral(n)
    ) {
      const sqlText = literalSqlText(sf, n);
      if (sqlText.length > 8 && isSqlLiteral(sf, n, sqlText)) {
        const line = lineOf(n.getStart(sf));
        const placeholders = ev.spellings.length
          ? ev.spellings.map(esc).join("|")
          : "events";
        for (const m of sqlText.matchAll(EVENTS_FROM_RE(placeholders))) {
          const alias = m[1] ?? "events";
          if (!sqlTextBounded(sqlText, alias, ev.spellings, imported))
            add("events-unbounded", line, m[0].replace(/\s+/g, " ").trim());
        }
        for (const _ of keyCastSites(sqlText, imported))
          add("key-cast-to-text", line, "pk::text compared with a value");
        if (/\bSELECT\s+\*\s+FROM\s+"?proposals"?(?![\w."])/i.test(sqlText))
          add("proposal-data-whole", line, "SELECT * FROM proposals");
        // `eq(sql`${t.id}::text`, value)`: the template is the whole operand.
        const p = n.parent;
        if (
          new RegExp(String.raw`^\s*${ID_REF}\s*::\s*text\s*$`, "i").test(
            sqlText
          ) &&
          p &&
          ts.isTaggedTemplateExpression(p) &&
          p.parent &&
          ts.isCallExpression(p.parent) &&
          ["eq", "ne", "inArray"].includes(methodOf(p.parent))
        ) {
          const other = p.parent.arguments.find((a) => a !== p);
          const isColumn =
            other &&
            ts.isPropertyAccessExpression(other) &&
            ts.isIdentifier(other.expression) &&
            imported.has(other.expression.text);
          if (!isColumn || methodOf(p.parent) === "inArray")
            add("key-cast-to-text", line, "eq(pk::text, value)");
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  pr.isRefData = (node) =>
    ts.isPropertyAccessExpression(node) &&
    node.name.text === "data" &&
    pr.isRef(node.expression);
  visit(sf);

  // ── markers ─────────────────────────────────────────────────────────────
  const markerRe = new RegExp(String.raw`//\s*${esc(MARKER)}(.*)$`);
  const markerAt = (lineNo) => {
    const m = (lines[lineNo - 1] ?? "").match(markerRe);
    return m ? { line: lineNo, reason: m[1].trim() } : null;
  };
  const used = new Set();
  const sites = raw.map((s) => {
    let found = markerAt(s.line);
    for (let l = s.line - 1; !found && l >= 1; l--) {
      const t = (lines[l - 1] ?? "").trim();
      if (!/^(\/\/|\/\*|\*)/.test(t)) break;
      found = markerAt(l);
    }
    if (found) used.add(found.line);
    return {
      ...s,
      justified: Boolean(found && found.reason),
      reason: found?.reason ?? null,
    };
  });
  const emptyMarkers = [];
  const unusedMarkers = [];
  lines.forEach((l, i) => {
    const m = l.match(markerRe);
    if (!m) return;
    if (!m[1].trim()) emptyMarkers.push(i + 1);
    else if (!used.has(i + 1)) unusedMarkers.push(i + 1);
  });
  return { sites, emptyMarkers, unusedMarkers };
}

/** `const name = { … }` (optionally `as const`) in this file, the object literal. */
function findConstObject(sf, name) {
  let found;
  const visit = (n) => {
    if (found) return;
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.name.text === name &&
      n.initializer
    ) {
      let init = n.initializer;
      while (ts.isAsExpression(init) || ts.isSatisfiesExpression(init))
        init = init.expression;
      if (ts.isObjectLiteralExpression(init)) found = init;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

/**
 * A cheap text pre-check, so the AST is built only for files that could hold
 * a site: every trigger the detector reads (SQL text naming the tables, a
 * `::text` / `AS text` cast, a database or schema import beside the table
 * names, a marker). The tripwire asserts it admits every fixture site.
 */
export function mayHoldSite(text) {
  return (
    text.includes(MARKER) ||
    /::\s*text\b|\bAS\s+text\b/i.test(text) ||
    /\b(?:FROM|JOIN)\s+(?:ONLY\s+)?(?:public\.)?"?(?:events|proposals)"?(?![\w."])/i.test(
      text
    ) ||
    (/\b(?:events|proposals)\b/.test(text) &&
      (/["'][^"'\n]*(?:database|schema)[^"'\n]*["']/.test(text) ||
        /\bpgTable\(/.test(text)))
  );
}

/** Unjustified sites per pattern per file key, every justified site, and every bad marker, over `files`. */
export function scanReadPatterns(files, keyOf) {
  /** @type {Record<string, Record<string, number>>} */
  const counts = Object.fromEntries(PATTERNS.map((p) => [p, {}]));
  const justified = [];
  const emptyMarkers = [];
  const unusedMarkers = [];
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    if (!mayHoldSite(text)) continue;
    const k = keyOf(f);
    const r = findReadPatternSites(f, text);
    for (const s of r.sites) {
      if (s.justified)
        justified.push(`${k}:${s.line} [${s.pattern}] ${s.reason}`);
      else counts[s.pattern][k] = (counts[s.pattern][k] ?? 0) + 1;
    }
    for (const l of r.emptyMarkers) emptyMarkers.push(`${k}:${l}`);
    for (const l of r.unusedMarkers) unusedMarkers.push(`${k}:${l}`);
  }
  return { counts, justified, emptyMarkers, unusedMarkers };
}
