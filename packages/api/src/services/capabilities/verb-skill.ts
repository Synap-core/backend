/**
 * WHICH SKILL ANSWERS A VERB — the run door's rule, in one place.
 *
 * A capability verb is the NAME of the skill that backs it. `executeCapability`
 * resolves it for a caller among the skills that caller can see in the lens
 * (`visibleSkillsWhere`) and that are active; when several share the name, an
 * approved one wins, then the most recently updated (a fresh re-apply beats a
 * stale shadow). The review of an automation reads what each step can reach
 * through the SAME rule (`proposals/part-reach.ts`), so it names the skill the
 * run would call, never a guess.
 */

import { skills, eq, and, desc } from "@synap/database";
import { visibleSkillsWhere } from "../skills/visibility.js";

/** The skills that may answer a verb for `userId` in this lens. */
export function answeringSkillsWhere(
  userId: string,
  workspaceId: string | null
) {
  return and(
    visibleSkillsWhere(userId, workspaceId ?? undefined),
    eq(skills.status, "active")
  );
}

/** Among several answering skills of one name: approved first, then newest. */
export const ANSWERING_SKILL_ORDER = [
  desc(skills.approved),
  desc(skills.updatedAt),
] as const;
