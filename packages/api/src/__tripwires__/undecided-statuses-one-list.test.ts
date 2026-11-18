/**
 * TRIPWIRE: "nobody has decided this proposal yet" is listed ONCE, in
 * `@synap-core/types/proposals/attention` (`UNDECIDED_PROPOSAL_STATUSES`,
 * read through `isProposalUndecided`; the database re-exports the list typed
 * as `ProposalStatus[]` for its `inArray` filters).
 *
 * Plan 8032a127 D6 found five hand-written copies of the pair across the
 * surfaces, and the backend alone still held fifteen after #1149 (the revert
 * matrix, the batch approve, the repair and hand-over guards, the vault grant,
 * the organise claim, the scorecards...). A copy is how a third undecided status, or a dropped
 * one, reaches some doors and not others. This holds them at the one list:
 * no backend source (derived: every .ts/.tsx under `packages/*` and `apps/*`
 * but tests, build output and the attention module itself) spells the pair as
 *
 *  1. an array of exactly the two statuses (`["pending", "approval_failed"]`,
 *     `[ProposalStatus.PENDING, ProposalStatus.APPROVAL_FAILED]`, any order);
 *  2. a two-sided comparison (`s === "pending" || s === "approval_failed"`,
 *     `s !== PENDING && s !== APPROVAL_FAILED`, any order);
 *  3. two stacked switch cases (`case PENDING: case APPROVAL_FAILED:`).
 *
 * Each pattern is checked against a literal sample, and the attention module's
 * own list must still match pattern 1, so a loosened regex cannot go blind.
 *
 * WHAT IT DOES NOT SEE: a code path that tests one of the two statuses on its
 * own (`status === APPROVAL_FAILED` to reopen a failed row is a different
 * question, and stays), a list that adds a third status (the trust ladder's
 * propose rung), an ordering (`find(pending) ?? find(approval_failed)` picks
 * pending FIRST), and other repos (relay, browser, app-bases have their own).
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "../../../../scripts/strip-comments.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "../../../..");
const SKIP = new Set([
  "node_modules",
  "dist",
  ".next",
  ".turbo",
  "coverage",
  "__tests__",
  "__tripwires__",
  "generated",
]);
/** THE list. */
const OWNER = join("packages", "types", "src", "proposals", "attention.ts");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((e) => {
    if (SKIP.has(e)) return [];
    const full = join(dir, e);
    if (statSync(full).isDirectory()) return sources(full);
    return /\.(ts|tsx)$/.test(e) && !/\.(test|d)\.tsx?$/.test(e) ? [full] : [];
  });
}

const ALL = ["packages", "apps"]
  .flatMap((d) => sources(join(REPO, d)))
  .map((f) => ({
    path: relative(REPO, f),
    src: stripComments(readFileSync(f, "utf8"), "ts"),
  }));
const FILES = ALL.filter((f) => f.path !== OWNER);

// One status, spelled as a string or as the database enum's member.
const P = String.raw`(?:["']pending["']|\bProposalStatus\.PENDING\b)`;
const F = String.raw`(?:["']approval_failed["']|\bProposalStatus\.APPROVAL_FAILED\b)`;
const either = (a: string, b: string) => `(?:${a}|${b})`;

const FORKS: Array<{ name: string; re: RegExp; sample: string }> = [
  {
    name: "an array of exactly the two undecided statuses",
    re: new RegExp(
      String.raw`\[\s*` +
        either(String.raw`${P}\s*,\s*${F}`, String.raw`${F}\s*,\s*${P}`) +
        String.raw`\s*,?\s*\]`
    ),
    sample: `inArray(proposals.status, [
        ProposalStatus.PENDING,
        ProposalStatus.APPROVAL_FAILED,
      ])`,
  },
  {
    name: "a two-sided comparison against the two undecided statuses",
    re: new RegExp(
      String.raw`([\w$.]+)\s*(===|!==)\s*` +
        either(
          String.raw`${P}\s*(?:\|\||&&)\s*\1\s*\2\s*${F}`,
          String.raw`${F}\s*(?:\|\||&&)\s*\1\s*\2\s*${P}`
        )
    ),
    sample: `if (
      proposal.status !== "pending" &&
      proposal.status !== "approval_failed"
    ) {`,
  },
  {
    name: "two stacked switch cases for the two undecided statuses",
    re: new RegExp(
      either(
        String.raw`case\s+${P}\s*:\s*case\s+${F}\s*:`,
        String.raw`case\s+${F}\s*:\s*case\s+${P}\s*:`
      )
    ),
    sample: `switch (status) {
      case ProposalStatus.APPROVAL_FAILED:
      case ProposalStatus.PENDING:
        pending += count;`,
  },
];

describe("undecided proposal statuses: one list", () => {
  it("scans a plausible, derived set of files", () => {
    expect(FILES.length).toBeGreaterThan(500);
    const paths = FILES.map((f) => f.path);
    for (const known of [
      join("packages", "api", "src", "routers", "proposals", "revert.ts"),
      join("packages", "api", "src", "routers", "proposals.ts"),
      join("packages", "database", "src", "utils", "proposal-transition.ts"),
    ]) {
      expect(paths).toContain(known);
    }
    expect(paths.some((p) => p.startsWith("apps"))).toBe(true);
  });

  it("the attention module still holds THE list the detector reads", () => {
    const owner = ALL.find((f) => f.path === OWNER);
    expect(owner).toBeDefined();
    expect(FORKS[0]!.re.test(owner!.src)).toBe(true);
  });

  it.each(FORKS)("no backend source re-lists: $name", ({ re, sample }) => {
    expect(re.test(sample)).toBe(true);
    expect(FILES.filter((f) => re.test(f.src)).map((f) => f.path)).toEqual([]);
  });
});
