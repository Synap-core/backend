/**
 * The grant rung for a write door whose governance gate only runs for an
 * AGENT (`if (agentUserId) { checkPermissionOrPropose(...) }`) or that refuses
 * agents outright ("only the person can …"). A key that is NOT an agent skips
 * that branch — and with it the grant, which is only enforced inside the gate.
 * Calling this before the branch bounds every key by its grant, whoever holds it.
 *
 * A no-op when the request carries no grant (a signed-in session). The request
 * key is derived from the same `{subjectType, action}` the gate would use
 * (`grantWriteDenial`, folded by `grantRequestKey`). Refuses — never proposes:
 * a reviewer approving a write the key was never allowed to make would widen it.
 *
 * Tripwire: `__tripwires__/agent-only-gates-check-the-grant.test.ts`.
 */

import { TRPCError } from "@trpc/server";
import { grantWriteDenial, type GrantWriteInput } from "./grant-write-check.js";

export async function assertKeyMayWrite(input: GrantWriteInput): Promise<void> {
  const denial = await grantWriteDenial(input);
  if (denial) throw new TRPCError({ code: "FORBIDDEN", message: denial });
}
