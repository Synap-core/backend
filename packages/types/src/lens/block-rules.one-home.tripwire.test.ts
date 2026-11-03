/**
 * CROSS-REPO TRIPWIRE — the rules of a document's work blocks have ONE home.
 *
 * WHY (Generative UI wave 3, plan 9ad4b2fc §3 and §5 lane 1). The web
 * (synap-app) and the phone (relay-app) each computed the same block rules —
 * the scope a cell reads, a `lens-section`'s props, the status route, the
 * empty words — and two of them disagreed (a pod document under a space, a
 * bad `empty`). They now live in `@synap-core/types/lens` (`./cell-scope`,
 * `./block-props`, `./block-placeholder`, `./block-copy`).
 *
 * HOW (derived, never a hand list of what to hunt):
 *   - the hunted names are the lens door's exports that come from those four
 *     modules (identity-checked against `./index`), plus each one's FORMER
 *     names, each export classified ({@link FORMER_NAMES}: a new export
 *     without its row fails the first test below);
 *   - the scanned set is every non-test source file of synap-app (`packages`,
 *     `apps`), relay-app (`src`, `app`) and browser (`electron`), comments
 *     stripped;
 *   - a DEFINITION of a hunted name (`function X`, `const|let|var|class X`)
 *     outside this package is red, unless it is a copy that predates the home
 *     and waits for its adoption lane ({@link PENDING_ADOPTION});
 *   - a pending copy that is still there must AGREE with the home wherever it
 *     can be read without running it (the words, the route map, the limits),
 *     so the copies cannot drift while they wait.
 *
 * HOW IT BECOMES STRICT (lanes 2 and 4). App repos land on their main with
 * no backend PR, and backend CI reads them at main, so this guard cannot fail
 * on a copy that is GONE (it would turn backend main red the moment an app
 * lane lands). A copy removed by its lane leaves a stale row, which is only
 * reported. Each adoption lane, once its commit is on its main, deletes its
 * rows here in one backend PR; a repo with no row left is fully strict: any
 * definition of a hunted name in it is red.
 *
 * WHAT IT DOES NOT SEE (stated): a copy under ANOTHER name (only the hunted
 * and former names are matched); a copy that re-implements the rule inline in
 * a component; the function copies' BEHAVIOUR (they are matched by name, and
 * only the readable tables are compared). relay-app and browser are scanned
 * only where their checkout sits beside this one: backend CI lays out
 * synap-app alone, so there the phone half is skipped with the reason printed
 * (the devbox and a developer root have all three). A missing synap-app in CI
 * is a failure, never a skip.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { stripComments } from "../../../../scripts/strip-comments.mjs";
import {
  siblingCheckout,
  siblingRequired,
  siblingSkipReason,
} from "../../../../scripts/sibling-checkout.mjs";
import * as lens from "./index.js";
import * as blockCopy from "./block-copy.js";
import * as blockPlaceholder from "./block-placeholder.js";
import * as blockProps from "./block-props.js";
import * as cellScope from "./cell-scope.js";

// ── What is hunted ──────────────────────────────────────────────────────────

const RULE_MODULES = [cellScope, blockProps, blockPlaceholder, blockCopy];

/** The lens door's value exports that come from the rule modules. */
type RuleName = Extract<
  keyof typeof lens,
  | keyof typeof cellScope
  | keyof typeof blockProps
  | keyof typeof blockPlaceholder
  | keyof typeof blockCopy
>;

/**
 * Each rule export's FORMER names: what its copies were called before the
 * home existed, `[]` when it never had a copy. Typed by {@link RuleName} (an
 * editor flags a missing row; this package's tsc does not check tests), and
 * the first test fails on a rule export with no row.
 */
const FORMER_NAMES = {
  cellLensScope: [],
  documentLensScope: [],
  documentCellScope: [],
  readLensSectionBlock: ["pageSectionConfig", "lensCellLimit"],
  LENS_SECTION_LIMIT_MIN: ["LENS_CELL_LIMIT_MIN"],
  LENS_SECTION_LIMIT_MAX: ["LENS_CELL_LIMIT_MAX"],
  STATUS_OF_ROUTE_KIND: ["ROUTE_KIND"],
  readStatusMarkId: ["statusMarkId"],
  BLOCK_PLACEHOLDER_STATES: [],
  BLOCK_PLACEHOLDER_ACT: [],
  blockPlaceholder: [],
  LENS_EMPTY_TITLE_KEY: ["LENS_EMPTY_TITLES"],
  LENS_EMPTY_WHY_KEY: ["LENS_EMPTY_WHY"],
  lensBlockCopy: [],
  lensBlockT: [],
  lensEmptyTitle: [],
  lensEmptyWhy: [],
} as const satisfies Record<RuleName, readonly string[]>;

const RULE_NAMES: string[] = Object.keys(lens).filter((name) =>
  RULE_MODULES.some(
    (m) =>
      Object.prototype.hasOwnProperty.call(m, name) &&
      (m as Record<string, unknown>)[name] ===
        (lens as Record<string, unknown>)[name]
  )
);
const HUNTED = new Set<string>([
  ...RULE_NAMES,
  ...Object.values(FORMER_NAMES).flat(),
]);

/** A definition of a hunted name at the start of a line (comments stripped). */
const DEFINITION = new RegExp(
  String.raw`^[ \t]*(?:export[ \t]+)?(?:declare[ \t]+)?(?:async[ \t]+)?(?:function[ \t]*\*?[ \t]*|(?:const|let|var|class)[ \t]+)(${[...HUNTED].join("|")})\b`,
  "gm"
);

// ── The copies that predate the home (each removed by its adoption lane) ────

type Repo = "synap-app" | "relay-app" | "browser";

/**
 * Today's copies, read at each repo's main (3 Nov 2026: synap-app 8e7a2a7b,
 * relay-app a62ea3fc, browser none). Only shrinks: a lane deletes its rows
 * once its adoption is on its main.
 */
const PENDING_ADOPTION: Record<
  Repo,
  ReadonlyArray<{ file: string; name: string; lane: string }>
> = {
  "synap-app": [
    {
      file: "packages/hooks/src/cell-runtime/cell-lens-scope.ts",
      name: "cellLensScope",
      lane: "2",
    },
    {
      file: "packages/hooks/src/markdown-engine/renderer/embed-frame/document-embed-context.tsx",
      name: "documentLensScope",
      lane: "2",
    },
    {
      file: "packages/web/src/lens-page/copy.ts",
      name: "LENS_EMPTY_TITLES",
      lane: "2",
    },
    {
      file: "packages/web/src/lens-page/copy.ts",
      name: "LENS_EMPTY_WHY",
      lane: "2",
    },
    {
      file: "packages/web/src/work-cells/PageSectionCell.tsx",
      name: "pageSectionConfig",
      lane: "2",
    },
    {
      file: "packages/web/src/work-cells/StatusOfCell.tsx",
      name: "statusMarkId",
      lane: "2",
    },
    {
      file: "packages/web/src/work-cells/StatusOfCell.tsx",
      name: "STATUS_OF_ROUTE_KIND",
      lane: "2",
    },
  ],
  "relay-app": [
    {
      file: "src/features/work-cells/WorkCells.tsx",
      name: "ROUTE_KIND",
      lane: "4",
    },
    {
      file: "src/features/work-cells/embed-host.tsx",
      name: "documentCellScope",
      lane: "4",
    },
    {
      file: "src/features/work-cells/work-cell-model.ts",
      name: "LENS_CELL_LIMIT_MIN",
      lane: "4",
    },
    {
      file: "src/features/work-cells/work-cell-model.ts",
      name: "LENS_CELL_LIMIT_MAX",
      lane: "4",
    },
    {
      file: "src/features/work-cells/work-cell-model.ts",
      name: "lensCellLimit",
      lane: "4",
    },
  ],
  browser: [],
};

const ROOTS: Record<Repo, string[]> = {
  "synap-app": ["packages", "apps"],
  "relay-app": ["src", "app"],
  browser: ["electron"],
};

// ── The scan ────────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".expo",
  "coverage",
  "storybook-static",
  "__tests__",
  "__fixtures__",
]);
const SOURCE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const SKIP_FILE =
  /\.(?:test|spec|stories)\.[cm]?[jt]sx?$|\.d\.ts$|\.generated\./;

function walk(dir: string, out: string[]): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // a root a repo does not have (e.g. no `apps/`)
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(full, out);
    } else if (SOURCE.test(entry.name) && !SKIP_FILE.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

interface Definition {
  file: string;
  name: string;
  line: number;
}

function definitionsIn(source: string): Array<{ name: string; line: number }> {
  const code = stripComments(source, "ts");
  return [...code.matchAll(DEFINITION)].map((m) => ({
    name: m[1]!,
    line: code.slice(0, m.index).split("\n").length,
  }));
}

function scan(root: string, repo: Repo): { files: number; defs: Definition[] } {
  const files = ROOTS[repo].flatMap((r) => walk(join(root, r), []));
  const defs: Definition[] = [];
  for (const path of files) {
    const source = readFileSync(path, "utf8");
    for (const d of definitionsIn(source)) {
      defs.push({ file: relative(root, path), ...d });
    }
  }
  return { files: files.length, defs };
}

const CHECKOUTS: Array<{ repo: Repo; root: string | null; required: boolean }> =
  [
    {
      repo: "synap-app",
      root: siblingCheckout("synap-app"),
      required: siblingRequired(),
    },
    { repo: "relay-app", root: siblingCheckout("relay-app"), required: false },
    { repo: "browser", root: siblingCheckout("browser"), required: false },
  ];

// ── The tables a pending copy can be compared on ────────────────────────────

/** `export const NAME = { key: 'words', … }` → { key: words } (one pair per line). */
function tableOf(source: string, name: string): Record<string, string> | null {
  const m = source.match(
    new RegExp(String.raw`(?:const|let|var)\s+${name}\s*=\s*\{([\s\S]*?)\n\}`)
  );
  if (!m) return null;
  const out: Record<string, string> = {};
  for (const [, key, , words] of m[1]!.matchAll(
    /^\s*(\w+):\s*(['"])(.*)\2,?\s*$/gm
  )) {
    out[key!] = words!;
  }
  return out;
}

/** `const NAME = { a: 'x', b: 'y' }` on one line → { a: x, b: y }. */
function inlineMapOf(
  source: string,
  name: string
): Record<string, string> | null {
  const m = source.match(
    new RegExp(String.raw`(?:const|let|var)\s+${name}\s*=\s*\{([^}]*)\}`)
  );
  if (!m) return null;
  const out: Record<string, string> = {};
  for (const [, key, , value] of m[1]!.matchAll(
    /(\w+)\s*:\s*(['"])([^'"]*)\2/g
  )) {
    out[key!] = value!;
  }
  return out;
}

/** `const NAME = 12;` → 12. */
function numberOf(source: string, name: string): number | null {
  const m = source.match(
    new RegExp(String.raw`(?:const|let|var)\s+${name}\s*=\s*(-?\d+)\s*;`)
  );
  return m ? Number(m[1]) : null;
}

/** The `'key': 'words'` pairs of a catalog object opened by `opener` (relay's `copy.ts`). */
function catalogOf(
  source: string,
  opener: RegExp
): Record<string, string> | null {
  const start = source.search(opener);
  if (start === -1) return null;
  const end = source.indexOf("\n}", start);
  const body = source.slice(start, end === -1 ? undefined : end);
  const out: Record<string, string> = {};
  // Groups: 1 the key's quote, 2 the key, 3 the words' quote, 4 the words.
  for (const [, , key, , words] of body.matchAll(
    /(['"])([\w.]+)\1\s*:\s*(['"])(.*?)\3\s*,?\s*$/gm
  )) {
    out[key!] = words!;
  }
  return out;
}

// ── The guard ───────────────────────────────────────────────────────────────

describe("work block rules: one home in @synap-core/types/lens", () => {
  it("hunts every rule export and its former names (non-vacuity)", () => {
    for (const n of [
      "cellLensScope",
      "documentCellScope",
      "readLensSectionBlock",
      "STATUS_OF_ROUTE_KIND",
      "blockPlaceholder",
      "lensEmptyTitle",
    ]) {
      expect(RULE_NAMES).toContain(n);
    }
    // block-copy's raw catalogs (`en`, `fr`) are not on the door: never hunted.
    expect(HUNTED.has("en")).toBe(false);
    expect(RULE_NAMES.sort()).toEqual(Object.keys(FORMER_NAMES).sort());
  });

  it("the definition matcher sees what it hunts, and not a re-export or a use", () => {
    expect(
      definitionsIn(
        [
          "export function cellLensScope(ctx) {}",
          "const ROUTE_KIND = { entity: 'entity' } as const;",
          "  export const LENS_EMPTY_WHY = {",
          "export { cellLensScope } from '@synap-core/types/lens';",
          "const x = STATUS_OF_ROUTE_KIND[type];",
          "// export function statusMarkId() {}",
          "const ROUTE_KINDS = [];",
        ].join("\n")
      ).map((d) => d.name)
    ).toEqual(["cellLensScope", "ROUTE_KIND", "LENS_EMPTY_WHY"]);
  });

  for (const { repo, root, required } of CHECKOUTS) {
    const label = `${repo}: no definition of a block rule outside the home but its pending copies`;
    if (!root) {
      if (required) {
        it(label, () => {
          expect(
            root,
            `${repo} must be checked out beside this repo in CI`
          ).not.toBeNull();
        });
      } else {
        console.warn(siblingSkipReason(repo, "block-rules-one-home"));
        it.skip(label, () => {});
      }
      continue;
    }

    it(label, () => {
      const { files, defs } = scan(root, repo);
      expect(files, `${repo}: the scan read no tree`).toBeGreaterThan(100);
      const pending = new Set(
        PENDING_ADOPTION[repo].map((p) => `${p.file}#${p.name}`)
      );
      const unexpected = defs
        .filter((d) => !pending.has(`${d.file}#${d.name}`))
        .map((d) => `${d.file}:${d.line} defines ${d.name}`);
      expect(
        unexpected,
        "a block rule is defined outside @synap-core/types/lens: import it from there"
      ).toEqual([]);

      const found = new Set(defs.map((d) => `${d.file}#${d.name}`));
      const stale = PENDING_ADOPTION[repo].filter(
        (p) => !found.has(`${p.file}#${p.name}`)
      );
      if (stale.length) {
        console.warn(
          `[block-rules-one-home] ${repo}: adopted, delete these PENDING_ADOPTION rows: ` +
            stale.map((p) => `${p.file}#${p.name} (lane ${p.lane})`).join(", ")
        );
      }
    });

    it(`${repo}: a pending copy that is still there agrees with the home`, () => {
      const read = (file: string): string | null => {
        try {
          return readFileSync(join(root, file), "utf8");
        } catch {
          return null;
        }
      };
      let compared = 0;
      for (const { file, name } of PENDING_ADOPTION[repo]) {
        const src = read(file);
        if (!src) continue;
        if (name === "LENS_EMPTY_TITLES" || name === "LENS_EMPTY_WHY") {
          const table = tableOf(src, name);
          if (!table) continue;
          const words =
            name === "LENS_EMPTY_TITLES"
              ? lens.lensEmptyTitle
              : lens.lensEmptyWhy;
          const home = Object.fromEntries(
            Object.keys(lens.LENS_EMPTY_TITLE_KEY).map((cls) => [
              cls,
              words(cls as keyof typeof lens.LENS_EMPTY_TITLE_KEY, "en"),
            ])
          );
          expect(table, `${file} ${name}`).toEqual(home);
          compared++;
        } else if (name === "STATUS_OF_ROUTE_KIND" || name === "ROUTE_KIND") {
          const map = inlineMapOf(src, name);
          if (!map) continue;
          expect(map, `${file} ${name}`).toEqual(lens.STATUS_OF_ROUTE_KIND);
          compared++;
        } else if (
          name === "LENS_CELL_LIMIT_MIN" ||
          name === "LENS_CELL_LIMIT_MAX"
        ) {
          const n = numberOf(src, name);
          if (n === null) continue;
          expect(n, `${file} ${name}`).toBe(
            name === "LENS_CELL_LIMIT_MIN"
              ? lens.LENS_SECTION_LIMIT_MIN
              : lens.LENS_SECTION_LIMIT_MAX
          );
          compared++;
        }
      }
      // The phone's catalog mirrored the empty words under its own keys (en + fr).
      if (repo === "relay-app") {
        const src = read("src/features/work-cells/copy.ts");
        const catalogs = src
          ? {
              en: catalogOf(src, /const en = \{/),
              fr: catalogOf(src, /const fr\b[^=]*= \{/),
            }
          : null;
        const classes = Object.keys(lens.LENS_EMPTY_TITLE_KEY) as Array<
          keyof typeof lens.LENS_EMPTY_TITLE_KEY
        >;
        for (const locale of ["en", "fr"] as const) {
          const cat = catalogs?.[locale];
          if (!cat) continue;
          let mirrored = 0;
          for (const cls of classes) {
            const title = cat[`relay.workCell.empty.${cls}`];
            const why = cat[`relay.workCell.why.${cls}`];
            if (title !== undefined) {
              expect(title, `relay ${locale} empty.${cls}`).toBe(
                lens.lensEmptyTitle(cls, locale)
              );
              mirrored++;
            }
            if (why !== undefined) {
              expect(why, `relay ${locale} why.${cls}`).toBe(
                lens.lensEmptyWhy(cls, locale)
              );
              mirrored++;
            }
          }
          // All of the mirror, or none of it once adopted (no mirrored key left
          // in the file): never a parse that sees half, or nothing, of a mirror.
          const keysLeft = (src ?? "").includes("relay.workCell.empty.");
          expect(
            keysLeft ? [classes.length * 2] : [0],
            `relay ${locale}: the catalog parse saw ${mirrored} of the mirrored words`
          ).toContain(mirrored);
          compared += mirrored;
        }
      }
      // Non-vacuity while copies wait: a repo with a pending table compares it.
      const tables = PENDING_ADOPTION[repo].filter((p) =>
        /^(LENS_EMPTY_TITLES|LENS_EMPTY_WHY|STATUS_OF_ROUTE_KIND|ROUTE_KIND|LENS_CELL_LIMIT_MIN|LENS_CELL_LIMIT_MAX)$/.test(
          p.name
        )
      );
      const stillThere = tables.filter((p) => {
        const s = read(p.file);
        return s !== null && definitionsIn(s).some((d) => d.name === p.name);
      });
      if (stillThere.length)
        expect(compared).toBeGreaterThanOrEqual(stillThere.length);
    });
  }
});
