/**
 * Canonical skill visibility predicate.
 *
 * Keep every read surface on the same three-tier contract:
 * pod skills are shared, user skills belong to their owner, and workspace
 * skills require both the selected workspace and a live membership.
 */
import { and, eq, or, type SQL } from "@synap/database";
import { skills } from "@synap/database/schema";
import { userVisibleWhere } from "../../utils/user-visible-where.js";

export function visibleSkillsWhere(userId: string, workspaceId?: string): SQL {
  if (!workspaceId) {
    return or(
      eq(skills.scope, "pod"),
      and(eq(skills.scope, "user"), eq(skills.userId, userId))
    )!;
  }

  return or(
    eq(skills.scope, "pod"),
    and(eq(skills.scope, "user"), eq(skills.userId, userId)),
    and(
      eq(skills.scope, "workspace"),
      eq(skills.workspaceId, workspaceId),
      userVisibleWhere(skills.workspaceId, userId)
    )
  )!;
}
