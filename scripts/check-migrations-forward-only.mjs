#!/usr/bin/env node
/**
 * check-migrations-forward-only.mjs — migrations are FORWARD-ONLY (expand/contract).
 * ===========================================================================
 *
 * Why: a failed `synap update` rolls back IMAGES ONLY and never the data
 * (founder, 2026-10-20; the one home of that rule is `_ue_rollback` in `synap`).
 * The previous release's code then runs on the newer schema, which is safe only
 * if no migration it did not know about removed or reshaped something it uses.
 *
 * The rule: a migration that has NOT shipped yet may not DROP a table or a
 * column, RENAME anything, change a column's TYPE, or SET NOT NULL — unless it
 * is the CONTRACT step of a change whose EXPAND step already shipped, declared
 * by one comment line naming that earlier migration:
 *
 *     -- synap:contract-of 0331_official_catalog_digests.sql
 *
 * The named file must exist in the release baseline (it shipped), and the
 * release that stopped USING what the contract removes must be that one or
 * earlier — a guard cannot read that from SQL; the reviewer of the marker can.
 *
 * "Not shipped yet" is DERIVED: every *.sql in packages/database/migrations of
 * the checked tree that is absent from the newest release tag's tree (v*,
 * version order). A set difference, not "numbered after the newest": a
 * migration merged late can carry a number below what pods already have
 * (0331 after 0336, 2026-10-20), and it is just as unshipped.
 *
 * The baseline tag: --baseline <ref>, else the newest v* tag on `origin`
 * (git ls-remote; its tree is fetched shallowly when missing), else the newest
 * local v* tag. No baseline = exit 2, never a pass.
 *
 * Exit: 0 clean · 1 violations · 2 cannot check (no git, no baseline, empty sets).
 *
 * What it does NOT see (measured by the fixtures in
 * deploy/__tests__/migration-forward-only.test.sh, or stated):
 *   - DROP VIEW / FUNCTION / TRIGGER / TYPE / INDEX / SCHEMA, DROP DEFAULT,
 *     TRUNCATE, DELETE/UPDATE of rows, new CHECK / UNIQUE / FOREIGN KEY
 *     constraints old code could violate, a function's changed behaviour.
 *   - SQL assembled from fragments (format('%s %s', 'DROP', 'TABLE')).
 *   - Kratos's own migrations and the legacy root migrations/ directory.
 *   - Whether the code of the expand release really stopped using the column.
 *   - A string literal that merely mentions "drop table" IS flagged (strings
 *     are scanned on purpose: EXECUTE 'ALTER TABLE … DROP COLUMN …').
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

export const MIGRATIONS_DIR = "packages/database/migrations";
export const MARKER = /^[ \t]*--[ \t]*synap:contract-of[ \t]+(\S+)[ \t]*$/gm;

/**
 * Blanks SQL comments (-- to end of line, nested block comments) with spaces,
 * keeping every newline, so offsets and line numbers match the input.
 * '…' strings, "…" identifiers and $tag$…$tag$ bodies are kept and scanned.
 */
export function stripSqlComments(sql) {
  const out = sql.split("");
  let i = 0;
  const n = sql.length;
  const blank = (from, to) => {
    for (let k = from; k < to; k++)
      if (out[k] !== "\n" && out[k] !== "\r") out[k] = " ";
  };
  while (i < n) {
    const c = sql[i];
    if (c === "-" && sql[i + 1] === "-") {
      let j = sql.indexOf("\n", i);
      if (j === -1) j = n;
      blank(i, j);
      i = j;
    } else if (c === "/" && sql[i + 1] === "*") {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (sql[j] === "/" && sql[j + 1] === "*") {
          depth++;
          j += 2;
        } else if (sql[j] === "*" && sql[j + 1] === "/") {
          depth--;
          j += 2;
        } else j++;
      }
      blank(i, j);
      i = j;
    } else if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === c && sql[j + 1] === c) {
          j += 2;
          continue;
        }
        if (sql[j] === c) {
          j++;
          break;
        }
        j++;
      }
      i = j;
    } else if (c === "$") {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 64));
      if (!m) {
        i++;
        continue;
      }
      // A dollar-quoted body is code too (DO $$ … $$): keep scanning INSIDE it
      // for comments, so only its delimiters are skipped here.
      i += m[0].length;
    } else i++;
  }
  return out.join("");
}

const KINDS = [
  { kind: "DROP TABLE", re: /\bdrop\s+table\b/gi },
  { kind: "RENAME", re: /\brename\b/gi },
  {
    kind: "column TYPE change",
    re: /\balter\s+(?:column\s+)?(?:"[^"]+"|[a-z_][\w$]*)\s+(?:set\s+data\s+)?type\b/gi,
  },
  { kind: "SET NOT NULL", re: /\bset\s+not\s+null\b/gi },
];
// Inside an ALTER TABLE statement, DROP <name> / DROP COLUMN <name> drops a
// column; DROP CONSTRAINT / NOT NULL / DEFAULT / IDENTITY / EXPRESSION do not.
const ALTER_TABLE = /\balter\s+table\b[^;]*/gi;
const COLUMN_DROP =
  /\bdrop\s+(?!constraint\b|not\s+null\b|default\b|identity\b|expression\b)/gi;

function lineOf(text, index) {
  let line = 1;
  for (let k = 0; k < index; k++) if (text[k] === "\n") line++;
  return line;
}

/** Every destructive statement of one migration: [{ kind, line, text }]. */
export function findDestructive(sql) {
  const code = stripSqlComments(sql);
  const hits = [];
  const add = (kind, index) => {
    const line = lineOf(code, index);
    hits.push({ kind, line, text: sql.split("\n")[line - 1].trim() });
  };
  for (const { kind, re } of KINDS)
    for (const m of code.matchAll(re)) add(kind, m.index);
  for (const st of code.matchAll(ALTER_TABLE))
    for (const m of st[0].matchAll(COLUMN_DROP))
      add("DROP COLUMN", st.index + m.index);
  return hits.sort((a, b) => a.line - b.line);
}

/** The contract-of markers of one migration (file names). */
export function contractMarkers(sql) {
  return [...sql.matchAll(MARKER)].map((m) => m[1]);
}

function git(repo, args) {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

const versionKey = (t) =>
  t
    .replace(/^v/, "")
    .split(/[.-]/)
    .map((p) => (/^\d+$/.test(p) ? Number(p) : p));
/** The v<N>(.<N>)* tags among `tags`, oldest → newest by VERSION (v1.10 > v1.9). */
export function sortReleaseTags(tags) {
  const vs = tags.filter((t) => /^v\d+(\.\d+)*$/.test(t));
  vs.sort((a, b) => {
    const ka = versionKey(a),
      kb = versionKey(b);
    for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
      const d = (ka[i] ?? -1) - (kb[i] ?? -1);
      if (d) return d;
    }
    return 0;
  });
  return vs;
}

/** { tags (oldest → newest), source }: origin's v* tags, else the local ones. */
export function releaseTags(repo) {
  try {
    const remote = sortReleaseTags(
      git(repo, ["ls-remote", "--tags", "--refs", "origin", "v*"])
        .split("\n")
        .map((l) => l.split("\t")[1]?.replace("refs/tags/", ""))
        .filter(Boolean)
    );
    if (remote.length) return { tags: remote, source: "origin" };
  } catch {
    /* offline or no origin: local tags below */
  }
  return {
    tags: sortReleaseTags(
      git(repo, ["tag", "-l", "v*"]).split("\n").filter(Boolean)
    ),
    source: "local tags",
  };
}

/** Makes refs/tags/<tag> readable here (a shallow fetch when this clone lacks it). */
export function ensureTagTree(repo, tag) {
  try {
    git(repo, ["cat-file", "-e", `refs/tags/${tag}^{tree}`]);
  } catch {
    git(repo, [
      "fetch",
      "--quiet",
      "--no-tags",
      "--depth=1",
      "origin",
      `refs/tags/${tag}:refs/tags/${tag}`,
    ]);
  }
  return `refs/tags/${tag}`;
}

/** { ref, source } of the release baseline, or throws. */
export function resolveBaseline(repo, explicit) {
  if (explicit) return { ref: explicit, source: "--baseline" };
  const { tags, source } = releaseTags(repo);
  const tag = tags.at(-1);
  if (!tag) throw new Error("no v* release tag on origin or locally");
  return {
    ref: ensureTagTree(repo, tag),
    source: `${tag} (newest v* tag, ${source})`,
  };
}

export function shippedMigrations(repo, ref) {
  return git(repo, ["ls-tree", "--name-only", `${ref}:${MIGRATIONS_DIR}`])
    .split("\n")
    .filter((f) => f.endsWith(".sql"));
}

/** { baseline, unshipped[], violations[] } for a checkout. */
export function check(repo, explicitBaseline) {
  const baseline = resolveBaseline(repo, explicitBaseline);
  const shipped = new Set(shippedMigrations(repo, baseline.ref));
  if (shipped.size === 0)
    throw new Error(
      `the baseline ${baseline.source} has no migrations in ${MIGRATIONS_DIR}`
    );
  const dir = join(repo, MIGRATIONS_DIR);
  const present = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  if (present.length === 0) throw new Error(`no migrations in ${dir}`);
  const unshipped = present.filter((f) => !shipped.has(f));
  const violations = [];
  for (const f of unshipped) {
    const sql = readFileSync(join(dir, f), "utf8");
    const hits = findDestructive(sql);
    if (hits.length === 0) continue;
    const markers = contractMarkers(sql);
    const bad = markers.filter((m) => !shipped.has(m));
    if (markers.length > 0 && bad.length === 0) continue;
    const why =
      markers.length === 0
        ? "not marked as the contract step of an expand that already shipped"
        : `marked contract-of ${bad.join(", ")}, which is not in the release baseline${bad.some((b) => present.includes(b)) ? " (it has not shipped yet)" : " (no such migration)"}`;
    for (const h of hits) violations.push({ file: f, ...h, why });
  }
  return { baseline, shipped: shipped.size, unshipped, violations };
}

if (process.argv[1]?.endsWith("check-migrations-forward-only.mjs")) {
  const args = process.argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf(name);
    return i === -1 ? undefined : args[i + 1];
  };
  const repo = resolve(opt("--repo") ?? process.cwd());
  let r;
  try {
    if (!existsSync(join(repo, MIGRATIONS_DIR)))
      throw new Error(`no ${MIGRATIONS_DIR} under ${repo}`);
    git(repo, ["rev-parse", "--git-dir"]);
    r = check(repo, opt("--baseline"));
  } catch (e) {
    console.error(
      `cannot check migrations: ${
        String(e.stderr || e.message)
          .trim()
          .split("\n")[0]
      }`
    );
    process.exit(2);
  }
  console.log(
    `baseline: ${r.baseline.source} — ${r.shipped} shipped; ${r.unshipped.length} not shipped yet: ${r.unshipped.join(" ") || "(none)"}`
  );
  for (const v of r.violations)
    console.log(
      `DESTRUCTIVE ${v.file}:${v.line} ${v.kind} — ${v.why}: ${v.text}`
    );
  process.exit(r.violations.length ? 1 : 0);
}
