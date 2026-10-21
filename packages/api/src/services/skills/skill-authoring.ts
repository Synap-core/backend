/**
 * THE authoring rule for a new skill — what makes it REACHABLE — shared by
 * every door that creates one: MCP `synap_create_skill`, Hub REST
 * `POST /skills`, tRPC `skills.create` (the slug shape) and a capture plan's
 * `skills[]` step.
 *
 * A skill is documentation (`body`) plus optional `code`. A documentation-only
 * (teaching) skill is found by `synap_load_skill` BY SLUG ONLY
 * (`resolveSkillContent`), so without a slug it is authored but unreachable.
 * Capture used to create exactly that and report it `applied` (feedback
 * d23a3888): the skill existed, nothing could load it.
 *
 * Pure (no db) so the capture plan validator can run it before anything is
 * filed. Pod-wide slug uniqueness is NOT checked here: the unique index
 * `idx_skills_slug` refuses a taken slug at insert.
 */

/** Lowercase path segments, e.g. `biz/business-plan`. */
export const SKILL_SLUG_PATTERN =
  /^[a-z0-9]+(?:[-_.][a-z0-9]+)*(?:\/[a-z0-9]+(?:[-_.][a-z0-9]+)*)*$/;
export const SKILL_SLUG_PATTERN_MESSAGE =
  "slug must be lowercase path segments, e.g. 'biz/business-plan'";
/** `system/` is the seeded namespace; a user row there would shadow a seeded skill. */
export const SKILL_SLUG_SYSTEM_MESSAGE =
  "the 'system/' slug namespace is reserved for seeded skills";

const NEEDS_DOCS_OR_CODE =
  "a skill needs documentation or code — pass `body` (Markdown) to author a teaching skill, `code` to author a runnable one, or both.";
const NEEDS_SLUG =
  "slug is required for a documentation-only skill — it is the ref synap_load_skill resolves (e.g. 'biz/business-plan'). Without one the skill is authored but unreachable.";

/** Why `slug` is not a valid skill slug, or null. */
export function skillSlugProblem(slug: string): string | null {
  if (!SKILL_SLUG_PATTERN.test(slug)) return SKILL_SLUG_PATTERN_MESSAGE;
  if (slug.startsWith("system/")) return SKILL_SLUG_SYSTEM_MESSAGE;
  return null;
}

/**
 * Why a new skill with these fields would be unusable, or null. Blank strings
 * count as absent.
 */
export function skillAuthoringProblem(input: {
  body?: string | null;
  code?: string | null;
  slug?: string | null;
}): string | null {
  const hasBody = !!input.body?.trim();
  const hasCode = !!input.code?.trim();
  const slug = input.slug?.trim();
  if (!hasBody && !hasCode) return NEEDS_DOCS_OR_CODE;
  if (!hasCode && !slug) return NEEDS_SLUG;
  return slug ? skillSlugProblem(slug) : null;
}
