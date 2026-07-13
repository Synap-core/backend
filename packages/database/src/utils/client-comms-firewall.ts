/**
 * client-comms firewall predicate — the ONE pure test for "is this channel a
 * client-comms firewall target" (a conversation surface that bridges OUTWARD to
 * an external party / client). Autonomous AI/agent output must NEVER reach such a
 * channel.
 *
 * Extracted so the TWO backend fail-closed enforcement points share ONE predicate
 * and can never drift:
 *   - `delivery-router.ts` → `deliverToExternal` (routeSignal → external send).
 *   - `mirror-to-external.ts` → `mirrorMessageToBoundExternal` (auto-mirror enqueue).
 *
 * Two cases are firewall targets (this reproduces the original inline
 * delivery-router predicate EXACTLY — behavior-preserving):
 *   1. branchPurpose === 'client-comms' — the explicit firewall role.
 *   2. an EXTERNAL channel BOUND to a subject entity (contextObjectId set) that is
 *      NOT explicitly marked 'team'. Link-at-birth binds inbound client DMs to
 *      their entity, so a bound external channel IS a conversation with that party
 *      unless an operator opts it in by labelling it 'team' (reversible). Unbound
 *      external channels (contextObjectId null, e.g. a team feed) are NOT targets.
 *
 * PURE over channel fields — no DB, no I/O — so it lives in the shared `database`
 * layer and is importable by `api` (dep graph: api → database).
 */
export function isClientCommsFirewallTarget(channel: {
  branchPurpose: string | null;
  contextObjectId: string | null;
}): boolean {
  if (channel.branchPurpose === "client-comms") return true;
  const isEntityBoundExternal =
    channel.contextObjectId != null && channel.branchPurpose !== "team";
  return isEntityBoundExternal;
}
