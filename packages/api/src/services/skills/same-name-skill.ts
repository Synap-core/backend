/**
 * The skill already holding `name` in the scope a new skill would land in, if
 * any — read by `synap_create_skill` before it files a create (ticket
 * 01fc187c). An agent fixing a code skill called create again under the same
 * name: the pod then held two `instagram.score_handle`, `run_capability` by
 * name could pick either, and nothing retired the old one.
 *
 * "In scope" is what an agent working there can see — the same three-tier
 * `visibleSkillsWhere` lens the run and load doors read — so a twin it would
 * be ambiguous with is found, and another member's private skill is not.
 * Rules are skills rows too but have their own door (`synap_create_rule`) and
 * are never run by name, so they are left out.
 */
import { and, db, eq, ne, or, isNull } from "@synap/database";
import { skills } from "@synap/database/schema";
import { visibleSkillsWhere } from "./visibility.js";

export async function sameNameSkill(params: {
  userId: string;
  name: string;
  workspaceId?: string;
}): Promise<{ id: string; name: string; slug: string | null } | null> {
  const [row] = await db
    .select({ id: skills.id, name: skills.name, slug: skills.slug })
    .from(skills)
    .where(
      and(
        eq(skills.name, params.name),
        or(isNull(skills.category), ne(skills.category, "rule")),
        visibleSkillsWhere(params.userId, params.workspaceId, {
          includeExpired: true,
        })
      )
    )
    .limit(1);
  return row ?? null;
}
