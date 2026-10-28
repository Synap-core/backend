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
 *   3. No person reviewed it, an agent wrote it, and it is CODE THAT REACHES
 *      NOTHING outside the pod (founder, 2026-10-28): a `code` skill run in
 *      the pod's sandbox (not a box script, which runs on the person's
 *      computer) with no egress `allowedHosts`, no declared tools
 *      (`requires`) and no `callProvider(` call, literal or not. Read through
 *      `skillReach` (`services/proposals/part-reach.ts`), the reader the
 *      review's "Can reach" uses, so "born on" and "Can reach: nothing
 *      outside your pod" are one decision.
 *
 * Anything else is born UNAPPROVED: anything that executes, whatever its
 * `kind` says, that no person reviewed, and anything an agent authored that
 * no person approved — instruction prose lands in a future agent's system
 * prompt, so it is a prompt-injection vector exactly as code is an execution
 * one. That includes an agent create a governance rule made `auto`: the gate
 * grants it and the door inserts with the agent's id, so no person reviewed it.
 * Such a skill gets ONE "turn this on?" request for the person
 * (`requestAgentSkillTurnOn`), so it never sits off unseen.
 *
 * Shared by `insertSkillGoverned`, the `skills.create` direct path and the
 * `skill/create` executor: they must agree, or one of them becomes the bypass
 * the governed door exists to prevent.
 */
import { getActingAgentUserId } from "@synap/database";
import { skillRequestExecutes } from "@synap-core/types/proposals";
import { skillReach } from "../proposals/part-reach.js";

/** What the born-approved rule reads of a skill being created. */
export interface SkillBornApprovedInput {
  kind: string | null | undefined;
  code: string | null | undefined;
  providerSpec: unknown;
  agentUserId: string | null | undefined;
  /** A person (no agent anywhere on the request) approved the create proposal. */
  personApprovedProposal?: boolean;
  /** `box` = a script run on the person's computer, never "reaches nothing". */
  executionMode: string | null | undefined;
  /** The row's metadata bag: its sandbox egress list (`allowedHosts`). */
  metadata: unknown;
  /**
   * The tools the create DECLARES it calls (`requires`), ids or names. Passed
   * in, never read from links: every door writes those edges AFTER the
   * insert. Required, so no door can forget the tools it declares.
   */
  requiredTools: readonly string[];
}

/**
 * Rule 3: an agent's code skill that reaches nothing outside the pod. Box
 * scripts are never covered (they run elsewhere); neither is anything carrying
 * a provider spec. One reader, `skillReach`: no host, no connection (declared
 * tools or a written-out `callProvider`), no call it could not read.
 */
export function codeReachesNothingOutsidePod(
  input: Omit<SkillBornApprovedInput, "agentUserId" | "personApprovedProposal">
): boolean {
  if (input.kind !== "code" || input.executionMode === "box") return false;
  if (input.providerSpec && typeof input.providerSpec === "object") {
    return false;
  }
  const reach = skillReach({
    kind: "code",
    code: input.code,
    metadata: input.metadata,
    requiredTools: input.requiredTools,
  });
  return (
    reach !== null &&
    reach.hosts.length === 0 &&
    reach.connections.length === 0 &&
    reach.unreadSteps === 0
  );
}

export function skillBornApproved(input: SkillBornApprovedInput): boolean {
  if (input.personApprovedProposal) return true;
  if (!input.agentUserId) {
    return input.kind === "instruction" && !skillRequestExecutes(input);
  }
  return codeReachesNothingOutsidePod(input);
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
