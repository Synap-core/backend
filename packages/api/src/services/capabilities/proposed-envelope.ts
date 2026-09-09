/**
 * "QUEUED FOR REVIEW, NOT PERFORMED" — the ONE predicate.
 *
 * A governed write that the permission gate routed to a human returns a SUCCESS
 * envelope: the call did not fail, it just did not do the thing. Every caller
 * that draws a conclusion from a successful run ("stamp proven_at", "report
 * done", "advance the flow") has to be able to tell that outcome apart, and
 * getting it wrong is not a cosmetic error — `skills.proven_at` is floored on
 * `IS NULL`, so a single wrong stamp is PERMANENT and no later real run can
 * correct it.
 *
 * TWO SPELLINGS EXIST, AND THAT IS A FACT ABOUT THE CODEBASE, NOT A CHOICE:
 *
 *   `{ proposed: true, proposalId }`     — the CAPABILITY-layer envelope
 *       (`executeProviderVerb`, `run-skill-in-sandbox`, `capabilities-execute`,
 *       `automation-governance`, `external-dispatch`). Matches the Hub wire
 *       type `ExecuteCapabilityResult` (`hub-rest-client/src/types.ts`).
 *
 *   `{ status: "proposed", proposalId }` — the tRPC ROUTER envelope, returned by
 *       every governed router mutation (`entities/create.ts`, `skills.ts`,
 *       `projects.ts`, `tools.ts`, `playbooks.ts`, …). Builtin verbs call those
 *       routers through `createCaller` and surface the result VERBATIM
 *       (`builtin-verbs.ts`), so this spelling reaches capability callers too.
 *
 * WHY THIS FILE EXISTS. `outcomeDidTheWork` in `execute-capability.ts` knew only
 * the first spelling while the builtin branch returns `kind:"run"`
 * unconditionally — so an agent's `entity.create` routed to review stamped
 * `proven_at` on a capability that had never run. That is verbatim the case the
 * column's own schema comment forbids. A predicate that enumerates spellings at
 * one call site is how the second one got missed; this one is enumerated ONCE,
 * beside the type that names the contract, and bound to it by a compile-time
 * floor so a THIRD spelling cannot silently re-open the hole.
 */

/**
 * Every envelope shape that means "routed to review — the effect did NOT
 * happen". Adding a member here without adding its discriminator below is a
 * BUILD ERROR (see the floor at the bottom of this file).
 *
 * `proposalId` is optional on purpose: `channel.send` spreads it conditionally,
 * so a proposed envelope missing the id is a real (if degraded) shape and must
 * still be recognised as proposed. Recognition keys on the DISCRIMINATOR, never
 * on the presence of an id.
 */
export type ProposedEnvelope =
  | { proposed: true; proposalId?: string }
  | { status: "proposed"; proposalId?: string };

/**
 * The discriminators, as DATA. The runtime predicate iterates this table and
 * the compile-time floor is derived from it, so the check and the claim cannot
 * drift apart the way a hand-written `||` chain did.
 */
const PROPOSED_DISCRIMINATORS = [
  { key: "proposed", value: true },
  { key: "status", value: "proposed" },
] as const;

/** The union of `{key: value}` shapes the table above can recognise. */
type DiscriminatorShapes = {
  [I in keyof typeof PROPOSED_DISCRIMINATORS]: {
    [
      K in (typeof PROPOSED_DISCRIMINATORS)[I]["key"]
    ]: (typeof PROPOSED_DISCRIMINATORS)[I]["value"];
  };
}[number];

/**
 * COMPILE-TIME COVERAGE FLOOR (the `PROJECTED_OWED_SLOT_FIELDS` /
 * `SERVER_OWNED_OUTPUT_FIELDS` idiom). A member added to `ProposedEnvelope`
 * that no discriminator can match makes this alias `never` and stops the build
 * — instead of shipping a predicate that silently returns `false` for it and
 * stamps a permanent lie.
 */
type _EveryProposedShapeIsDiscriminated =
  ProposedEnvelope extends DiscriminatorShapes ? true : never;
const _everyProposedShapeIsDiscriminated: _EveryProposedShapeIsDiscriminated = true;
void _everyProposedShapeIsDiscriminated;

/**
 * Did this result announce that the write was QUEUED rather than performed?
 *
 * Deliberately structural, not `instanceof`/branded: these envelopes cross the
 * `unknown` boundary of a capability result and arrive as plain JSON from a
 * router caller, a provider verb, or the IS sandbox.
 */
export function isProposedEnvelope(
  result: unknown
): result is ProposedEnvelope {
  if (!result || typeof result !== "object") return false;
  const record = result as Record<string, unknown>;
  return PROPOSED_DISCRIMINATORS.some((d) => record[d.key] === d.value);
}
