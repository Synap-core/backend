/**
 * Slugs a skill-create door must refuse, because `synap_load_skill` would
 * resolve a seeded system ref to them.
 *
 * `system/` is the seeded teaching namespace (`ensure-system-skills.ts`:
 * `system/<package>/<stem>`), and its stems are the refs every session's
 * always-on instructions point at ("see `writes.md`"). A pod skill at
 * `system/…`, or named after a system stem (`writes`, `synap/writes`), is
 * either a shadow of that text for every agent or an unreachable duplicate.
 * The resolver already ranks `system/*` first; this refuses the row at the door
 * so neither happens.
 */
import { db, drizzleSql } from "@synap/database";
import { skills } from "@synap/database/schema";
import { escapeLike } from "../../utils/term-match.js";

export interface ReservedSkillSlug {
  code: "system_namespace_reserved" | "system_stem_collision";
  message: string;
}

export async function reservedSkillSlugReason(
  slug: string
): Promise<ReservedSkillSlug | null> {
  const normalized = slug.trim().toLowerCase().replace(/\.md$/, "");
  if (normalized.startsWith("system/")) {
    return {
      code: "system_namespace_reserved",
      message: "The 'system/' slug namespace is reserved for seeded skills.",
    };
  }
  const [seeded] = await db
    .select({ slug: skills.slug })
    .from(skills)
    .where(
      drizzleSql`(${skills.slug} = ${`system/${normalized}`} OR ${skills.slug} LIKE ${`system/%/${escapeLike(normalized)}`} ESCAPE '\\')`
    )
    .limit(1);
  if (!seeded) return null;
  return {
    code: "system_stem_collision",
    message: `Slug "${slug}" names the seeded skill "${seeded.slug}", which synap_load_skill resolves that ref to. Use a namespaced slug such as "team/${normalized}".`,
  };
}
