import { describe, expect, it } from "vitest";
import { isRuleSkill } from "../../../../lib/rule-skill";
import { toolCounts, toolItems, type SkillLike } from "./tools-model";
import { rulesOf } from "../../rules/_lib/rules-model";

/**
 * A rule shows under Rules, never under Tools (founder, 19 Nov 2026,
 * document b387ca45 §9). The defect this guards: `rules/ui-rules`, a plain
 * instruction skill in the `rules/` namespace with no `metadata.rule`, was
 * listed as a Tool, because the Tools list knew a rule only by
 * `metadata.rule`.
 *
 * Driven through the real list builders (`toolItems`, `rulesOf`) from rows
 * shaped as `skills.list` returns them, so the assertion is on what the page
 * DRAWS, not on the predicate alone. Not covered, measured: a rule whose row
 * carries none of the three marks (category, `metadata.rule`, a `rules/` slug)
 * cannot be told from a skill, and is listed as one.
 */

function skill(over: Partial<SkillLike> & { id: string }): SkillLike {
  return {
    name: over.id,
    kind: "instruction",
    approved: true,
    scope: "pod",
    workspaceId: null,
    slug: null,
    metadata: {},
    category: null,
    ...over,
  };
}

const RULES = [
  // The one the founder saw as a "Tool": no category, no metadata.rule.
  skill({ id: "ui-rules", slug: "rules/ui-rules" }),
  skill({ id: "category-rule", category: "rule" }),
  skill({
    id: "loop-rule",
    category: "rule",
    metadata: { rule: { intent: "Always title in one phrase" } },
  }),
  skill({ id: "metadata-only", metadata: { rule: { intent: "x" } } }),
];
const SKILLS = [
  skill({ id: "how-to-write", slug: "house/writing" }),
  skill({ id: "a-rules-word", slug: "playbooks/rules-of-thumb" }),
  skill({ id: "code-skill", kind: "code", slug: "tools/scrape" }),
];

const listed = (skills: readonly SkillLike[]) =>
  toolItems({ compositions: null, cards: null, skills }).map((i) => i.id);

describe("a rule is never a Tool", () => {
  it("no rule reaches the Tools list, whichever mark it carries", () => {
    const ids = listed([...RULES, ...SKILLS]);
    for (const r of RULES) expect(ids, r.id).not.toContain(r.id);
  });

  it("every skill still does (the scan is not vacuous)", () => {
    expect(listed([...RULES, ...SKILLS])).toEqual(
      expect.arrayContaining(SKILLS.map((s) => s.id))
    );
    expect(listed(SKILLS)).toHaveLength(SKILLS.length);
  });

  it("the Instructions count leaves rules out", () => {
    const items = toolItems({
      compositions: null,
      cards: null,
      skills: [...RULES, ...SKILLS],
    });
    expect(toolCounts(items, "").instructions).toBe(2);
  });

  it("every rule reaches the Rules list instead, and no skill does", () => {
    const ids = rulesOf([...RULES, ...SKILLS]).map((r) => r.id);
    expect(ids.sort()).toEqual(RULES.map((r) => r.id).sort());
  });

  it("a slug that only mentions rules is not one", () => {
    expect(isRuleSkill({ slug: "playbooks/rules-of-thumb" })).toBe(false);
    expect(isRuleSkill({ slug: " rules/x" })).toBe(true);
  });
});
