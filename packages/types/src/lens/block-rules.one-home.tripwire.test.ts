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
 *     outside this package is red. Every repo is strict since 4 Nov 2026:
 *     synap-app adopted the home at ac8bdfed (lane 2), relay-app at 29cc3a13
 *     (lane 4); browser never had a copy. A new copy imports the rule from
 *     `@synap-core/types/lens` instead;
 *   - the phone's catalog (`relay-app/src/features/work-cells/copy.ts`) once
 *     mirrored the empty words under its own keys; it holds none of them now,
 *     and a mirror coming back is red (it would drift from the home).
 *
 * WHAT IT DOES NOT SEE (stated): a copy under ANOTHER name (only the hunted
 * and former names are matched); a copy that re-implements the rule inline in
 * a component; a copy's BEHAVIOUR (matched by name only). relay-app and
 * browser are scanned only where their checkout sits beside this one: backend
 * CI lays out synap-app alone, so there the phone half is skipped with the
 * reason printed (the devbox and a developer root have all three). A missing synap-app in CI
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

type Repo = "synap-app" | "relay-app" | "browser";

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

/** The budget of one repo's scan: generous, it is a filesystem read, not a hang. */
const SCAN_TIMEOUT_MS = 60_000;

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
    const label = `${repo}: no definition of a block rule outside the home`;
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

    // A whole-tree read (~4,000 files in synap-app): about 2 s alone, past
    // vitest's 5 s default on a loaded machine (seen at load 40 on the Mac).
    it(label, { timeout: SCAN_TIMEOUT_MS }, () => {
      const { files, defs } = scan(root, repo);
      expect(files, `${repo}: the scan read no tree`).toBeGreaterThan(100);
      expect(
        defs.map((d) => `${d.file}:${d.line} defines ${d.name}`),
        "a block rule is defined outside @synap-core/types/lens: import it from there"
      ).toEqual([]);
    });

    if (repo === "relay-app") {
      it("relay-app: the phone's catalog mirrors none of the empty words", () => {
        let src: string;
        try {
          src = readFileSync(
            join(root, "src/features/work-cells/copy.ts"),
            "utf8"
          );
        } catch {
          return; // the catalog file is gone: nothing can mirror the words
        }
        const mirrored = (
          Object.keys(lens.LENS_EMPTY_TITLE_KEY) as string[]
        ).flatMap((cls) =>
          [`relay.workCell.empty.${cls}`, `relay.workCell.why.${cls}`].filter(
            (key) => src.includes(key)
          )
        );
        expect(
          mirrored,
          "relay's catalog mirrors the lens empty words: read them from @synap-core/types/lens (lensEmptyTitle / lensEmptyWhy)"
        ).toEqual([]);
      });
    }
  }
});
