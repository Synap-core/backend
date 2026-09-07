import { describe, it, expect } from "vitest";
// @ts-expect-error — plain .mjs script, no types; it exports one pure function.
import { scanTotalMockGaps } from "../../scripts/scan-total-mock-gaps.mjs";

/**
 * TRIPWIRE — a total `vi.mock` factory must list every export the module under
 * test actually imports from that specifier.
 *
 * ── WHY THIS EXISTS, AND WHY THE OTHER RATCHET DOES NOT COVER IT ────────────
 * `__tripwires__/database-mock-total-ratchet.test.ts` counts FILES that use a
 * total `vi.mock("@synap/database", …)`. That is a DEBT counter: it tracks how
 * many files use the risky form. It cannot tell whether any of them is
 * currently WRONG, and it watches exactly one specifier.
 *
 * This is the other half — a DEFECT counter. It reports how many total-mock
 * factories are missing a name their module-under-test imports RIGHT NOW,
 * across every mocked specifier.
 *
 * ── THE FAILURE MODE IT CATCHES ─────────────────────────────────────────────
 * `vi.mock(spec, () => ({...}))` is a TOTAL replacement. When source later
 * gains a new import from `spec`, every test in that file dies — frequently as
 * a suite that COLLECTS ZERO TESTS, which looks like a passing file in a
 * summary line and is invisible to typecheck.
 *
 * Measured 2026-09-06 in one wave: EIGHT separate detonations across three
 * packages and two repos. Five were live failures; the rest were latent until
 * an unrelated change landed. Two were caused by a CORRECT refactor (moving a
 * helper down a package) — this fires on good changes, not just careless ones.
 *
 * A worked example of the shape, from that wave: `relations.ts` gained
 * `EXPOSURE_RELATION_TYPES` alongside the `BELONGS_TO_PROJECT` it already
 * imported, and `relations.get-connections.test.ts` mocked `project-scope.js`
 * with a two-key factory. A hand-written fix would have had to name BOTH — one
 * of them from a change that was not yet committed. `importOriginal` needed
 * neither name, which is why it is the preferred repair.
 *
 * ── WHY A RATCHET AND NOT A BAN ─────────────────────────────────────────────
 * There are ~510 total-replacement factories here. Converting the outstanding
 * gaps in one pass is not safe: `importOriginal` on `permission-check.js`
 * transitively loads `@synap/jobs`, which reads `isNull` off a deliberate
 * `@synap/database` class-stub and dies. So this pins the CURRENT count and
 * fails on any increase — a new gap must be fixed at the moment it is
 * introduced, while the standing debt is retired deliberately.
 *
 * TO FIX A FAILURE: convert the named factory to `importOriginal` —
 *   vi.mock("./x.js", async (importOriginal) => ({
 *     ...(await importOriginal<typeof import("./x.js")>()),
 *     thingYouStub: mockThing,
 *   }));
 * Do NOT simply add the missing name to the hand-written factory: that fixes
 * today's import and re-arms the trap for the next one. If `importOriginal`
 * cannot load the real module, say so in a comment at the call site and name
 * the export explicitly as a considered fallback.
 *
 * NEVER raise BASELINE to make a red build green. Raising it grandfathers a
 * live defect, and a suite collecting zero tests reads as success everywhere
 * except here.
 */

/**
 * Gaps present on 2026-09-06, after the four repairs in that wave
 * (`views.create-idempotent`, `profiles.role-create`, `relation-defs.governance`,
 * `n8n/actions`) and the fifth (`relations.get-connections`). Was 40 before them.
 *
 * Concentrations, so the next person knows where the debt lives rather than
 * re-deriving it: `@synap/database` (12), `@synap/database/schema` (8),
 * `../utils/permission-check.js` (6), `@synap/database/agent-governance` (4),
 * `./_shared.js` (3). Note that all but the first sit in specifiers the
 * `@synap/database` file-count ratchet does not watch at all.
 */
const BASELINE = 37;

describe("tripwire: total vi.mock factories vs the imports they must cover", () => {
  const { totalFactories, findings } = scanTotalMockGaps() as {
    totalFactories: number;
    findings: Array<{
      test: string;
      spec: string;
      dep: string;
      missing: string[];
    }>;
  };

  it("the scan actually walked the tree", () => {
    // NON-VACUITY. A mis-resolved source root, a renamed directory, or a broken
    // regex would yield zero factories and make every assertion below trivially
    // true. That must fail loudly rather than read green — this file exists
    // precisely because "found nothing" and "checked nothing" look identical.
    expect(
      totalFactories,
      "the scan found no `vi.mock` factories at all. It is not passing — it is " +
        "not running. Check the API source root resolution in " +
        "`scripts/scan-total-mock-gaps.mjs`."
    ).toBeGreaterThan(200);
  });

  it("no NEW total-mock factory is missing an export its module imports", () => {
    const detail = findings
      .map(
        (f) =>
          ` ${f.test}\n    mock ${f.spec} <- ${f.dep} needs [${f.missing.join(", ")}]`
      )
      .join("\n");

    expect(
      findings.length,
      `${findings.length} total-replacement mock factories are missing a name ` +
        `their module-under-test imports — the pinned baseline is ${BASELINE}.\n\n` +
        "A NEW one means a test file will die at COLLECTION (zero tests run, " +
        "which reads as a pass in a summary) the moment the affected code path " +
        "is touched. Convert the offending factory to `importOriginal` rather " +
        "than adding the missing name by hand — see this file's header.\n\n" +
        `Current findings:\n${detail}`
    ).toBeLessThanOrEqual(BASELINE);
  });

  it("the baseline is not stale-too-high", () => {
    // Fails when debt is RETIRED without lowering the pin. A ratchet stale in
    // that direction silently tolerates a new gap for every one that was fixed,
    // which is the opposite of what it is for.
    expect(
      findings.length,
      `Only ${findings.length} gaps remain — the pinned baseline is ${BASELINE}, ` +
        `which is now stale (too high) and would tolerate ` +
        `${BASELINE - findings.length} new one(s) silently. Lower BASELINE to ` +
        `${findings.length} in this file to lock the improvement in.`
    ).toBeGreaterThanOrEqual(BASELINE);
  });
});
