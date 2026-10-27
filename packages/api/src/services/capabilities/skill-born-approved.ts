/**
 * THE born-approved rule: whether a skill row starts approved (may run, or
 * load as an agent tool) the moment it is made. Two ways, and only two:
 *
 *   1. A PERSON approved its `skill/create` proposal. That review shows the
 *      skill's whole code or body, so the click IS the owner's OK: the skill
 *      lands approved and runs, with no second "enable" step (the
 *      one-approval rule). The `skill/create` executor applies it through
 *      `setSkillApproved`, the one enable door.
 *   2. No person reviewed it, and it is prose only (an `instruction` skill
 *      carrying no code and no provider spec, `skillRequestExecutes`)
 *      installed by a trusted human (no `agentUserId`).
 *
 * Anything else is born UNAPPROVED: anything that executes, whatever its
 * `kind` says, that no person reviewed, and anything an agent authored that
 * no person approved — instruction prose lands in a future agent's system
 * prompt, so it is a prompt-injection vector exactly as code is an execution
 * one. That includes an agent create a governance rule made `auto`: the gate
 * grants it and the door inserts with the agent's id, so no person reviewed it.
 *
 * Shared by `insertSkillGoverned`, the `skills.create` direct path and the
 * `skill/create` executor: they must agree, or one of them becomes the bypass
 * the governed door exists to prevent.
 */
import { getActingAgentUserId } from "@synap/database";
import { skillRequestExecutes } from "@synap-core/types/proposals";

export function skillBornApproved(input: {
  kind: string | null | undefined;
  code: string | null | undefined;
  providerSpec: unknown;
  agentUserId: string | null | undefined;
  /** A person (no agent anywhere on the request) approved the create proposal. */
  personApprovedProposal?: boolean;
}): boolean {
  if (input.personApprovedProposal) return true;
  return (
    input.kind === "instruction" &&
    !skillRequestExecutes(input) &&
    !input.agentUserId
  );
}

/**
 * Whether a PERSON is approving: no agent on the request (`ctx.agentUserId`),
 * none in the ambient scope, and the approver is not an agent principal. The
 * one reading of "a person approved" rule 1 above trusts; an agent travelling
 * behind a person's session never earns the one-approval enable.
 */
export async function personIsApproving(
  ctx: { agentUserId?: string | null } | null | undefined,
  userId: string
): Promise<boolean> {
  if (ctx?.agentUserId || getActingAgentUserId()) return false;
  // Dynamic: the review ladder's module graph stays out of the skill doors'.
  const { isAgentPrincipal } =
    await import("../../routers/proposals/review-authority.js");
  return !(await isAgentPrincipal(userId));
}
