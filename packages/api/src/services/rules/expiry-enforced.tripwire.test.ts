import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * An expiry nobody filters on is decorative, and worse than absent: the owner
 * believes a rule lapsed while it keeps steering the agent. `ruleNotExpiredWhere`
 * shipped with ZERO production consumers once already — this pins the doors.
 *
 * The distinction below is the design, not an accident:
 *
 *   ENFORCE — the agent-facing reads. `skills.getSkills` backs
 *   `/agent-skills/executable`, which is what the IS `dynamic-skill-loader`
 *   calls before injecting standing rules into the model's prompt.
 *   `GET /agent-skills` is the instruction catalog. A lapsed rule must not
 *   reach an agent through either.
 *
 *   DO NOT ENFORCE — the owner-facing doors.
 */
const API_SRC = join(__dirname, "../..");

const ENFORCING = [
  "routers/skills.ts",
  "routers/hub-protocol/rest/agent-skills.ts",
];
const MUST_NOT_ENFORCE = ["routers/hub-protocol/rest/rules.ts"];

/**
 * THE FILE IS THE WRONG UNIT, and finding that out is why this section exists.
 *
 * `routers/skills.ts` holds BOTH audiences: `skills.list` feeds the IS prompt
 * path and must enforce, while `listRules` / `getRule` / `dryRunRule` are the
 * owner's own inventory and must waive. A file-level "never waives" assertion
 * is therefore unsatisfiable for that file no matter which behaviour is
 * correct — it went red the moment the waiver landed, which is the test doing
 * its job by refusing to express a rule at the wrong granularity.
 *
 * So the unit is the tRPC PROCEDURE: each `visibleSkillsWhere(` call is
 * attributed to the nearest procedure declaration above it, and the audience is
 * declared per procedure. A new rule door gets no default — it appears in
 * `unclassified` and fails until someone states which audience it serves.
 */
const PROCEDURE_AUDIENCE: Record<string, "agent" | "owner"> = {
  // Backs `/agent-skills/executable` → the IS `dynamic-skill-loader`, which
  // injects standing rules straight into a model's prompt.
  list: "agent",
  // A single skill by id, reachable by an agent. Fail-safe: enforces.
  get: "agent",
  // The owner's rule inventory, its detail page, and a replay they asked for.
  listRules: "owner",
  getRule: "owner",
  dryRunRule: "owner",
};

/**
 * Every `visibleSkillsWhere(...)` call in `source`, with its own arguments,
 * paren-BALANCED.
 *
 * A regex was tried first and had a hole worth recording: it ended with
 * `\)\s*\)`, which only ever matched a call NESTED inside another call
 * (`and(visibleSkillsWhere(...))`). Every existing site happens to be nested,
 * so the scan looked complete — but a new door writing the call bare would have
 * been invisible to it, and a scanner that cannot see a door cannot flag it.
 * Found by mutation: injecting exactly such a door did not turn this red.
 */
function visibleSkillsWhereCalls(
  source: string
): Array<{ at: number; text: string }> {
  const out: Array<{ at: number; text: string }> = [];
  const NAME = "visibleSkillsWhere(";
  let from = 0;
  for (;;) {
    const at = source.indexOf(NAME, from);
    if (at === -1) return out;
    let depth = 1;
    let i = at + NAME.length;
    while (i < source.length && depth > 0) {
      const ch = source[i];
      if (ch === "(") depth += 1;
      else if (ch === ")") depth -= 1;
      i += 1;
    }
    out.push({ at, text: source.slice(at, i) });
    from = i;
  }
}

function read(rel: string): string {
  const path = join(API_SRC, rel);
  if (!existsSync(path)) throw new Error(`guarded file is missing: ${rel}`);
  return readFileSync(path, "utf8");
}

describe("rule expiry is enforced at the agent-facing doors", () => {
  it("finds every file it claims to guard (never vacuously green)", () => {
    for (const rel of [...ENFORCING, ...MUST_NOT_ENFORCE]) {
      expect(() => read(rel), rel).not.toThrow();
    }
  });

  // Assert the CALL, not the mention: the import line alone satisfies a bare
  // `toContain`, so the first version of this test passed with the door
  // un-wired. Caught by mutation-checking it.
  it.each(ENFORCING)("%s applies the expiry predicate", (rel) => {
    expect(read(rel)).toMatch(/ruleNotExpiredWhere\s*\(/);
  });

  it.each(MUST_NOT_ENFORCE)(
    "%s WAIVES it — an expired rule stays visible to its owner",
    (rel) => {
      // ⚠️ THIS ASSERTION USED TO BE `not.toMatch(/ruleNotExpiredWhere\(/)`,
      // and it was GREEN while the door filtered expired rules out. The file
      // never types that identifier: the predicate arrived transitively,
      // ANDed inside `visibleSkillsWhere`. A source scan can only ever measure
      // what a file SAYS, so an absence-of-token assertion about a
      // transitively-inherited property is unfalsifiable — it passes whether
      // the door enforces or not, which is the worst kind of green.
      //
      // The waiver fixes the measurability, not just the behaviour: opting out
      // requires the door to literally type `includeExpired`, so its presence
      // is a fact about THIS file and the scan can see it.
      expect(read(rel)).toMatch(/includeExpired:\s*true/);
    }
  );

  it("the waiver is not merely present somewhere — it is on the SKILL read", () => {
    // Guard against the token satisfying this from an unrelated line (a
    // comment, another query). It must sit inside a `visibleSkillsWhere(...)`
    // call, which is the only place it does anything.
    for (const rel of MUST_NOT_ENFORCE) {
      const src = read(rel);
      const calls = visibleSkillsWhereCalls(src);
      expect(
        calls.some((c) => c.text.includes("includeExpired")),
        `${rel} mentions includeExpired but not inside a visibleSkillsWhere call`
      ).toBe(true);
    }
  });

  it("every rule read door is classified, and matches its audience", () => {
    const src = read("routers/skills.ts");

    // Procedure declarations, in source order: `  listRules: protectedProcedure`
    const procs = [
      ...src.matchAll(/^  (\w+):\s*(?:protected|workspace|public)Procedure/gm),
    ].map((m) => ({ name: m[1], at: m.index ?? 0 }));
    expect(
      procs.length,
      "No tRPC procedures parsed out of skills.ts — the declaration shape " +
        "changed and this scan is measuring nothing."
    ).toBeGreaterThan(5);

    const unclassified: string[] = [];
    const wrong: string[] = [];
    let checked = 0;

    for (const call of visibleSkillsWhereCalls(src)) {
      const { at } = call;
      // Nearest procedure declared ABOVE this call site.
      const owner = procs.filter((pr) => pr.at < at).pop();
      if (!owner) continue;
      const audience = PROCEDURE_AUDIENCE[owner.name];
      if (!audience) {
        unclassified.push(owner.name);
        continue;
      }
      checked += 1;
      const waives = /includeExpired:\s*true/.test(call.text);
      if (audience === "agent" && waives) {
        wrong.push(
          `${owner.name}: AGENT-facing but waives expiry — a lapsed standing ` +
            `permission would reach a model prompt.`
        );
      }
      if (audience === "owner" && !waives) {
        wrong.push(
          `${owner.name}: OWNER-facing but enforces expiry — an expired rule ` +
            `becomes a ghost its owner cannot see, renew or delete.`
        );
      }
    }

    expect(
      checked,
      "Zero classified call sites were checked — the call regex or the " +
        "procedure regex broke, and this test would pass on anything."
    ).toBeGreaterThanOrEqual(4);

    expect(
      unclassified,
      "These procedures read skills through `visibleSkillsWhere` but declare " +
        "no audience. Add each to PROCEDURE_AUDIENCE — a rule door must say " +
        "whether it serves an AGENT (enforce) or the OWNER (waive); there is " +
        "no safe default, which is exactly how the ghost shipped:\n  " +
        unclassified.join("\n  ")
    ).toEqual([]);

    expect(wrong, wrong.join("\n  ")).toEqual([]);
  });
});
