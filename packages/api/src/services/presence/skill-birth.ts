/**
 * A skill a PERSON's door would create already ON (W3 slice 3, founder
 * decision 1: "a skill born approved"). Today that is a person's instruction
 * skill (`skillBornApproved` rule 2). Turning a skill on is a sensitive act,
 * so it is born on only with a proof of presence for `skill:new:<name>`:
 *  - a proof checks out → born ON;
 *  - `report` mode, no proof → born ON, and `presence.missing` is recorded;
 *  - `enforce`, no proof → born OFF (the create still lands; the person turns
 *    it on with a proof through `skills.setApproved`);
 *  - a proof that is sent and fails → the create is refused.
 * An agent's skill and a skill a person approved in a proposal are decided
 * elsewhere (rule 3, the `skill/create` executor): no person acts here.
 */
import type { PresenceProof } from "@synap-core/types/presence";
import { PRESENCE_REQUIRED } from "@synap-core/types/presence";
import { TRPCError } from "@trpc/server";
import { assertPresenceForRequest } from "./gate.js";

/** The challenge id of a skill not created yet: `new:<name>`. */
export function newSkillPresenceId(name: string): string {
  return `new:${name}`;
}

export async function personSkillBornOn(args: {
  userId: string;
  name: string;
  proof?: PresenceProof | null;
  door: string;
}): Promise<boolean> {
  try {
    await assertPresenceForRequest({
      userId: args.userId,
      kind: "skill",
      id: newSkillPresenceId(args.name),
      proof: args.proof ?? null,
      door: args.door,
    });
    return true;
  } catch (err) {
    const code =
      err instanceof TRPCError
        ? (err.cause as { reasonCode?: unknown } | undefined)?.reasonCode
        : undefined;
    if (code === PRESENCE_REQUIRED) return false;
    throw err;
  }
}

/**
 * `skillBornApproved`'s answer for a door where a PERSON acts unless
 * `agentUserId` names an agent: an ON birth goes through `personSkillBornOn`.
 */
export async function bornOnUnlessUnproved(
  bornOn: boolean,
  agentUserId: string | null | undefined,
  args: Parameters<typeof personSkillBornOn>[0]
): Promise<boolean> {
  if (!bornOn || agentUserId) return bornOn;
  return personSkillBornOn(args);
}
