import { describe, expect, it } from "vitest";
import { buildObjectActionTitle } from "../vocabulary/index.js";
import {
  isRuleSkill,
  skillObjectKind,
  skillTitleName,
  RULE_CATEGORY,
} from "./index.js";

/**
 * The one rule predicate and what a rule is called by. The title these feed
 * is the founder's review line for a rule edit (proposal 0a641510 read
 * "Update Tool" for an edit of `rules/work-units`).
 */
describe("isRuleSkill / skillObjectKind", () => {
  it("any of the three marks makes a rule", () => {
    expect(isRuleSkill({ category: RULE_CATEGORY })).toBe(true);
    expect(isRuleSkill({ metadata: { rule: { intent: "x" } } })).toBe(true);
    expect(isRuleSkill({ slug: " rules/x" })).toBe(true);
    expect(skillObjectKind({ slug: "rules/work-units" })).toBe("rule");
  });

  it("none of them: a skill (a Tool)", () => {
    expect(isRuleSkill({ slug: "playbooks/rules-of-thumb" })).toBe(false);
    expect(isRuleSkill({ metadata: { rule: null }, category: "crm" })).toBe(
      false
    );
    expect(skillObjectKind({ slug: "house-style" })).toBe("skill");
  });
});

describe("skillTitleName", () => {
  it("a `rules/` ref names the rule, not its machine-token name", () => {
    expect(
      skillTitleName({ slug: "rules/work-units", name: "rules_work_units" })
    ).toBe("work-units");
  });

  it("any other skill, or a bare `rules/`: its name", () => {
    expect(skillTitleName({ slug: "house-style", name: "House style" })).toBe(
      "House style"
    );
    expect(skillTitleName({ slug: "rules/", name: "Rules" })).toBe("Rules");
    expect(skillTitleName({ name: "  " })).toBeUndefined();
  });

  it("composes through the title door into the line the founder reviews", () => {
    const rule = { slug: "rules/work-units", name: "rules_work_units" };
    expect(
      buildObjectActionTitle({
        action: "update",
        objectKind: skillObjectKind(rule),
        objectName: skillTitleName(rule),
        locale: "en",
      })
    ).toBe('Update Rule "work-units"');
  });
});
