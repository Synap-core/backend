/**
 * TRIPWIRE — a stored title is DERIVED by the one door, never sliced.
 *
 * THE DEFECT (tickets #18 / #24, plan R2): eighteen sites named a capture, a
 * fallback note, an observation, a channel or a session by cutting text at a
 * character count — `text.slice(0, 80)`. That cut mid-word, kept a whole
 * multi-paragraph body on one line, split emoji, and in one place stored a
 * "…". The one door is `shortenTitle` (`@synap-core/types/titles`): first
 * line, markdown and URLs stripped, clause/word boundary, grapheme-safe, no
 * ellipsis. A "…" is a render-side concern; it is never stored.
 *
 * WHAT IT SCANS: every non-test `.ts`/`.tsx` source under synap-backend
 * `packages/`, plus the sibling repos synap-intelligence-service (hub `src/`)
 * and synap-cli (`src/`) when they are checked out beside it (optional roots:
 * a backend-only checkout skips them and says so). The file set is globbed, so
 * a new file joins the scan by existing.
 *
 * WHAT IT FLAGS: a `title` / `…Title` key or assignment whose value contains
 * `.slice(0, N)` / `.substring(0, N)` / `.substr(0, N)` with N below
 * `TITLE_HARD_MAX` (200). A cut at or above the hard cap is a storage bound on
 * a title someone else wrote (an import's source title), not a derived name.
 * A clip of an id (`x.id.slice(0, 8)`) is an id prefix, not a cut of prose.
 *
 * WHAT IT DOES NOT SEE (measured, not implied): a title passed POSITIONALLY
 * (`fn(x, text.slice(0, 80))` — how `postProcessStructureEntities` got its
 * fallback); a clip computed into a differently named variable first
 * (`const label = text.slice(0, 80); … title: label`); a key spelled other
 * than `title`/`…Title` (`name:`, `goal:`); a `.slice` whose bound is not a
 * literal. Display surfaces (browser, relay) are out of its scope.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { TITLE_HARD_MAX } from "@synap-core/types/titles";

const API_SRC = join(__dirname, "..");
const BACKEND_PACKAGES = join(API_SRC, "../..");
const REPO_ROOT = join(BACKEND_PACKAGES, "../..");

interface Root {
  dir: string;
  /**
   * How the exemptions spell this root's files. NAMED, never read off the
   * checkout directory: CI checks the backend out as `backend/`, a worktree
   * under its own name, and a path derived from the folder name matched no
   * exemption (every entry read as an offender AND as stale).
   */
  label: string;
  /** A healthy scan finds at least this many files (non-vacuity). */
  fileFloor: number;
  optional?: boolean;
}

const ROOTS: Record<string, Root> = {
  backend: {
    dir: BACKEND_PACKAGES,
    label: "synap-backend/packages",
    fileFloor: 1500,
  },
  is: {
    dir: join(
      REPO_ROOT,
      "synap-intelligence-service/apps/intelligence-hub/src"
    ),
    label: "synap-intelligence-service/apps/intelligence-hub/src",
    fileFloor: 200,
    optional: true,
  },
  cli: {
    dir: join(REPO_ROOT, "synap-cli/src"),
    label: "synap-cli/src",
    fileFloor: 40,
    optional: true,
  },
};

/**
 * Known clips that are NOT a stored title, each with why. Every entry must
 * still match a real hit — a stale exemption fails, so the list cannot rot
 * into a blanket pass.
 */
const NOT_A_STORED_TITLE: ReadonlyArray<{
  file: string;
  includes: string;
  why: string;
}> = [
  {
    file: "synap-backend/packages/jobs/src/workers/entity-extract-worker.ts",
    includes: "item.title.slice(0, 60)",
    why: "a log field",
  },
  {
    file: "synap-backend/packages/api/src/import/import-deep.ts",
    includes: ".slice(0, 120)",
    why: "normTitle: a dedup comparison key, never stored",
  },
  {
    file: "synap-backend/packages/api/src/services/imports/group.ts",
    includes: '(item.title || item.card?.title || "").slice(0, 160)',
    why: "a grouping-PROMPT line's length bound on an imported item's own title, never stored",
  },
  {
    file: "synap-cli/src/commands/centrality.ts",
    includes: ".slice(0, 48)",
    why: "a terminal table cell",
  },
  {
    file: "synap-cli/src/commands/graph.ts",
    includes: ".slice(0, 40)",
    why: "a terminal table cell",
  },
  {
    file: "synap-intelligence-service/apps/intelligence-hub/src/routes/structure-eval/cases.ts",
    includes: "LINKEDIN.slice(0, 80)",
    why: "a recorded BAD answer the eval must keep failing",
  },
  // ── AWAITING @synap-core/types >= 1.12.1 ON NPM (2026-10-13, D9) ──────────
  // These ARE stored titles. Their fix is committed on `feat/title-door` in
  // synap-intelligence-service (85d8aaf8) and synap-cli (815460ba): it imports
  // `@synap-core/types/titles`, which no published version carries yet, so it
  // cannot sit on main. When the branch lands each line stops matching and the
  // stale check below FAILS — delete these entries then. Not a permanent pass.
  ...[
    [
      "synap-intelligence-service/apps/intelligence-hub/src/routes/classify-capture.ts",
      "text.slice(0, 80)",
    ],
    [
      "synap-intelligence-service/apps/intelligence-hub/src/routes/structure.ts",
      "text.slice(0, 80)",
    ],
    [
      "synap-intelligence-service/apps/intelligence-hub/src/tools/actions/dispatch-agent.ts",
      "args.task.slice(0, 60)",
    ],
    [
      "synap-intelligence-service/apps/intelligence-hub/src/tools/registry.ts",
      "args.observation.slice(0, 80)",
    ],
    [
      "synap-intelligence-service/apps/intelligence-hub/src/tools/registry.ts",
      "args.purpose.slice(0, 80)",
    ],
    ["synap-cli/src/commands/observe.ts", "text.slice(0, 80)"],
  ].map(([file, includes]) => ({
    file: file!,
    includes: includes!,
    why: "PENDING: fixed on feat/title-door, lands after the types publish",
  })),
];

const SKIP_DIR =
  /^(node_modules|dist|build|out|coverage|__tests__|__tripwires__|\.claude|\.turbo)$/;

function collect(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (!SKIP_DIR.test(name)) collect(p, out);
    } else if (
      /\.(ts|tsx|mts)$/.test(name) &&
      !/\.(test|spec)\.(ts|tsx|mts)$/.test(name) &&
      !name.endsWith(".d.ts")
    ) {
      out.push(p);
    }
  }
  return out;
}

const KEY = /\b(title|\w+Title)\s*(?::|=(?![=>]))\s*/g;
const CLIP = /(?<![iI]d)\.(?:slice|substring|substr)\(\s*0\s*,\s*(\d+)\s*\)/g;

/** The value expression that starts at `i`: up to `,` `;` or a closer at depth 0. */
function valueAt(src: string, i: number): string {
  let depth = 0;
  let end = i;
  for (; end < src.length; end++) {
    const c = src[end]!;
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) {
      if (depth === 0) break;
      depth--;
    } else if ((c === "," || c === ";") && depth === 0) break;
  }
  return src.slice(i, end);
}

/**
 * The position sits in a comment when its line starts a JSDoc/block line or a
 * `//` precedes it on the line. Checked per hit instead of stripping comments
 * first: a `/*` inside a `//` comment once swallowed whole files from a scan.
 */
function inComment(src: string, at: number): boolean {
  const lineStart = src.lastIndexOf("\n", at - 1) + 1;
  const before = src.slice(lineStart, at);
  return /^\s*(\*|\/\*)/.test(before) || /(^|[^:])\/\//.test(before);
}

/** Every `title …= x.slice(0, N<200)` in one source, as `key <- value`. */
export function findTitleClips(src: string): string[] {
  const hits: string[] = [];
  for (const m of src.matchAll(KEY)) {
    if (inComment(src, m.index!)) continue;
    const value = valueAt(src, m.index! + m[0].length);
    const cuts = [...value.matchAll(CLIP)].filter(
      (c) => Number(c[1]) < TITLE_HARD_MAX
    );
    if (cuts.length) hits.push(`${m[1]} <- ${value.replace(/\s+/g, " ")}`);
  }
  return hits;
}

describe("tripwire: a stored title is derived by shortenTitle, never sliced", () => {
  it("the scanner still sees the defect it hunts (self-check)", () => {
    expect(
      findTitleClips(`const p = { title: text.slice(0, 80).trim(), x: 1 };`)
    ).toHaveLength(1);
    expect(
      findTitleClips(`let title = input.content.slice(0, 80).trim();`)
    ).toHaveLength(1);
    expect(
      findTitleClips(
        `push({\n  sessionTitle:\n    \`[\${a}] \${task.substring(0, 60)}\`,\n})`
      )
    ).toHaveLength(1);
    // Not a hit: the door, a storage cap, an id prefix, a comment, a compare.
    expect(findTitleClips(`({ title: shortenTitle(text) })`)).toEqual([]);
    expect(findTitleClips(`({ title: b.title.slice(0, 500) })`)).toEqual([]);
    expect(findTitleClips(`const t = { title: x.id.slice(0, 8) };`)).toEqual(
      []
    );
    expect(findTitleClips(`// title: text.slice(0, 80)\nconst a = 1;`)).toEqual(
      []
    );
    expect(findTitleClips(`if (title === s.slice(0, 80)) {}`)).toEqual([]);
  });

  const scanned: Record<string, number> = {};
  const offenders: string[] = [];
  const exempted = new Set<number>();
  for (const [name, root] of Object.entries(ROOTS)) {
    if (!existsSync(root.dir)) continue;
    const files = collect(root.dir);
    scanned[name] = files.length;
    for (const file of files) {
      const rel = `${root.label}/${relative(root.dir, file)}`;
      for (const hit of findTitleClips(readFileSync(file, "utf8"))) {
        const ex = NOT_A_STORED_TITLE.findIndex(
          (e) => e.file === rel && hit.includes(e.includes)
        );
        if (ex >= 0) exempted.add(ex);
        else offenders.push(`${rel}: ${hit.slice(0, 140)}`);
      }
    }
  }

  it.each(Object.entries(ROOTS))(
    "the %s scan root is present and non-trivially sized",
    (name, root) => {
      if (!existsSync(root.dir)) {
        // A sibling repo absent from a backend-only checkout: stated, not hidden.
        expect(root.optional, `required root missing: ${root.dir}`).toBe(true);
        return;
      }
      expect(scanned[name]).toBeGreaterThanOrEqual(root.fileFloor);
    }
  );

  it("no stored title is cut at a character count", () => {
    expect(
      offenders,
      "Derive the title with shortenTitle (@synap-core/types/titles) — never .slice(0, N)."
    ).toEqual([]);
  });

  it("every exemption still names a real clip (no stale pass)", () => {
    const stale = NOT_A_STORED_TITLE.filter(
      (e, i) =>
        !exempted.has(i) &&
        Object.entries(ROOTS).some(
          ([name, r]) => e.file.startsWith(`${r.label}/`) && name in scanned
        )
    );
    expect(stale).toEqual([]);
  });
});
