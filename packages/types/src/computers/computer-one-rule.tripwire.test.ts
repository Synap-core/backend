import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "../../../../scripts/strip-comments.mjs";

/**
 * TRIPWIRE: a computer's key and presence have ONE rule, and it is shared.
 *
 * pod admin's Computers, the desktop's Connected > Computers and Relay all
 * draw the same computer. The rule lives in `@synap-core/types/computers`
 * (key state in words, days left, the one "never seen", the OS names, the
 * connect and reconnect commands); the device flow's twin is
 * `@synap-core/types/device`. This holds pod admin to it: no file of the app
 * re-derives one of them. The desktop and Relay halves are held in their own
 * repos' tripwires, because a sibling checkout is not there in this repo's CI.
 * It lives beside the rule (not in pod admin's `__tripwires__`) so the types
 * suite, which every change to the rule runs, runs it.
 *
 * HOW: the scanned set is DERIVED (every .ts/.tsx of the app but tests and
 * build output), so a new page is scanned the day it appears. Each forbidden
 * pattern is checked against a literal sample first, so a loosened regex
 * cannot go blind.
 *
 * WHAT IT DOES NOT SEE: a fork under other words with none of these patterns
 * (e.g. a hand-written "3 days left" template); granularity is the file.
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

const FORKS: Array<{ name: string; re: RegExp; sample: string }> = [
  {
    name: "local days-left rule",
    re: /function\s+(daysLeft|computerKeyRead|platformLabel|seenLine)\b/,
    sample: "export function daysLeft(expiresAt: Date, now: number) {",
  },
  {
    name: "local OS names",
    re: /case\s+["']darwin["']/,
    sample: 'case "darwin":',
  },
  {
    name: "own never-seen wording",
    re: /["']Not seen yet["']|seen never|`seen \$\{/,
    sample: "`seen ${formatRelative(d)}`",
  },
  {
    name: "own key-expiry words",
    re: /`Expires in \$\{/,
    sample: "`Expires in ${days(n)}`",
  },
  {
    name: "own reconnect command",
    re: /pods reconnect/,
    sample: 'AGENT_CONNECT_COMMAND.replace(/ init$/, " pods reconnect")',
  },
];

describe("computers: one rule, shared", () => {
  it("scans a plausible, derived set of files", () => {
    expect(FILES.length).toBeGreaterThan(50);
    expect(FILES.map((f) => f.path)).toContain(
      join("app", "(admin)", "computers", "_lib", "computer-model.ts")
    );
  });

  it("the console's computer model reads the shared rule", () => {
    const model = FILES.find((f) =>
      f.path.endsWith("computers/_lib/computer-model.ts")
    );
    expect(model?.src).toContain('"@synap-core/types/computers"');
    expect(model?.src).toContain("computerKeyRead(");
  });

  it.each(FORKS)("no file re-derives: $name", ({ re, sample }) => {
    expect(re.test(sample)).toBe(true);
    expect(FILES.filter((f) => re.test(f.src)).map((f) => f.path)).toEqual([]);
  });
});
