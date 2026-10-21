/**
 * `librarySkillSlug` (decision B9f) — the slug a Library Build gives the skill
 * it makes for one import group. It must be a slug the ONE authoring rule
 * accepts (so `synap_load_skill` can be pointed at it and `skills.create`
 * would take it), pod-unique across imports, and must step around a slug an
 * undone Build left behind instead of colliding on `idx_skills_slug`.
 */
import { describe, it, expect } from "vitest";
import { librarySkillSlug, skillSlugProblem } from "../skill-authoring.js";

const SESSION = "3F2A9C1E-0B7D-4E21-9A55-6C0D1E2F3A4B";

describe("librarySkillSlug", () => {
  it("is library/<import>/<group>, lowercase, and a slug the authoring rule accepts", () => {
    const slug = librarySkillSlug(SESSION, "baking");
    expect(slug).toBe(`library/${SESSION.toLowerCase()}/baking`);
    expect(skillSlugProblem(slug)).toBeNull();
  });

  it("two imports with the same group key get different slugs", () => {
    expect(librarySkillSlug("a1", "baking")).not.toBe(
      librarySkillSlug("b2", "baking")
    );
  });

  it("a taken slug gets the first free -N suffix", () => {
    const base = librarySkillSlug(SESSION, "baking");
    expect(librarySkillSlug(SESSION, "baking", [base])).toBe(`${base}-2`);
    expect(
      librarySkillSlug(SESSION, "baking", [base, `${base}-2`, `${base}-4`])
    ).toBe(`${base}-3`);
    expect(skillSlugProblem(`${base}-3`)).toBeNull();
  });

  it("a group key outside the slug alphabet is folded into it, never refused later", () => {
    const slug = librarySkillSlug(SESSION, "Pâte  à pain!");
    expect(skillSlugProblem(slug)).toBeNull();
  });
});
