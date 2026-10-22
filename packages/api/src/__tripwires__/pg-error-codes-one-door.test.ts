/**
 * TRIPWIRE — a Postgres integrity violation is recognised through ONE door.
 *
 * WHY (2026-10-22). Twenty-odd catch sites each re-derived "is this a unique
 * violation": some read `err.code` only, some `err.cause.code` one level down,
 * one matched the message text, one read `constraint` but not postgres.js's
 * `constraint_name`. Drizzle wraps the driver error as `.cause` and tRPC wraps
 * again, so a top-level check misses the real error and a recoverable race
 * (a retry, a concurrent insert) surfaces as a 500. The door is
 * `packages/database/src/utils/pg-errors.ts`: `isUniqueViolation`,
 * `isForeignKeyViolation`, `isNotNullViolation`, `uniqueViolationConstraint`,
 * `findPgError`.
 *
 * HOW (derived, not hand-listed): walk every `packages/<pkg>/src` and
 * `apps/<app>/src` (tests skipped), blank comments, and refuse outside the
 * door:
 *   - a quoted 23505 / 23503 / 23502 literal (`code === "23505"`, a
 *     `const UNIQUE_VIOLATION = "23505"`);
 *   - a local copy of a door predicate (`function isUniqueViolation`, a
 *     `const isUniqueViolation =`, a `private isUniqueViolation(` method);
 *   - a direct `code === PG_…` comparison (it skips the cause chain).
 *
 * WHAT IT DOES NOT SEE (stated): a code built at runtime ("2350" + "5"), a
 * helper with another name that compares against an imported constant through
 * a variable, other SQLSTATEs (23514, 23P01: no site handles them by name
 * today — add them to the door and to CODES when one does). Test files may
 * build fake driver errors with the literal and are skipped.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "../../../../scripts/strip-comments.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../..");
const DOOR = "packages/database/src/utils/pg-errors.ts";

const ROOTS = ["packages", "apps"].flatMap((top) =>
  readdirSync(join(REPO, top))
    .map((name) => join(REPO, top, name, "src"))
    .filter((dir) => existsSync(dir))
);
const SKIP = new Set(["node_modules", "dist", "__tests__", "__tripwires__"]);
const SOURCE = /\.(ts|tsx|mts|js|mjs)$/;
const TEST = /\.(test|spec)\.[a-z]+$/;

const RULES: Array<{ id: string; re: RegExp; fix: string }> = [
  {
    id: "literal",
    re: /(["'`])2350[235]\1/,
    fix: "use isUniqueViolation / isForeignKeyViolation / isNotNullViolation from @synap/database",
  },
  {
    id: "copy",
    re: /\b(?:function\s+|(?:const|let|var)\s+|(?:private|protected|public|static)\s+)(?:isUniqueViolation|isForeignKeyViolation|isNotNullViolation)\b/,
    fix: "import the predicate from @synap/database instead of redefining it",
  },
  {
    id: "direct-compare",
    re: /\bcode\s*[!=]==?\s*PG_[A-Z_]+|PG_[A-Z_]+\s*[!=]==?\s*\S*\.code\b/,
    fix: "a direct .code comparison skips the cause chain; use the predicate or findPgError",
  },
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (SOURCE.test(name) && !TEST.test(name)) out.push(full);
  }
  return out;
}

type Hit = { file: string; line: number; rule: string; text: string };

function scan(rel: string, src: string): Hit[] {
  const hits: Hit[] = [];
  stripComments(src, "ts")
    .split("\n")
    .forEach((text, i) => {
      for (const rule of RULES) {
        if (rule.re.test(text)) {
          hits.push({
            file: rel,
            line: i + 1,
            rule: rule.id,
            text: text.trim(),
          });
        }
      }
    });
  return hits;
}

const files = ROOTS.flatMap((root) => walk(root));
const hits = files.flatMap((full) =>
  scan(relative(REPO, full), readFileSync(full, "utf8"))
);

describe("Postgres integrity violations go through one door", () => {
  it("scans real code and recognises each violation (non-vacuity)", () => {
    expect(files.length).toBeGreaterThan(1000);
    expect(files.map((f) => relative(REPO, f))).toContain(DOOR);
    // The door itself is the one place each rule fires.
    const inDoor = new Set(
      hits.filter((h) => h.file === DOOR).map((h) => h.rule)
    );
    expect([...inDoor].sort()).toEqual(["copy", "literal"]);
    // Every shape a site used before 2026-10-22 is caught.
    const samples: Array<[string, string]> = [
      ['if ((err as { code?: string })?.code === "23505") {', "literal"],
      [
        "  return e?.code === '23503' || e?.cause?.code === '23503';",
        "literal",
      ],
      ['const UNIQUE_VIOLATION = "23505";', "literal"],
      ["function isUniqueViolation(err: unknown): boolean {", "copy"],
      ["const isUniqueViolation = (err: unknown): boolean =>", "copy"],
      ["  private isUniqueViolation(error: unknown): boolean {", "copy"],
      ["if (e.code === PG_UNIQUE_VIOLATION) return true;", "direct-compare"],
    ];
    for (const [line, rule] of samples) {
      expect(
        scan("x.ts", line).map((h) => h.rule),
        line
      ).toContain(rule);
    }
    // A comment naming the code is prose, not a check; a call is not a copy.
    expect(
      scan("x.ts", '// a 23505 race: "23505" is unique_violation')
    ).toEqual([]);
    expect(scan("x.ts", "if (!isUniqueViolation(err)) throw err;")).toEqual([]);
  });

  it("no code outside the door checks a SQLSTATE by hand", () => {
    const outside = hits
      .filter((h) => h.file !== DOOR)
      .map((h) => {
        const fix = RULES.find((r) => r.id === h.rule)?.fix;
        return `${h.file}:${h.line} [${h.rule}] ${h.text} — ${fix}`;
      });
    expect(outside, `Use ${DOOR}.`).toEqual([]);
  });
});
