/**
 * THE born-approved rule: whether a skill row starts approved (may run, or
 * load as an agent tool) the moment it is made. Two ways, and only two:
 *
 *   1. A PERSON approved its `skill/create` proposal. That review shows the
 *      skill's whole code or body, so the click IS the owner's OK: the skill
 *      lands approved and runs, with no second "enable" step (founder
 *      decision 2, 2026-10-25). The `skill/create` executor applies it through
 *      `setSkillApproved`, the one enable door.
 *   2. No person reviewed it, and it is an `instruction` skill (prompt-only, no
 *      side effects) installed by a trusted human (no `agentUserId`).
 *
 * Anything else is born UNAPPROVED: executable code (`code`/`declarative`) no
 * person reviewed, and anything an agent authored that no person approved —
 * instruction prose lands in a future agent's system prompt, so it is a
 * prompt-injection vector exactly as code is an execution one. That includes
 * an agent create a governance rule made `auto`: the gate grants it and the
 * door inserts with the agent's id, so no person reviewed it.
 *
 * Shared by `insertSkillGoverned`, the `skills.create` direct path and the
 * `skill/create` executor: they must agree, or one of them becomes the bypass
 * the governed door exists to prevent.
 */
export function skillBornApproved(input: {
  kind: string | null | undefined;
  agentUserId: string | null | undefined;
  /** A person (no agent anywhere on the request) approved the create proposal. */
  personApprovedProposal?: boolean;
}): boolean {
  return input.kind === "instruction" && !input.agentUserId;
}
