/**
 * import-graph.mjs — which test files a change can break, from the files
 * each module imports and the paths each file reads (founder, 2026-10-29,
 * lane L8: "a backend PR's 4 required checks green in 8-10 minutes").
 *
 * ── WHY A STATIC GRAPH, NOT `vitest related` ────────────────────────────────
 * `vitest related <files>` asks vite to transform every test file of a
 * package and walk its module graph: it needs `pnpm install` and the built
 * `dist` of every workspace package (our packages import each other through
 * package.json `exports`, which point at dist), so it could only run after the
 * ~2.4 min setup of a shard, once per package, and its answer would depend on
 * which dist happened to be built. The decision has to be made in the
 * "What changed" job, before any install, from the checkout alone. So this
 * reads the source: a few seconds over ~6,000 files, node: built-ins only.
 *
 * ── THE EDGES ────────────────────────────────────────────────────────────────
 * IMPORT edges (transitive), from every code file:
 *   - `import … from "x"`, `import "x"`, `export … from "x"`, `import("x")`,
 *     `require("x")`, and `vi.mock|doMock|unmock|importActual|importMock("x")`
 *     (a mocked module is still an edge: a mock factory reads the real one's
 *     shape through importOriginal, and over-selecting costs seconds);
 *   - NOT `import type …` / `export type … from …`: esbuild erases them, the
 *     test never loads that module (types are the Release gate's typecheck);
 *   - a relative specifier resolves like TypeScript's bundler resolution
 *     (`./x.js` is `./x.ts`, `./dir` is `./dir/index.ts`);
 *   - a workspace package (`@synap/database/agent-governance`) resolves through
 *     its package.json `exports` to the dist file, mapped back to the source it
 *     is built from (`dist/utils/x.js` ← `src/utils/x.ts`, or the tsup entry
 *     that names it). A specifier that maps to no source file depends on the
 *     WHOLE package's source (never on nothing), and every package import also
 *     depends on that package.json (its exports decide the resolution);
 *   - every test file depends on its package's package.json and vitest config,
 *     and the config on the setup files it names.
 * READ edges (one hop: the reader is hit when the file it reads changed, and
 * whatever imports the reader is then hit through the import edges):
 *   - a string literal that resolves to an existing file or directory:
 *     relative to the file (`"../../../database/migrations/0319_x.sql"`), to
 *     the repo root (`"packages/database/migrations"`, `"skills/synap/"`), or a
 *     root file by name (`"CLAUDE.md"`);
 *   - `join`/`resolve(__dirname | import.meta.dirname | dirname(fileURLToPath(
 *     import.meta.url)) | process.cwd() | <a const built the same way>, "lit",
 *     …)` and `new URL("lit", import.meta.url)`, evaluated;
 *   - a bare top-level directory name (`"skills"`, `"deploy"`, `"kratos"`,
 *     `"templates"`, `"docker"`, `"smoke"`, `"migrations"`), which is how a
 *     path built from pieces names its root (`join(ROOT, "skills", slug)`).
 *   A directory that contains the reading file itself (the repo root, its
 *   package, its own folder) is an anchor, not a read, and is no edge.
 * A path to a file that does not exist (a file this change deleted) is kept as
 * a MISSING edge, so the importers of a deleted module are still hit.
 *
 * ── WHAT IT CANNOT SEE (measured in the PR's replay, not implied) ───────────
 *   - a path computed at run time from values that are not literals or one of
 *     the anchors above (`join(root, kindDir(k))`) in a test that is not a
 *     tripwire;
 *   - `import(variable)`: 2 test files on 2026-10-29, both also name their
 *     target with a literal;
 *   - a module reached only through the database: a migration (.sql) that
 *     changes a table a test uses through Drizzle, without the schema file
 *     changing. The shards migrate the test database before any test, so a
 *     migration that does not apply is red in every shard; one that applies
 *     and changes behaviour is caught by main's full suite.
 * Every tripwire runs on every PR (affected.mjs), whatever this graph says.
 *
 * Self-contained (node: built-ins only): "What changed" runs it before install.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, posix } from "node:path";
import { stripComments } from "../strip-comments.mjs";

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".git",
  "coverage",
  "worktrees",
]);

export const CODE_FILE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const DECLARATION = /\.d\.(ts|mts|cts)$/;
export const TEST_FILE = /\.test\.(ts|tsx|mts|cts|mjs|cjs|js)$/;
const VITEST_CONFIG = /(^|\/)vitest(\.[\w-]+)?\.config\.(ts|mts|js|mjs)$/;
const RESOLVE_EXTS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
];
/** Top-level directories a path built from pieces names by their bare name. */
export const BARE_ROOT_DIRS = [
  "skills",
  "deploy",
  "kratos",
  "templates",
  "docker",
  "smoke",
  "migrations",
];

/** Every file under `root` (repo-relative, posix), skipping build output. */
export function listFiles(root) {
  const out = [];
  const walk = (rel) => {
    let entries;
    try {
      entries = readdirSync(join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(r);
      } else if (e.isFile()) out.push(r);
    }
  };
  walk("");
  return out.sort();
}

/**
 * Test code: a test file, or a helper only tests load (`__tests__/`,
 * `test-utils/`, `testing/`, `fixtures/`, `*.test-helpers.ts`).
 */
export const isTestCode = (f) =>
  TEST_FILE.test(f) ||
  /(^|\/)(__tests__|__tripwires__|test-utils|testing|fixtures|__fixtures__)\//.test(
    f
  ) ||
  /test-helpers?\.[mc]?[jt]sx?$/.test(f);

/** "a/b/c.ts" → ["a", "a/b"] (the directories that hold it). */
function ancestors(path) {
  const parts = path.split("/");
  const out = [];
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join("/"));
  return out;
}

const norm = (p) => {
  const n = posix.normalize(p);
  return n === "." ? "" : n.replace(/\/$/, "");
};

// ── extraction (exported for the tripwire's self-checks) ────────────────────
const STATEMENT =
  /(?:^|[^.\w$])(import|export)\s+(type\s+)?(?:[^'"`;]*?\sfrom\s*)?(['"])([^'"\n]+)\3/g;
const CALL =
  /(?:\bimport|\brequire|\bvi\.(?:mock|doMock|unmock|importActual|importMock))\(\s*(['"`])([^'"`\n$]+)\1/g;
const LITERAL = /(['"`])((?:(?!\1)[^\\\n$]|\\.){1,300})\1/g;

/**
 * The specifiers a code file loads at run time: [{ spec, typeOnly }].
 * `import type` / `export type … from` are typeOnly (erased by esbuild).
 */
export function extractSpecifiers(text) {
  const out = [];
  for (const m of text.matchAll(STATEMENT))
    out.push({ spec: m[4], typeOnly: !!m[2] });
  for (const m of text.matchAll(CALL))
    out.push({ spec: m[2], typeOnly: false });
  return out;
}

/** Every plain string literal of a file (no `${}`), unescaped enough for paths. */
export function extractLiterals(text) {
  const out = [];
  for (const m of text.matchAll(LITERAL)) out.push(m[2]);
  return out;
}

const DIR_ANCHOR =
  /dirname\(\s*fileURLToPath\(\s*import\.meta\.url\s*\)\s*\)|fileURLToPath\(\s*new URL\(\s*(['"])\.\/?\1\s*,\s*import\.meta\.url\s*\)\s*\)|import\.meta\.dirname|__dirname/g;
const JOIN_CALL = /(?:\bpath\.|\bposix\.)?\b(join|resolve)\(([^()]*)\)/g;
const URL_CALL = /new URL\(\s*(['"])([^'"\n]+)\1\s*,\s*import\.meta\.url\s*\)/g;
const CONST_DEF = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+)/g;

/**
 * Paths a file builds with join/resolve/new URL from anchors and literals,
 * evaluated. `fileDir` is the file's directory, `cwd` the directory its tests
 * run in (its package). Returns repo-relative paths ("" = the repo root;
 * a path that leaves the repo is dropped).
 */
export function evaluatePaths(text, fileDir, cwd) {
  const DIR = "\u0000DIR\u0000";
  const CWD = "\u0000CWD\u0000";
  let t = text.replace(DIR_ANCHOR, DIR).replace(/process\.cwd\(\)/g, CWD);
  const out = [];
  for (const m of t.matchAll(URL_CALL)) out.push(norm(join(fileDir, m[2])));
  const consts = new Map();
  const evalArgs = (fn, argText) => {
    const args = argText.split(",").map((a) => a.trim());
    if (args.length === 0 || args[0] === "") return null;
    let acc = null;
    for (const a of args) {
      let piece;
      const lit = /^(['"`])([^'"`$]*)\1$/.exec(a);
      if (lit) piece = { rel: lit[2] };
      else if (a === DIR) piece = { abs: fileDir };
      else if (a === CWD) piece = { abs: cwd };
      else if (consts.has(a)) piece = { abs: consts.get(a) };
      else return null;
      if (piece.abs !== undefined) acc = piece.abs;
      else if (acc === null) {
        if (fn === "resolve") acc = norm(join(cwd, piece.rel));
        else return null; // join("a", "b"): a relative path, read elsewhere
      } else acc = norm(join(acc, piece.rel));
    }
    return acc;
  };
  // Constants first (two passes: a const may be built from an earlier one).
  for (let pass = 0; pass < 2; pass++)
    for (const m of t.matchAll(CONST_DEF)) {
      const rhs = m[2].trim().replace(/[),\s]+$/, (s) => s.replace(/\s/g, ""));
      if (rhs === DIR) consts.set(m[1], fileDir);
      else if (rhs === CWD) consts.set(m[1], cwd);
      else {
        const j = /^(?:path\.|posix\.)?(join|resolve)\(([^()]*)\)$/.exec(rhs);
        if (j) {
          const v = evalArgs(j[1], j[2]);
          if (v !== null) consts.set(m[1], v);
        }
      }
    }
  for (const m of t.matchAll(JOIN_CALL)) {
    const v = evalArgs(m[1], m[2]);
    if (v !== null) out.push(v);
  }
  // A const that is only an anchor (`const HERE = dirname(fileURLToPath(…))`)
  // is a path the file built too: `readdirSync(HERE)` walks it.
  for (const v of consts.values()) out.push(v);
  return [...new Set(out)].filter((p) => !p.startsWith(".."));
}

// ── workspace packages ───────────────────────────────────────────────────────
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** The runtime target of an `exports` condition object ("import" first). */
function conditionTarget(v) {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return conditionTarget(v[0]);
  if (v && typeof v === "object")
    for (const k of ["import", "node", "default", "require", "types"])
      if (k in v) {
        const t = conditionTarget(v[k]);
        if (t) return t;
      }
  return null;
}

/** The `exports` target of a subpath ("." or "./x"), with `*` patterns. */
export function exportsTarget(exp, sub) {
  if (exp == null) return null;
  if (typeof exp === "string" || Array.isArray(exp))
    return sub === "." ? conditionTarget(exp) : null;
  const keys = Object.keys(exp);
  if (!keys.some((k) => k.startsWith(".")))
    return sub === "." ? conditionTarget(exp) : null;
  if (sub in exp) return conditionTarget(exp[sub]);
  // The most specific pattern wins (Node: the longest prefix before `*`).
  const patterns = keys
    .filter((k) => k.includes("*"))
    .sort((a, b) => b.indexOf("*") - a.indexOf("*") || b.length - a.length);
  for (const k of patterns) {
    const [pre, post] = k.split("*");
    if (
      sub.startsWith(pre) &&
      sub.endsWith(post) &&
      sub.length >= k.length - 1
    ) {
      const star = sub.slice(pre.length, sub.length - post.length);
      const t = conditionTarget(exp[k]);
      return t ? t.replaceAll("*", star) : null;
    }
  }
  return null;
}

function tsupEntries(root, dir, fileSet) {
  const map = new Map();
  for (const f of ["tsup.config.ts", "tsup.config.mjs", "tsup.config.js"]) {
    if (!fileSet.has(`${dir}/${f}`)) continue;
    const text = readFileSync(join(root, dir, f), "utf8");
    for (const m of text.matchAll(
      /["']?([\w./-]+)["']?\s*:\s*["'](src\/[^"']+)["']/g
    ))
      map.set(m[1], `${dir}/${m[2]}`);
  }
  return map;
}

/**
 * The workspace packages of a checkout: [{ dir, name, pkg (package.json) }]
 * from pnpm-workspace.yaml's globs.
 */
export function workspaceIndex(root, fileSet) {
  const yaml = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
  const globs = [...yaml.matchAll(/^\s+-\s+"?([^"\n]+?)\/\*"?\s*$/gm)].map(
    (m) => m[1]
  );
  if (globs.length === 0)
    throw new Error("no package globs in pnpm-workspace.yaml");
  const out = [];
  for (const g of globs) {
    if (!existsSync(join(root, g))) continue;
    for (const d of readdirSync(join(root, g), { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const dir = `${g}/${d.name}`;
      const pkg = readJson(join(root, dir, "package.json"));
      if (pkg?.name)
        out.push({
          dir,
          name: pkg.name,
          pkg,
          tsup: tsupEntries(root, dir, fileSet),
        });
    }
  }
  return out.sort((a, b) => b.name.length - a.name.length);
}

// ── the graph ────────────────────────────────────────────────────────────────
/**
 * Build the graph of a checkout. Returns:
 *   files     every file (repo-relative)
 *   imports   Map file → Set of files it imports (resolved)
 *   reads     Map file → Set of files it reads by path
 *   readDirs  Map file → Set of directories it reads by path
 *   missing   Map file → Set of import paths that do not exist (no extension)
 *   missingReads  Map file → Set of paths it reads that do not exist (a file
 *             a change deleted or renamed is still read by it)
 *   wholePkg  Map file → Set of package dirs it depends on whole
 *   packages  the workspace index
 */
export function buildGraph(root, { files = listFiles(root) } = {}) {
  const fileSet = new Set(files);
  const dirSet = new Set();
  for (const f of files) for (const a of ancestors(f)) dirSet.add(a);
  const packages = workspaceIndex(root, fileSet);
  const pkgDirs = packages
    .map((p) => p.dir)
    .sort((a, b) => b.length - a.length);
  const packageOf = (f) => pkgDirs.find((d) => f.startsWith(`${d}/`)) ?? null;
  const rootFiles = new Set(files.filter((f) => !f.includes("/")));
  // `apps`, `packages` and each package's root: an anchor, never a read (a
  // glob like "packages/*/package.json" or a path prefix names them).
  const anchorDirs = new Set(["apps", "packages", ...pkgDirs]);
  for (const d of pkgDirs)
    for (const a of ancestors(`${d}/x`)) anchorDirs.add(a);
  // What a package is built and compiled from: its package.json (exports),
  // its tsconfig files and its build configs. Every importer of the package
  // and every test of the package depends on them (a database tsconfig decides
  // the dist every api test loads).
  const BUILD_CONFIG =
    /^(package\.json|tsconfig[^/]*\.json|tsup[^/]*\.config\.[mc]?[jt]s|vite[^/]*\.config\.[mc]?[jt]s|build\.[mc]?js)$/;
  const configsOf = new Map(pkgDirs.map((d) => [d, []]));
  for (const f of files) {
    const d = packageOf(f);
    if (d && BUILD_CONFIG.test(f.slice(d.length + 1))) configsOf.get(d).push(f);
  }

  const resolveFile = (raw) => {
    // A relative path into another package's build output reads its source.
    const dist = /^((?:apps|packages)\/[^/]+)\/dist\/(.+)$/.exec(raw);
    const base = dist ? `${dist[1]}/src/${dist[2]}` : raw;
    if (fileSet.has(base) && !DECLARATION.test(base)) return base;
    const stem = base.replace(/\.(js|jsx|mjs|cjs)$/, "");
    for (const s of stem === base ? [base] : [stem, base])
      for (const e of RESOLVE_EXTS)
        if (fileSet.has(`${s}${e}`)) return `${s}${e}`;
    for (const e of RESOLVE_EXTS)
      if (fileSet.has(`${base}/index${e}`)) return `${base}/index${e}`;
    return null;
  };
  // dist/x.js → src/x.ts (or the tsup entry built into dist/x.js).
  const sourceOf = (p, target) => {
    const t = norm(target.replace(/^\.\//, ""));
    const direct = resolveFile(`${p.dir}/${t}`);
    if (direct && !direct.includes("/dist/")) return direct;
    const m = /^dist\/(.+?)(\.d)?\.(js|mjs|cjs|ts|mts|cts)$/.exec(t);
    if (!m) return null;
    return p.tsup.get(m[1]) ?? resolveFile(`${p.dir}/src/${m[1]}`);
  };
  const resolvePackage = (spec) => {
    const p = packages.find(
      (q) => spec === q.name || spec.startsWith(`${q.name}/`)
    );
    if (!p) return null;
    const sub = spec === p.name ? "." : `.${spec.slice(p.name.length)}`;
    let target = exportsTarget(p.pkg.exports, sub);
    if (!target && sub === ".")
      target = p.pkg.module ?? p.pkg.main ?? "src/index.ts";
    if (!target && !p.pkg.exports) target = sub.slice(2); // a deep import
    const src = target ? sourceOf(p, target) : null;
    return { pkg: p, src };
  };

  const imports = new Map();
  const reads = new Map();
  const readDirs = new Map();
  const missing = new Map();
  const missingReads = new Map();
  const wholePkg = new Map();
  const add = (m, k, v) => {
    if (!m.has(k)) m.set(k, new Set());
    m.get(k).add(v);
  };

  for (const f of files) {
    if (!CODE_FILE.test(f) || DECLARATION.test(f)) continue;
    let text;
    try {
      // Comments name paths in prose (`../vocabulary`): never an edge.
      text = stripComments(readFileSync(join(root, f), "utf8"), "ts");
    } catch {
      continue;
    }
    const dir = posix.dirname(f) === "." ? "" : posix.dirname(f);
    const pkgDir = packageOf(f);
    const cwd = pkgDir ?? "";
    const own = new Set(["", dir, ...ancestors(f)]);
    const isConfig = VITEST_CONFIG.test(f);

    const specs = extractSpecifiers(text);
    const specSet = new Set(specs.map((x) => x.spec));
    for (const { spec, typeOnly } of specs) {
      if (typeOnly) continue;
      if (spec.startsWith(".")) {
        const base = norm(join(dir, spec));
        if (base.startsWith("..")) continue;
        const r = resolveFile(base);
        if (r) add(imports, f, r);
        else if (!dirSet.has(base))
          add(missing, f, base.replace(/\.(js|jsx|mjs|cjs|ts|tsx)$/, ""));
        continue;
      }
      const r = resolvePackage(spec);
      if (!r) continue; // a third-party package
      for (const c of configsOf.get(r.pkg.dir) ?? []) add(imports, f, c);
      if (r.src) add(imports, f, r.src);
      else add(wholePkg, f, r.pkg.dir);
    }

    // Paths read by name. Production code names paths in messages and docs
    // ("see deploy/docker-compose.yml", a `skills` route segment), and its
    // reads reach every importer: only its evaluated paths and its explicit
    // relative literals count. Test code (a test file, a test helper) reads
    // one hop, so every literal heuristic applies to it.
    const evaluated = evaluatePaths(text, dir, cwd);
    const evaluatedSet = new Set(evaluated);
    const targets = new Set(evaluated);
    const testCode = isTestCode(f);
    // A test that walks a directory (readdir, glob, a walk helper) reads the
    // directories it built, its own package's included: a test scanning
    // packages/api/src is hit by any change there.
    const walks =
      testCode &&
      /\b(readdirSync|readdir|opendirSync|opendir|globSync|glob|walk\w*)\s*\(/.test(
        text
      );
    // A test reads `readSrc("routers/proposals.ts")` relative to a directory
    // it built (`join(process.cwd(), "src")`): a path literal is also tried
    // under each directory the file evaluates, and under its package's src/.
    const bases = testCode
      ? [
          ...new Set([
            ...evaluated.filter((p) => dirSet.has(p)),
            ...(pkgDir ? [pkgDir, `${pkgDir}/src`] : []),
          ]),
        ]
      : [];
    for (const lit of extractLiterals(text)) {
      if (lit.length < 2 || /\s/.test(lit) || lit.includes("://")) continue;
      // An import specifier is an import edge (or a type-only one), not a read.
      if (specSet.has(lit)) continue;
      if (lit.startsWith("./") || lit.startsWith("../")) {
        targets.add(norm(join(dir, lit)));
        if (pkgDir && !isConfig && testCode)
          targets.add(norm(join(pkgDir, lit)));
        continue;
      }
      if (!testCode) continue;
      const clean = lit.replace(/^\/+|\/+$/g, "");
      if (BARE_ROOT_DIRS.includes(clean)) targets.add(clean);
      else if (
        clean.includes("/") &&
        /^[\w.@[\]()-]+(\/[\w.@[\]()*-]+)+$/.test(clean)
      ) {
        // Repo-relative, or relative to the package (a cwd-relative read). A
        // glob (`skills/**/SKILL.md`) reads the directory before its first `*`.
        const head = clean.includes("*")
          ? clean.split("*")[0].replace(/\/[^/]*$/, "")
          : clean;
        targets.add(norm(head));
        for (const b of bases) targets.add(norm(`${b}/${head}`));
      } else if (rootFiles.has(clean)) targets.add(clean);
      else if (/^[\w.@[\]()-]+\.[a-z]{2,4}$/.test(clean))
        // a bare file name under a directory the test built
        for (const b of bases.filter((x) => x !== pkgDir))
          targets.add(norm(`${b}/${clean}`));
    }
    for (const t of targets) {
      if (t.startsWith("..")) continue;
      if (t === "" || own.has(t) || anchorDirs.has(t)) {
        if (walks && evaluatedSet.has(t)) add(readDirs, f, t);
        continue;
      }
      if (fileSet.has(t)) {
        if (t === f) continue;
        // A vitest config's setup files are loaded by every test it runs.
        if (isConfig && CODE_FILE.test(t)) add(imports, f, t);
        else add(reads, f, t);
      } else if (dirSet.has(t)) add(readDirs, f, t);
      else if (isConfig) {
        const r = resolveFile(t);
        if (r) add(imports, f, r);
      } else if (testCode || evaluatedSet.has(t)) add(missingReads, f, t);
    }

    // A test runs under its package's build configs and vitest config.
    if (TEST_FILE.test(f) && pkgDir) {
      for (const c of configsOf.get(pkgDir) ?? []) add(imports, f, c);
      for (const c of files.filter(
        (x) =>
          x.startsWith(`${pkgDir}/`) &&
          VITEST_CONFIG.test(x) &&
          !x.slice(pkgDir.length + 1).includes("/")
      ))
        add(imports, f, c);
    }
  }
  return {
    files,
    fileSet,
    imports,
    reads,
    readDirs,
    missing,
    missingReads,
    wholePkg,
    packages,
    packageOf,
  };
}

/**
 * The files a change reaches, and the test files among them.
 * `changed`: repo-relative paths (deleted ones included). Returns
 *   { hit: Set of files, tests: sorted test files, via: Map test → first
 *   changed file that reached it (for the summary) }.
 */
export function reach(changed, g) {
  const changedSet = new Set(changed);
  const reverse = new Map();
  for (const [f, deps] of g.imports)
    for (const d of deps) {
      if (!reverse.has(d)) reverse.set(d, new Set());
      reverse.get(d).add(f);
    }
  const via = new Map();
  const queue = [];
  const hit = new Set();
  const mark = (f, from) => {
    if (hit.has(f)) return;
    hit.add(f);
    via.set(f, from);
    queue.push(f);
  };
  for (const c of changed) if (g.fileSet.has(c)) mark(c, c);
  // Readers of a changed file or of a directory holding one.
  for (const [f, ts] of g.reads)
    for (const t of ts) if (changedSet.has(t)) mark(f, t);
  for (const [f, ds] of g.readDirs)
    for (const d of ds) {
      // "" = the repo root, walked by a test: every change reaches it.
      const c = changed.find((x) => d === "" || x.startsWith(`${d}/`));
      if (c) mark(f, c);
    }
  // Importers of a deleted file (a specifier that no longer resolves).
  const gone = changed
    .filter((c) => !g.fileSet.has(c))
    .map((c) => c.replace(/\.(js|jsx|mjs|cjs|ts|tsx|mts|cts)$/, ""));
  if (gone.length)
    for (const [f, ms] of g.missing)
      for (const m of ms) {
        const c = gone.find((x) => x === m || x === `${m}/index`);
        if (c) mark(f, c);
      }
  // Readers of a deleted (or renamed-away) file or directory: the path they
  // read no longer exists, so they are what the change can break.
  const deleted = changed.filter((c) => !g.fileSet.has(c));
  if (deleted.length)
    for (const [f, ms] of g.missingReads ?? [])
      for (const m of ms) {
        const c = deleted.find((x) => x === m || x.startsWith(`${m}/`));
        if (c) mark(f, c);
      }
  // Files that depend on a whole package (an unmapped specifier).
  for (const [f, ds] of g.wholePkg)
    for (const d of ds) {
      const c = changed.find((x) => x.startsWith(`${d}/`));
      if (c) mark(f, c);
    }
  while (queue.length) {
    const f = queue.shift();
    for (const imp of reverse.get(f) ?? []) mark(imp, via.get(f));
  }
  const tests = [...hit].filter((f) => TEST_FILE.test(f)).sort();
  return { hit, tests, via };
}
