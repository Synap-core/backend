import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * TRIPWIRE — the two `diagnose` surfaces must answer the same question the
 * same way.
 *
 * `synap_diagnose` has TWO independent code paths over the SAME data:
 *   • GLOBAL  (no args)          → `services/diagnose/global.ts`
 *   • CLASS   (type:"proposal")  → `services/diagnose/index.ts`
 * They were written separately, and every time they diverge a HEALTH door
 * reports something untrue. Both failures below were live and both were found
 * by a human dogfooding, not by a gate — which is why this file exists.
 *
 * ── FAILURE 1: a FALSE ALARM (the worse kind) ───────────────────────────────
 * `global.ts` hardcoded `cap: AGENT_PROPOSALS_PER_USER_PER_DAY` (the BASE 10)
 * for every agent, while `agentDailyProposalCap()` applies a 3x multiplier for
 * a proven agent (>=100 recent proposals at >=95% approve rate). Live, the
 * global door announced "1 agent(s) hit the daily proposal cap" for an agent
 * at 13/30 that `diagnose(agentId)` simultaneously reported as
 * `cap: 30, atOrOverCap: false`. A health door that invents a block sends the
 * user to investigate something that is not happening — strictly worse than
 * the silent drop in FAILURE 2, because it costs attention AND trust.
 *
 * ── FAILURE 2: a SILENT DROP ────────────────────────────────────────────────
 * Both surfaces count pending proposals under `userVisibleWhere`, a WORKSPACE
 * membership predicate — so a row whose `workspaceId` does not resolve to a
 * workspace the user belongs to is discarded. Those are exactly the malformed
 * rows (orphaned workspace ids; one carries a USER id in the workspace
 * column). Three external test passes reported `diagnose` saying 11 while
 * `orient` and `list_proposals` said 14, with nothing explaining the gap.
 * Both surfaces now report `mineOutsideLens` instead of hiding it.
 *
 * ── WHAT THIS PROVES, AND WHAT IT DOES NOT ─────────────────────────────────
 * It is a SOURCE SCAN. It proves a call to the shared resolver APPEARS in each
 * surface and that the base constant is not used as a per-agent cap. It does
 * NOT prove the resolved value is rendered correctly, nor that the counts are
 * right — that needs a live DB, and there is none in this environment. The
 * guarantee is one-directional and it is the useful direction: a future author
 * who re-hardcodes the base constant, or drops the lens-gap field from one
 * surface but not the other, reads RED.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const GLOBAL = join(HERE, "../services/diagnose/global.ts");
const CLASS = join(HERE, "../services/diagnose/index.ts");

const stripComments = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (_m, p) => p);

const globalSrc = stripComments(readFileSync(GLOBAL, "utf8"));
const classSrc = stripComments(readFileSync(CLASS, "utf8"));

describe("tripwire: diagnose's two surfaces agree", () => {
  it("scans real files — not passing over nothing", () => {
    expect(globalSrc.length).toBeGreaterThan(2000);
    expect(classSrc.length).toBeGreaterThan(2000);
    // Both must actually be proposal-health code, else the assertions below
    // would hold vacuously over an unrelated file.
    expect(globalSrc).toContain("proposals");
    expect(classSrc).toContain("proposals");
  });

  it("the per-agent cap is RESOLVED, never the hardcoded base constant", () => {
    expect(
      globalSrc,
      "global diagnose must call agentDailyProposalCap() per agent — the base " +
        "constant ignores the 3x trust multiplier and produced a FALSE " +
        "'hit the daily proposal cap' alarm for an agent at 13/30."
    ).toContain("agentDailyProposalCap(");

    expect(
      /cap:\s*AGENT_PROPOSALS_PER_USER_PER_DAY/.test(globalSrc),
      "global diagnose assigns the BASE constant as a per-agent cap. Use " +
        "agentDailyProposalCap(agentId) so this door and diagnose(agentId) " +
        "cannot disagree about whether an agent is blocked."
    ).toBe(false);
  });

  it("BOTH surfaces report the workspace-lens gap rather than dropping it", () => {
    for (const [name, src] of [
      ["global", globalSrc],
      ["class", classSrc],
    ] as const) {
      expect(
        src,
        `${name} diagnose counts pending under a workspace-membership lens, so ` +
          "rows with unresolvable placement vanish. It must surface " +
          "`mineOutsideLens` — a health door is the worst place to hide a " +
          "malformed record, because those are the ones needing attention."
      ).toContain("mineOutsideLens");
    }
  });

  it("the lens gap is CLAMPED — a negative 'hidden' count is nonsense", () => {
    for (const [name, src] of [
      ["global", globalSrc],
      ["class", classSrc],
    ] as const) {
      expect(
        /Math\.max\(\s*0,/.test(src),
        `${name} diagnose must clamp mineOutsideLens at 0: the author floor is ` +
          "NOT a superset of the workspace floor (a teammate's row in a shared " +
          "workspace is workspace-visible but not author-mine), so the " +
          "difference can legitimately go negative."
      ).toBe(true);
    }
  });
});
