import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join, dirname, resolve, relative, sep } from "path";
import { fileURLToPath } from "url";
import { DEFAULT_AUTO_APPROVE } from "@synap/governance-policy";
import { filterUncoveredActions, isFloorCoveredAction } from "@synap/database";

/**
 * TRIPWIRE — the `DEFAULT_AUTO_APPROVE` whitelist is the CODE FLOOR
 * (decideAgentPolicy rung 8), NOT rows to seed into `governance_rules`
 * (Governance Convergence Plan D2). A rule that merely restates a floor pattern
 * changes no enforcement outcome for a normal-governance agent — it is pure
 * flood, exactly what a prior full-seed backfill produced (~27 redundant rows
 * per agent).
 *
 * This asserts the ONE diff-only helper both write paths (the boot backfill and
 * the `syncAutoApproveRules` write-mirror) run their action lists through
 * excludes EVERY floor member, while genuine widenings survive — and that both
 * write paths actually reference the helper, so the guard can't be silently
 * unplugged.
 *
 * DECREASE-ONLY / robust: the core invariant is computed against the LIVE
 * `DEFAULT_AUTO_APPROVE`, not a hand-typed snapshot — grow the floor and the
 * invariant still holds automatically.
 */
describe("tripwire: DEFAULT_AUTO_APPROVE floor is never materialized as governance_rules rows", () => {
  it("the diff-only helper excludes EVERY floor member", () => {
    // Sanity: the floor is non-trivial (dead-import guard).
    expect(DEFAULT_AUTO_APPROVE.length).toBeGreaterThan(10);

    // Not one floor pattern survives the filter → no floor row is ever seeded.
    expect(
      filterUncoveredActions([...DEFAULT_AUTO_APPROVE]),
      "a DEFAULT_AUTO_APPROVE member is NOT excluded by filterUncoveredActions — " +
        "it would be seeded as a redundant governance_rules row (flood). The " +
        "floor is rung 8, not rows."
    ).toEqual([]);

    // And each member is individually reported as floor-covered.
    for (const pattern of DEFAULT_AUTO_APPROVE) {
      expect(isFloorCoveredAction(pattern), pattern).toBe(true);
    }
  });

  it("genuine widenings (not covered by the floor) survive the filter", () => {
    // These are the CLI `normal` preset entries NOT in DEFAULT_AUTO_APPROVE.
    // NOT a snapshot to freeze — a positive control that the filter isn't a
    // trivial "return []". If the floor ever absorbs one of these, delete it
    // from this list (the exclusion assertion above stays the real invariant).
    const widenings = [
      "channel.create",
      "relation.update",
      "playbook.create",
      "tool.create",
      "skill.create",
    ];
    for (const w of widenings) {
      // Only assert the ones the floor doesn't (yet) cover — robust to the
      // floor absorbing one later.
      if (!DEFAULT_AUTO_APPROVE.includes(w)) {
        expect(isFloorCoveredAction(w), w).toBe(false);
      }
    }
    expect(filterUncoveredActions(["entity.create", "channel.create"])).toEqual(
      ["channel.create"]
    );

    // The broad "crazy" preset value is a genuine (very wide) widening — it must
    // survive so a `["*"]` grant still materializes a rule.
    expect(isFloorCoveredAction("*")).toBe(false);
  });

  it("EVERY governance_rules seeder routes its action list through the diff-only helper", () => {
    // Anchor on THIS test file, not process.cwd() — vitest may run from the
    // repo root or from packages/api, and cwd-relative paths break under the
    // former. src/__tripwires__ → up 4 = the backend repo root.
    const REPO_ROOT = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "..",
      ".."
    );

    // ROBUST RATCHET: instead of a hardcoded write-path list (which silently
    // loses coverage the moment a 4th seeder is added), WALK the repo for every
    // file that inserts into `governance_rules`, then subtract the small,
    // explicit allowlist of MANUAL user-/proposal-authored doors that
    // legitimately insert unfiltered rows. Every REMAINING file is a SEEDER and
    // MUST reference `filterUncoveredActions` — a future 4th seeder is caught
    // automatically.
    //
    // ALLOWLIST — manual doors that legitimately insert an UNFILTERED row (a
    // user/human deliberately authoring a rule is allowed to name a floor-equal
    // pattern; it is their explicit choice, not seeder flood):
    //   - routers/governance-rules.ts   → the `create` "always approve for X"
    //     door (createdBy = ctx.userId, a real user).
    //   - routers/proposals.ts          → the `governance.widen_lane` approve-
    //     executor (createdBy = approver, sourceProposalId = the proposal).
    const ALLOWLIST = new Set(
      [
        "packages/api/src/routers/governance-rules.ts",
        "packages/api/src/routers/proposals.ts",
      ].map((p) => p.split("/").join(sep))
    );

    const INSERT_MARKER = "insert(governanceRules";

    /** Recursively collect *.ts files under `dir` (skip build/test noise). */
    function walkTsFiles(dir: string): string[] {
      const out: string[] = [];
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, ent.name);
        if (ent.isDirectory()) {
          if (
            ent.name === "node_modules" ||
            ent.name === "dist" ||
            ent.name === "__tripwires__"
          ) {
            continue;
          }
          out.push(...walkTsFiles(full));
        } else if (
          ent.isFile() &&
          ent.name.endsWith(".ts") &&
          !ent.name.endsWith(".test.ts")
        ) {
          out.push(full);
        }
      }
      return out;
    }

    const inserters = walkTsFiles(join(REPO_ROOT, "packages"))
      .filter((f) => readFileSync(f, "utf8").includes(INSERT_MARKER))
      .map((f) => relative(REPO_ROOT, f));

    // Sanity: the walk actually found the known inserters (guards against a
    // broken walk silently asserting nothing).
    expect(
      inserters.length,
      "walk found no governance_rules inserters — the walk is broken, not the code"
    ).toBeGreaterThanOrEqual(4);

    const seeders = inserters.filter((rel) => !ALLOWLIST.has(rel));

    // At least the three known seeders (backfill, syncAutoApproveRules,
    // ensure-capture-agent) must remain after subtracting the allowlist.
    expect(
      seeders.length,
      "no seeder files remain after the allowlist — the allowlist is too broad"
    ).toBeGreaterThanOrEqual(3);

    for (const rel of seeders) {
      const src = readFileSync(join(REPO_ROOT, rel), "utf8");
      expect(
        src.includes("filterUncoveredActions"),
        `${rel} inserts into governance_rules but does NOT reference ` +
          `filterUncoveredActions — a SEEDER is materializing the floor as rows ` +
          `(flood). Route its action list through filterUncoveredActions before ` +
          `inserting, or (if it is a legitimate manual user/proposal door) add ` +
          `it to the explicit ALLOWLIST in this test.`
      ).toBe(true);
    }
  });
});
