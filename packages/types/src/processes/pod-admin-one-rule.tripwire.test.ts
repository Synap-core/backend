import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "../../../../scripts/strip-comments.mjs";
import { PROCESS_BLOCKS, PROCESS_HEALTH_STATES } from "./index.js";

/**
 * TRIPWIRE: pod admin reads a process's health rule and block order from this
 * leaf ONLY (Process wave plan 0adf8352, W4).
 *
 * The desktop process page and pod admin's `/processes` draw the same model.
 * The rule (`deriveProcessHealth`, `PROCESS_HEALTH_STATES`) and the order
 * (`PROCESS_BLOCKS`, `processBlockIsEmpty`) live here; this holds pod admin
 * to them: (1) its process pages REACH the leaf (the block order through
 * `PROCESS_BLOCKS`, the health through the read's own `health`), and (2) no
 * file of the app re-derives either one. The desktop is held by its own
 * repo's tripwire, because a sibling checkout is not there in this repo's CI.
 * It lives beside the rule (not in pod admin's `__tripwires__`) so the types
 * suite, which every change to the rule runs, runs it (the computers
 * precedent, `computers/computer-one-rule.tripwire.test.ts`).
 *
 * HOW: the scanned set is DERIVED (every .ts/.tsx of the app but tests and
 * build output), so a new page is scanned the day it appears. Each forbidden
 * pattern is checked against a literal sample first, so a loosened regex
 * cannot go blind. The health-state and block words are read from the leaf's
 * own lists, so a new state or block is scanned by existing.
 *
 * WHAT IT DOES NOT SEE: a fork under other words (a hand-written "Latest run
 * failed" with none of the state keys); granularity is the file.
 */
const APP_ROOT = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../../../apps/pod-admin"
);
const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  "__tripwires__",
  ".turbo",
  "coverage",
]);

function sourceFiles(dir = APP_ROOT): string[] {
  return readdirSync(dir).flatMap((entry) => {
    if (SKIP_DIRS.has(entry)) return [];
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)
      ? [full]
      : [];
  });
}

const FILES = sourceFiles().map((f) => ({
  path: relative(APP_ROOT, f),
  src: stripComments(readFileSync(f, "utf8"), "ts"),
}));

/** The process pages: whatever renders `/processes`, its object and its model. */
const PAGE_MODEL = "app/(admin)/processes/_lib/process-page.ts";
const OBJECT_VIEW = "app/_lib/object/views/process-object.tsx";
const LIST_PAGE = "app/(admin)/processes/page.tsx";

const LEAF_IMPORT = /from\s+["']@synap-core\/types\/processes["']/;

/** A quoted health-state key the leaf owns (the dashed ones are unique to it). */
const HEALTH_KEYS = PROCESS_HEALTH_STATES.filter((s) => s.includes("-"));
const healthLiteral = new RegExp(
  `["'\`](${HEALTH_KEYS.map((s) => s.replace(/-/g, "\\-")).join("|")})["'\`]`
);

/** Three block keys in the leaf's order, quoted, in one array literal. */
const [b0, b1, b2] = PROCESS_BLOCKS;
const blockOrderLiteral = new RegExp(
  `\\[\\s*["']${b0}["']\\s*,\\s*["']${b1}["']\\s*,\\s*["']${b2}["']`
);

const FORKS: Array<{ name: string; re: RegExp; sample: string }> = [
  {
    name: "a local health rule",
    re: /function\s+(deriveProcessHealth|processHealth|healthOfProcess)\b|PROCESS_HEALTH_STATES\s*=/,
    sample: "export function deriveProcessHealth(input: Input) {",
  },
  {
    name: "re-deriving health on the client (the read carries it)",
    re: /\bderiveProcessHealth\s*\(/,
    sample: "const h = deriveProcessHealth({ definitionStatus });",
  },
  {
    name: "a health state written by hand",
    re: healthLiteral,
    sample: 'if (p.health.state === "unresolved-failure") {',
  },
  {
    name: "a local block order",
    re: /PROCESS_BLOCKS\s*=|function\s+processBlockIsEmpty\b/,
    sample: "const PROCESS_BLOCKS = ['when'];",
  },
  {
    name: "the block order written by hand",
    re: blockOrderLiteral,
    sample: `const ORDER = ["${b0}", "${b1}", "${b2}", "moves"];`,
  },
];

describe("pod admin reads the process rule from @synap-core/types/processes only", () => {
  it("scans a real app tree", () => {
    expect(FILES.length).toBeGreaterThan(100);
  });

  it("the process pages reach the leaf (order and health)", () => {
    const src = (path: string) => FILES.find((f) => f.path === path)?.src;
    const model = src(PAGE_MODEL);
    expect(model, PAGE_MODEL).toBeDefined();
    expect(model!).toMatch(LEAF_IMPORT);
    // The block order is the leaf's list, the empty answer the leaf's.
    expect(model!).toMatch(/\bPROCESS_BLOCKS\b/);
    expect(model!).toMatch(/\bprocessBlockIsEmpty\s*\(/);
    // Both pages draw the order through the model and the health from the read.
    for (const path of [OBJECT_VIEW, LIST_PAGE]) {
      const page = src(path);
      expect(page, path).toBeDefined();
      expect(page!).toMatch(/from\s+["'][^"']*_lib\/process-page["']/);
      expect(page!).toMatch(/\.health\b/);
    }
    expect(src(OBJECT_VIEW)!).toMatch(/\bblocksToDraw\s*\(/);
  });

  for (const fork of FORKS) {
    it(`no file re-derives it: ${fork.name}`, () => {
      expect(fork.sample).toMatch(fork.re);
      const hits = FILES.filter((f) => fork.re.test(f.src)).map((f) => f.path);
      expect(hits).toEqual([]);
    });
  }
});
