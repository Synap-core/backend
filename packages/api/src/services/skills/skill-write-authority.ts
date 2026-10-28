/**
 * Who may publish or change a skill that reaches OTHER people's agents.
 *
 * A pod-scope skill is visible to every user on the pod (`visibleSkillsWhere`),
 * and an `instruction` skill's body is injected verbatim into agents' system
 * prompts. Before this rule (audit 2026-10-28 F6) any signed-in pod user —
 * a viewer of one space included — could rewrite any pod-scope skill through
 * `skills.update` and it stayed approved, because the lookup admitted
 * `scope = pod OR userId = me` and the approval reset fired for agents only.
 *
 * THE RULE: the skill's author may change it; anyone else needs the SAME
 * authority that can approve it (`setSkillApproved`): the space's owner for a
 * skill bound to a space, a pod admin for a pod-wide one. Publishing a new
 * pod-scope skill needs that authority too; without it a skill is the
 * author's own (`scope: "user"`).
 */
import { TRPCError } from "@trpc/server";
import { getWorkspaceRole, isPodAdmin } from "../../utils/workspace-role.js";

/** The approval authority for a skill at this reach (see `setSkillApproved`). */
export async function holdsSkillAuthority(
  userId: string,
  reach: { workspaceId: string | null | undefined }
): Promise<boolean> {
  if (reach.workspaceId) {
    return (await getWorkspaceRole(userId, reach.workspaceId)) === "owner";
  }
  return isPodAdmin(userId);
}

export const SKILL_AUTHORITY_MESSAGE =
  "Only the skill's author, or a pod admin (the space's owner for a space skill), can change a skill other people's agents load.";

export const POD_SKILL_PUBLISH_MESSAGE =
  "Only a pod admin (the space's owner for a space skill) can publish a pod-wide skill. Save it as your own skill (scope: user).";

/**
 * Refuse a change to a skill the caller did not author unless they hold its
 * approval authority. The caller's `userId` is the person (an agent key is
 * remapped to its human), so an agent acting for the author still passes and
 * stays governed by `checkPermissionOrPropose`.
 */
export async function assertMayChangeSkill(
  userId: string,
  skill: { userId: string | null; workspaceId: string | null }
): Promise<void> {
  if (skill.userId === userId) return;
  if (await holdsSkillAuthority(userId, skill)) return;
  throw new TRPCError({ code: "FORBIDDEN", message: SKILL_AUTHORITY_MESSAGE });
}

/**
 * The scope a new skill lands in when the caller names none: pod-wide for a
 * caller with the authority, the caller's own otherwise.
 */
export async function defaultSkillScope(
  userId: string,
  workspaceId: string | null | undefined
): Promise<"pod" | "user"> {
  return (await holdsSkillAuthority(userId, { workspaceId })) ? "pod" : "user";
}
