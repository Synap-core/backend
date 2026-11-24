/**
 * The nightly shifted-clock run (.github/workflows/clock-shift.yml,
 * scripts/ci/clock-shift.mjs) is a detector, not a gate: it must never sit on
 * the PR path (a red there would block merges for a bomb nobody changed), must
 * hold read-only permissions, must really move the clock, must report only
 * files that pass unshifted, and must find its files by pattern. Every check
 * below is a function over TEXT so the same function runs on a deliberately
 * broken variant and must flag it (the last block): a guard is a test that
 * has been tried against its own defeat. Named `*.tripwire.test.ts` so
 * `pnpm tripwires` (CI) runs it.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DATE_PATTERN,
  SUPPORTED_PACKAGES,
  classify,
  selectTestFiles,
  wrapperConfigSource,
  // @ts-expect-error — plain ESM script, no declarations
} from "./clock-shift.mjs";

const REPO = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const read = (p: string) => readFileSync(join(REPO, p), "utf8");
const WORKFLOW = read(".github/workflows/clock-shift.yml");
const SCRIPT = read("scripts/ci/clock-shift.mjs");
const SETUP_PATH = join(REPO, "scripts/ci/clock-shift.setup.ts");

/** The lines of a top-level `key:` block (up to the next top-level key). */
function topBlock(yml: string, key: string): string[] {
  const lines = yml.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`${key}:`));
  if (start === -1) return [];
  const out: string[] = [];
  for (const l of lines.slice(start + 1)) {
    if (/^\S/.test(l)) break;
    out.push(l);
  }
  return out;
}

function triggerViolations(yml: string): string[] {
  const keys = topBlock(yml, "on")
    .filter((l) => /^ {2}\S/.test(l))
    .map((l) => l.trim().replace(/:.*$/, ""));
  const bad = keys.filter(
    (k) => !["schedule", "workflow_dispatch"].includes(k)
  );
  const missing = ["schedule", "workflow_dispatch"].filter(
    (k) => !keys.includes(k)
  );
  return [
    ...bad.map((k) => `trigger ${k}`),
    ...missing.map((k) => `missing ${k}`),
  ];
}

function permissionViolations(yml: string): string[] {
  const perms = topBlock(yml, "permissions")
    .map((l) => l.trim())
    .filter(Boolean);
  const jobLevel = /^ {4}permissions:/m.test(yml);
  return [
    ...(perms.length === 1 && perms[0] === "contents: read"
      ? []
      : [`top-level permissions: ${perms.join(",")}`]),
    ...(jobLevel ? ["a job sets its own permissions"] : []),
  ];
}

/** Import a setup file with CLOCK_SHIFT_DAYS set; return the shift it applied, in days. */
async function appliedShiftDays(
  setupFile: string,
  days: number
): Promise<number> {
  const RealDate = globalThis.Date;
  process.env.CLOCK_SHIFT_DAYS = String(days);
  try {
    vi.resetModules();
    await import(/* @vite-ignore */ setupFile);
    const fixed = new Date("2026-01-01T00:00:00Z").toISOString();
    if (fixed !== "2026-01-01T00:00:00.000Z") return NaN; // explicit dates must be untouched
    return Math.round((Date.now() - RealDate.now()) / 86_400_000);
  } finally {
    globalThis.Date = RealDate;
    delete process.env.CLOCK_SHIFT_DAYS;
  }
}

function selectionViolations(): string[] {
  const v: string[] = [];
  const found = selectTestFiles(
    [
      "packages/types/src/new/brand-new.test.ts",
      "packages/api/x.test.ts",
      "packages/types/src/a.ts",
    ],
    ["packages/types"]
  );
  if (
    !found
      .get("packages/types")
      ?.includes("packages/types/src/new/brand-new.test.ts")
  )
    v.push("a new file is not picked up");
  if (found.size !== 1 || found.get("packages/types")?.length !== 1)
    v.push("out-of-scope or non-test file selected");
  if (!/spawnSync\(\s*"git",\s*\["grep"/.test(SCRIPT))
    v.push("script does not git-grep for its files");
  if (
    /["'`][^"'`\n]*\.test\.tsx?["'`]\s*,\s*["'`][^"'`\n]*\.test\.tsx?["'`]/.test(
      SCRIPT.replace(/"\*\.test\.ts", "\*\.test\.tsx"/, "")
    )
  )
    v.push("script holds a hand-listed set of test files");
  return v;
}

describe("clock-shift: a detector off the PR path", () => {
  it("triggers only on schedule and workflow_dispatch", () => {
    expect(triggerViolations(WORKFLOW)).toEqual([]);
  });

  it("holds contents: read and nothing else, no secret beyond the setup action's own", () => {
    expect(permissionViolations(WORKFLOW)).toEqual([]);
    expect(WORKFLOW).not.toMatch(/SYNAP_OBS_KEY|SYNAP_POD_URL/);
  });

  it("bounds its cost and never overlaps itself", () => {
    expect(WORKFLOW).toMatch(/timeout-minutes: \d+/);
    expect(topBlock(WORKFLOW, "concurrency").join("\n")).toMatch(
      /group: clock-shift/
    );
    expect(WORKFLOW).toMatch(/cron: "17 3 \* \* \*"/); // not :00/:30, not 18:30
  });

  it("pins every third-party action by sha", () => {
    const uses = [...WORKFLOW.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]);
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses)
      expect(u.startsWith("./") || /@[0-9a-f]{40}$/.test(u), u).toBe(true);
  });

  it("passes dispatch inputs through env, never into the script text", () => {
    const run = WORKFLOW.split("\n").filter(
      (l) => /\$\{\{\s*inputs\./.test(l) && !/^\s+INPUT_/.test(l)
    );
    expect(run).toEqual([]);
  });
});

describe("clock-shift: the generated config shifts the clock", () => {
  it("the wrapper imports the package config and adds the setup file", () => {
    const src = wrapperConfigSource({
      baseConfigPath: "/x/vitest.config.ts",
      setupPath: SETUP_PATH,
    });
    expect(src).toContain('import base from "/x/vitest.config.ts"');
    expect(src).toContain(JSON.stringify(SETUP_PATH));
    expect(src).toMatch(/setupFiles:\s*\[\.\.\.\[\]\.concat\(test\.setupFiles/); // keeps the package's own
    expect(
      wrapperConfigSource({ baseConfigPath: null, setupPath: SETUP_PATH })
    ).toContain("const base = {}");
  });

  it("the setup file moves new Date() and Date.now() by CLOCK_SHIFT_DAYS, not explicit dates", async () => {
    expect(await appliedShiftDays(SETUP_PATH, 45)).toBe(45);
  });

  it("the setup file does nothing without the variable", async () => {
    const before = globalThis.Date;
    delete process.env.CLOCK_SHIFT_DAYS;
    vi.resetModules();
    await import(/* @vite-ignore */ SETUP_PATH);
    expect(globalThis.Date).toBe(before);
  });
});

describe("clock-shift: the unshifted-first rule", () => {
  it("reports a file only when it fails shifted and passes unshifted", () => {
    expect(
      classify({ shifted: new Set(["a", "b", "c"]), unshifted: new Set(["b"]) })
    ).toEqual({
      bombs: ["a", "c"],
      failingAlready: ["b"],
    });
    expect(classify({ shifted: new Set(), unshifted: new Set(["z"]) })).toEqual(
      { bombs: [], failingAlready: [] }
    );
  });
});

describe("clock-shift: the file set is derived", () => {
  it("is found by git grep over a date pattern, not listed", () => {
    expect(selectionViolations()).toEqual([]);
    expect(DATE_PATTERN).toContain("20(2[6-9]|3[0-9])");
    expect(SUPPORTED_PACKAGES.length).toBeGreaterThan(0);
  });
});

describe("clock-shift: each guard fails on its broken variant", () => {
  const dirs: string[] = [];
  afterEach(() => (dirs.length = 0));
  const tmp = (name: string, text: string) => {
    const d = mkdtempSync(join(tmpdir(), "clock-shift-neg-"));
    dirs.push(d);
    const p = join(d, name);
    writeFileSync(p, text);
    return p;
  };

  it("a pull_request or push trigger is flagged", () => {
    expect(
      triggerViolations(
        WORKFLOW.replace(
          "  workflow_dispatch:",
          "  pull_request:\n  workflow_dispatch:"
        )
      )
    ).toContain("trigger pull_request");
    expect(
      triggerViolations(
        WORKFLOW.replace("  schedule:", "  push:\n  merge_group:\n  schedule:")
      )
    ).toEqual(["trigger push", "trigger merge_group"]);
  });

  it("write permissions are flagged", () => {
    expect(
      permissionViolations(
        WORKFLOW.replace("contents: read", "contents: write")
      ).length
    ).toBeGreaterThan(0);
    expect(
      permissionViolations(
        WORKFLOW.replace(
          "jobs:\n",
          "jobs:\n  x:\n    permissions:\n      id-token: write\n"
        )
      ).length
    ).toBeGreaterThan(0);
  });

  it("a setup file whose offset is zero is caught", async () => {
    const broken = tmp(
      "setup.ts",
      readFileSync(SETUP_PATH, "utf8").replace("86_400_000", "0")
    );
    expect(await appliedShiftDays(broken, 45)).not.toBe(45);
  });

  it("a setup file that also moves explicit dates is caught", async () => {
    const broken = tmp(
      "setup.ts",
      readFileSync(SETUP_PATH, "utf8").replace(
        "else super(...(args as [any]));",
        "else super(RealDate.now() + offsetMs);"
      )
    );
    expect(await appliedShiftDays(broken, 45)).toBeNaN();
  });

  it("a script that lists its files by hand is caught", () => {
    const listed = SCRIPT.replace(
      'spawnSync(\n    "git",',
      'spawnSync(\n    "echo",'
    );
    expect(listed).not.toBe(SCRIPT);
    expect(/spawnSync\(\s*"git",\s*\["grep"/.test(listed)).toBe(false);
  });

  it("treating an unshifted failure as a bomb is caught", () => {
    const broken = (shifted: Set<string>) => ({ bombs: [...shifted].sort() });
    expect(broken(new Set(["b"])).bombs).not.toEqual(
      classify({ shifted: new Set(["b"]), unshifted: new Set(["b"]) }).bombs
    );
  });
});
