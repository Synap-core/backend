/**
 * import-graph.mjs decides which test files a PR runs. A missed edge lets a
 * change merge without running the test it breaks; a spurious one costs
 * minutes. This file pins each edge kind on a small fixture repository built
 * in a temp dir (so every row names exactly what it rules out), then checks
 * the real graph of this checkout is not vacuous.
 *
 * What it does not cover: that the real repository has no edge shape the
 * fixture lacks. The PR's replay (every main red of 28-29 Oct selected by
 * its culprit) measures that; ci-changes.tripwire.test.ts pins the culprit
 * pairs on the real graph.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  buildGraph,
  evaluatePaths,
  exportsTarget,
  extractSpecifiers,
  isTestCode,
  reach,
  // @ts-expect-error — plain ESM script, no declarations
} from "./import-graph.mjs";
// @ts-expect-error — plain ESM script, no declarations
import { loadGraph, selectTier } from "./affected.mjs";

const FIXTURE: Record<string, string> = {
  "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
  "CLAUDE.md": "# rules\n",
  "skills/synap/SKILL.md": "# skill\n",
  "deploy/x.yml": "a: 1\n",
  "packages/lib/package.json": JSON.stringify({
    name: "@x/lib",
    exports: {
      ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
      "./sub": { import: "./dist/sub.js" },
      "./entry": { import: "./dist/entry.js" },
    },
  }),
  "packages/other/package.json": JSON.stringify({
    name: "@x/other",
    exports: { "./gone": { import: "./dist/nowhere/gone.js" } },
  }),
  "packages/other/src/o.ts": "export const o = 1;\n",
  "packages/lib/tsup.config.ts":
    'export default { entry: { entry: "src/inner/entry-src.ts" } };\n',
  "packages/lib/src/index.ts": 'export * from "./deep.js";\n',
  "packages/lib/src/deep.ts": "export const deep = 1;\n",
  "packages/lib/src/sub.ts":
    'import { deep } from "./deep.js";\nexport const sub = deep;\n',
  "packages/lib/src/lone.ts": "export const lone = 1;\n",
  "packages/lib/src/inner/entry-src.ts": "export const entry = 1;\n",
  "packages/app/package.json": JSON.stringify({
    name: "@x/app",
    scripts: { test: "vitest run" },
  }),
  "packages/app/vitest.config.ts":
    'import { include } from "./vitest.shared";\nexport default { test: { include, setupFiles: ["./src/setup.ts"] } };\n',
  "packages/app/vitest.shared.ts":
    'export const include = ["src/**/*.test.ts"];\n',
  // A tsup entry naming a file that does not exist: src/ resolves the export.
  // A tsup entry that names a file that is gone (no src twin of its dist
  // name either): the export maps to no source, so the whole package.
  "packages/third/package.json": JSON.stringify({
    name: "@x/third",
    exports: { "./e": { import: "./dist/e.js" } },
  }),
  "packages/third/tsup.config.ts":
    'export default { entry: { e: "src/gone.ts" } };\n',
  "packages/third/src/t.ts": "export const t = 1;\n",
  "packages/app/src/third.test.ts": 'import { e } from "@x/third/e";\n',
  "packages/app/src/setup.ts": 'import "./setup-helper.js";\n',
  "packages/app/src/setup-helper.ts": "export const reset = 1;\n",
  "packages/app/src/a.ts":
    'import { sub } from "@x/lib/sub";\nexport const a = sub;\n',
  "packages/app/src/a.test.ts": 'import { a } from "./a.js";\n',
  "packages/app/src/types-only.test.ts":
    'import type { Deep } from "@x/lib";\nexport type { Deep } from "@x/lib";\n',
  "packages/app/src/value.test.ts": 'import { deep } from "@x/lib";\n',
  "packages/app/src/entry.test.ts": 'import { entry } from "@x/lib/entry";\n',
  "packages/app/src/whole.test.ts": 'import { x } from "@x/other/gone";\n',
  "packages/app/src/c.ts": "export const c = 1;\n",
  "packages/app/src/dyn.test.ts":
    'it("x", async () => { await import("./c.js"); });\n',
  "packages/app/src/mocked.test.ts":
    'vi.mock("./c.js", () => ({ c: 2 }));\nimport { c } from "./c.js";\n',
  "packages/app/src/comment.test.ts":
    '// reads `../src/lone-copy.ts` and "./c.ts" in prose only\nconst s = 1;\n',
  "packages/app/src/fixtures/data.json": "{}\n",
  "packages/app/src/reads.test.ts": [
    'import { readFileSync } from "node:fs";',
    'import { join, dirname } from "node:path";',
    'import { fileURLToPath } from "node:url";',
    "const HERE = dirname(fileURLToPath(import.meta.url));",
    'readFileSync(join(HERE, "fixtures", "data.json"), "utf8");',
    'readFileSync("skills/synap/SKILL.md", "utf8");',
    'readFileSync("CLAUDE.md", "utf8");',
    // A file this change deletes (or renames away): absent from the head.
    'readFileSync("deploy/old.yml", "utf8");',
    "",
  ].join("\n"),
  // Walks its own folder: a change in it reaches the test (an ancestor dir
  // the test builds and reads, not an anchor).
  "packages/app/src/walk/scan.test.ts": [
    'import { readdirSync } from "node:fs";',
    'import { dirname } from "node:path";',
    'import { fileURLToPath } from "node:url";',
    "const HERE = dirname(fileURLToPath(import.meta.url));",
    "for (const f of readdirSync(HERE)) check(f);",
    "",
  ].join("\n"),
  "packages/app/src/walk/rules.ts": "export const rules = 1;\n",
  // Builds the same directory and never walks it: no read.
  "packages/app/src/walk/no-walk.test.ts": [
    'import { dirname } from "node:path";',
    'import { fileURLToPath } from "node:url";',
    "const HERE = dirname(fileURLToPath(import.meta.url));",
    "use(HERE);",
    "",
  ].join("\n"),
  // A relative import into another package's build output reads its source.
  "packages/app/src/dist-rel.test.ts":
    'import { sub } from "../../lib/dist/sub.js";\n',
  "packages/lib/tsconfig.json": '{ "compilerOptions": {} }\n',
  "packages/app/src/src-relative.test.ts": [
    'import { join } from "node:path";',
    'const SRC = join(process.cwd(), "src");',
    'read(join(SRC, "pick.ts"));',
    'read2("prod.ts");',
    "",
  ].join("\n"),
  "packages/app/src/pick.ts": "export const pick = 1;\n",
  // The base directory comes from a helper: only "under its package's src/"
  // resolves `routers/route.ts`.
  "packages/app/src/routers/route.ts": "export const route = 1;\n",
  "packages/app/src/helper-base.test.ts":
    'import { SRC } from "./test-utils/paths.js";\nread(join(SRC, "routers/route.ts"));\n',
  "packages/app/src/test-utils/paths.ts": "export const SRC = here;\n",
  "packages/app/src/prod.ts":
    'export const hint = "see deploy/x.yml and skills/synap/SKILL.md";\nexport const word = "skills";\n',
  "packages/app/src/prod.test.ts": 'import { hint } from "./prod.js";\n',
  "packages/app/src/gone.test.ts": 'import { x } from "./deleted.js";\n',
};

const root = mkdtempSync(join(tmpdir(), "import-graph-"));
for (const [p, text] of Object.entries(FIXTURE)) {
  mkdirSync(dirname(join(root, p)), { recursive: true });
  writeFileSync(join(root, p), text);
}
afterAll(() => rmSync(root, { recursive: true, force: true }));
const g = buildGraph(root);
const sel = (...changed: string[]) => reach(changed, g).tests as string[];
const T = (f: string) => `packages/app/src/${f}`;

describe("import-graph: the edges, on a fixture small enough to read", () => {
  it("a change reaches its importers transitively, through a package's exports (dist mapped to src)", () => {
    // deep ← sub (@x/lib/sub → dist/sub.js → src/sub.ts) ← a ← a.test.
    // Rules out "direct importers only" and "package specifiers are opaque".
    expect(sel("packages/lib/src/deep.ts")).toEqual(
      expect.arrayContaining([T("a.test.ts"), T("value.test.ts")])
    );
    // lone.ts is imported by nobody: nothing runs (rules out "the package").
    expect(sel("packages/lib/src/lone.ts")).toEqual([]);
  });

  it("an `import type` is no edge; a value import of the same module is", () => {
    const s = sel("packages/lib/src/deep.ts");
    expect(s).toContain(T("value.test.ts"));
    expect(s).not.toContain(T("types-only.test.ts"));
  });

  it("a tsup entry maps its dist file to its source", () => {
    expect(sel("packages/lib/src/inner/entry-src.ts")).toEqual([
      T("entry.test.ts"),
    ]);
  });

  it("a tsup entry that names no file is no edge: the whole package", () => {
    expect(sel("packages/third/src/t.ts")).toEqual([T("third.test.ts")]);
    expect(g.wholePkg.get(T("third.test.ts"))).toEqual(
      new Set(["packages/third"])
    );
  });

  it("what a vitest config imports is known, and selectTier runs it in full on the committed plan", () => {
    expect([...g.configImports]).toEqual(["packages/app/vitest.shared.ts"]);
    const lg = loadGraph(root, () => false);
    const t = selectTier(["packages/app/vitest.shared.ts"], lg);
    expect([t.scope, t.committedPlan]).toEqual(["full", true]);
    expect(t.why.join(" ")).toContain("a vitest config imports it");
    // The control: a source file of the same package is selected.
    expect(selectTier([T("c.ts")], lg).scope).toBe("selected");
  });

  it("an export that maps to no source depends on the whole package", () => {
    // Any source file of @x/other reaches it, though nothing imports o.ts.
    expect(sel("packages/other/src/o.ts")).toEqual([T("whole.test.ts")]);
    expect(g.wholePkg.get(T("whole.test.ts"))).toEqual(
      new Set(["packages/other"])
    );
  });

  it("a package.json reaches every importer of the package and its own tests", () => {
    const s = sel("packages/lib/package.json");
    expect(s).toEqual(
      expect.arrayContaining([T("a.test.ts"), T("value.test.ts")])
    );
    // types-only.test.ts loads nothing of @x/lib at run time.
    expect(s).not.toContain(T("types-only.test.ts"));
    expect(sel("packages/app/package.json").length).toBeGreaterThan(10);
  });

  it("a dynamic import and a vi.mock'd module are edges", () => {
    expect(sel(T("c.ts"))).toEqual(
      expect.arrayContaining([T("dyn.test.ts"), T("mocked.test.ts")])
    );
  });

  it("the vitest config and its setup files reach every test of the package", () => {
    const s = sel(T("setup.ts"));
    expect(s).toEqual(sel("packages/app/vitest.config.ts"));
    expect(s.length).toBe(
      Object.keys(FIXTURE).filter(
        (f) => f.startsWith("packages/app/") && f.endsWith(".test.ts")
      ).length
    );
    // What the setup file imports reaches them too: the config LOADS its
    // setup files (an import edge, transitive), it does not just read them.
    expect(sel(T("setup-helper.ts"))).toEqual(s);
  });

  it("a test reads by path: relative to itself, the repo, its package's src, or a root file", () => {
    expect(sel(T("fixtures/data.json"))).toEqual([T("reads.test.ts")]);
    expect(sel("skills/synap/SKILL.md")).toEqual([T("reads.test.ts")]);
    expect(sel("CLAUDE.md")).toEqual([T("reads.test.ts")]);
    // `readSrc("prod.ts")` under `join(process.cwd(), "src")`.
    expect(sel(T("pick.ts"))).toEqual([T("src-relative.test.ts")]);
    expect(sel(T("prod.ts"))).toEqual(
      expect.arrayContaining([T("prod.test.ts"), T("src-relative.test.ts")])
    );
    // A base built in a helper: only the package's src/ resolves it.
    expect(sel(T("routers/route.ts"))).toEqual([T("helper-base.test.ts")]);
  });

  it("production code naming a path in a string is no read; a comment is never an edge", () => {
    // prod.ts says "see deploy/x.yml": its importer prod.test.ts must not run
    // for a deploy change (it would reach every importer of a real module).
    expect(sel("deploy/x.yml")).toEqual([]);
    expect(g.reads.get(T("prod.ts"))).toBeUndefined();
    expect(g.readDirs.get(T("prod.ts"))).toBeUndefined();
    // comment.test.ts names ./c.ts only in a comment.
    expect(sel(T("c.ts"))).not.toContain(T("comment.test.ts"));
  });

  it("a package's tsconfig or build config reaches its importers like its package.json", () => {
    // packages/lib's tsconfig decides the dist every importer loads.
    const s = sel("packages/lib/tsconfig.json");
    expect(s).toEqual(
      expect.arrayContaining([
        T("a.test.ts"),
        T("value.test.ts"),
        T("entry.test.ts"),
      ])
    );
    expect(s).not.toContain(T("types-only.test.ts"));
    expect(sel("packages/lib/tsup.config.ts")).toEqual(s);
  });

  it("a deleted or renamed file is still read by the tests that name it", () => {
    // deploy/old.yml is absent from the head (the change deleted it).
    expect(sel("deploy/old.yml")).toEqual([T("reads.test.ts")]);
  });

  it("a test that walks a directory it built reads it, its own folder included", () => {
    expect(sel(T("walk/rules.ts"))).toEqual([T("walk/scan.test.ts")]);
  });

  it("a relative import into another package's dist reads its source", () => {
    expect(sel("packages/lib/src/deep.ts")).toContain(T("dist-rel.test.ts"));
  });

  it("a deleted module still reaches the files that import it", () => {
    expect(sel(T("deleted.ts"))).toEqual([T("gone.test.ts")]);
  });

  it("a changed test file is selected by itself", () => {
    expect(sel(T("a.test.ts"))).toEqual([T("a.test.ts")]);
  });
});

describe("import-graph: the parsers' own self-checks", () => {
  it("extractSpecifiers sees every load form and marks type-only ones", () => {
    const got = extractSpecifiers(
      [
        'import a from "a";',
        'import "side";',
        'import {\n  b,\n  c,\n} from "multi";',
        'export * from "star";',
        'import type { T } from "t";',
        'export type { U } from "u";',
        'const d = await import("dyn");',
        'require("req");',
        'vi.mock("mocked", () => ({}));',
        'const notAnImport = "from";',
      ].join("\n")
    );
    expect(
      got
        .map(
          (x: { spec: string; typeOnly: boolean }) =>
            `${x.spec}${x.typeOnly ? ":type" : ""}`
        )
        .sort()
    ).toEqual(
      [
        "a",
        "side",
        "multi",
        "star",
        "t:type",
        "u:type",
        "dyn",
        "req",
        "mocked",
      ].sort()
    );
  });

  it("evaluatePaths follows the anchors and the consts built from them", () => {
    const text = [
      "const HERE = dirname(fileURLToPath(import.meta.url));",
      'const ROOT = resolve(HERE, "..", "..");',
      'join(ROOT, "skills", "synap");',
      'resolve(__dirname, "../fixtures/x.json");',
      'join(process.cwd(), "src", "a.ts");',
      'new URL("./w.js", import.meta.url);',
      "join(ROOT, slug);",
    ].join("\n");
    expect(
      evaluatePaths(text, "packages/app/src", "packages/app").sort()
    ).toEqual(
      [
        "packages",
        // HERE itself: a const that is only an anchor is a built path too
        "packages/app/src",
        "packages/skills/synap",
        "packages/app/fixtures/x.json",
        "packages/app/src/a.ts",
        "packages/app/src/w.js",
      ].sort()
    );
  });

  it("exportsTarget reads exact keys, `*` patterns and conditions", () => {
    const exp = {
      ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
      "./*": { import: "./dist/*/index.js" },
      "./workers/*.js": { import: "./dist/workers/*.js" },
    };
    expect(exportsTarget(exp, ".")).toBe("./dist/index.js");
    expect(exportsTarget(exp, "./i18n")).toBe("./dist/i18n/index.js");
    expect(exportsTarget(exp, "./workers/a.js")).toBe("./dist/workers/a.js");
    expect(exportsTarget("./dist/x.js", ".")).toBe("./dist/x.js");
  });

  it("test code is the tests and the helpers only tests load", () => {
    for (const f of [
      "packages/api/src/x.test.ts",
      "packages/api/src/__tests__/helpers.ts",
      "packages/database/src/test-utils/db.ts",
      "packages/api/src/x.test-helpers.ts",
    ])
      expect(isTestCode(f), f).toBe(true);
    for (const f of ["packages/api/src/x.ts", "packages/api/src/testable.ts"])
      expect(isTestCode(f), f).toBe(false);
  });
});

describe("import-graph: the real graph of this checkout is not vacuous", () => {
  const REPO = fileURLToPath(new URL("../..", import.meta.url));
  const real = buildGraph(REPO);
  it("reads thousands of files and their edges", () => {
    expect(real.files.length).toBeGreaterThan(5000);
    expect(real.imports.size).toBeGreaterThan(4000);
    // Self-check on known edges: a package specifier and a test's own config.
    expect(real.imports.get("packages/api/src/access/grant-read.ts")).toContain(
      "packages/governance-policy/src/index.ts"
    );
    expect(
      real.imports.get(
        "packages/api/src/routers/webhooks-postiz.pglite.test.ts"
      )
    ).toContain("packages/api/vitest.config.ts");
    expect(
      real.reads.get("packages/api/src/routers/webhooks-postiz.pglite.test.ts")
    ).toContain("packages/database/migrations/0319_lifecycle_columns.sql");
  });
});
