/**
 * Proposal CLASS — what kind of decision a proposal is, and therefore how long
 * it stays answerable.
 *
 * ── Why a static rule, not a classifier ─────────────────────────────────────
 * Derived ONLY from `proposalType` × `targetType` — never the payload, the
 * agent's prose, or a learned signal — so a human can read and predict it and
 * an agent cannot influence it. That last clause is a security property:
 * approval-fatigue exploitation works by engineering repetitive requests that
 * train reflexive approval, and an agent able to nominate its own class would
 * nominate the quiet one.
 *
 * ── Measured, 660 pending on the team pod, 2026-09-02 ───────────────────────
 *   ephemeral   441  capability.run     median age 11.7d, ZERO under 24h
 *   curatorial  143  merge (entity)     median 19.0d
 *   objectWork   69  create · import.graph · ai_edit
 *   governance    2  governance.*
 *   access        0  does not exist in the data yet — deliberately NOT a class
 *
 * ── Re-measured 2026-09-08: `access` now EXISTS, and is a class ─────────────
 * The 09-02 reading was correct when taken and was invalidated two days later
 * with nothing watching. On 2026-09-04 the founder's pod took its first one:
 * `{ proposalType: "join", targetType: "workspace" }` — "Agent Claude (Web)
 * requests to join workspace Builder as editor". It fell through to
 * `objectWork`, so an agent asking for EDITOR RIGHTS was filed beside a
 * proposed entity, indistinguishable from ordinary graph work. It has sat
 * unanswered since.
 *
 * The lesson is about the measurement, not the number: "0 instances ⇒ not a
 * class" is a reading of a MOMENT, and nothing re-read it. A class whose
 * population is zero because the door only just opened looks identical to one
 * that will stay empty forever.
 *
 * Why it earns a lane rather than a filter: an access decision is the
 * highest-consequence and lowest-volume item in the queue, and the only one
 * whose subject is WHO MAY ACT rather than WHAT IS TRUE. The data-write half of
 * governance has effectively self-resolved on that pod (38 of the last 40
 * writes auto-approved); the identity/permission half has not, and had no lane
 * to be seen in.
 */

/**
 * THE literal every capability-run proposal carries in `proposals.proposal_type`.
 *
 * Exported from here — the module that CLASSIFIES on it — because a private copy
 * next to each producer is exactly how this broke: `execute-capability.ts` wrote
 * `"capability.run"` while `routers/skills.ts` and `connectors/external-dispatch.ts`
 * wrote `"run"`, so skill runs and external-dispatch runs classified `objectWork`
 * and no sweeper could ever expire them. One exported constant, imported by every
 * producer and every reader, is the only shape in which they cannot drift.
 *
 * Reads keep working across the rename, but NOT because every spelling reaches
 * one executor — they don't. `resolve()` sends `capability/run` (the legacy
 * `targetType:"capability"` + `proposalType:"run"`) to the `capability/run`
 * executor, and `capability.run` to the proposalType-only `capability.run`
 * executor. What keeps both correct is that `capability.run` hands a TOOL-shaped
 * payload (`capabilityKind`, no `skillId`) to the same replay `capability/run`
 * uses. Until that hand-off existed, an approved tool run filed by the
 * tool-execute door threw "requires skillId" and never executed — while this
 * comment said otherwise. Pinned behaviourally by
 * `routers/proposals/__tests__/capability-run-tool-shape.test.ts`.
 *
 * This module imports NOTHING, so importing it can never create a cycle.
 */
export const CAPABILITY_RUN_PROPOSAL_TYPE = "capability.run";

/** The classes that exist in the data today. */
export const PROPOSAL_CLASSES = [
  "ephemeral",
  "curatorial",
  "objectWork",
  "governance",
  "access",
] as const;

export type ProposalClass = (typeof PROPOSAL_CLASSES)[number];

/**
 * The `${targetType}/${proposalType}` pairs whose approval changes WHO MAY ACT
 * — a membership, a role, a permission, a credential, or an exposure.
 *
 * Keyed on the PAIR, in the same `targetType/proposalType` shape as
 * `GOVERNED_WRITE_DOORS` (`@synap/governance-policy`), from which this set was
 * derived door-by-door. It is a LOCAL literal on purpose: this module imports
 * nothing, which is the property that lets every reader import it without a
 * cycle. The cost is that a new access door must be added here by hand; the
 * test below pins the pairs so the omission is at least visible, and an
 * omitted pair fails to `objectWork`, which never expires.
 *
 * The test for membership is not "is this sensitive" — `workspace/delete` is
 * far more destructive and is NOT here. It is "does approving this hand a
 * principal (a person, an agent, or the public) a right it did not have".
 */
const ACCESS_DOORS: ReadonlySet<string> = new Set([
  // Workspace membership. `workspace/join` is the live one: an agent that is
  // not yet a member files this instead of being hard-denied, and approving it
  // inserts the workspace_members row at the role the payload names.
  "workspace/join",
  // A2AI channel membership — an agent asking to join an open channel.
  "a2ai/join",
  // The human-side membership doors (routers/workspaces/invites.ts).
  "workspaceMember/add",
  "workspaceMember/remove",
  "workspaceMember/updateRole",
  // Project membership is a SCOPE CHANGE: it widens that user's read floor
  // across every workspace the project exposes (`exposureMemberWhere`).
  "projectMember/create",
  // Reserved-but-unbuilt in ADMIN_ACTIONS_RESERVED. Listed for the same reason
  // that list keeps them: a door that ships tomorrow inherits the lane on day
  // one rather than arriving classified as ordinary object work.
  "projectMember/remove",
  "projectMember/updateRole",
  // RBAC role definitions — the permission table itself.
  "role/create",
  "role/update",
  "role/delete",
  // API keys ARE credentials. `apiKey/update` is included even though it is
  // deliberately NOT admin-floored: whether a write must be proposed and what
  // lane it is reviewed IN are different questions, and every key write is an
  // access decision once it reaches a human.
  "apiKey/create",
  "apiKey/update",
  "apiKey/delete",
  // What an agent principal is permitted to do.
  "agent/updateCapabilities",
  // A capability granted to a running session — the same question, narrower
  // scope. NOT session-bound for expiry: see the lifetime note below.
  "focus_session/grant_capability",
  // A secret handed to an agent, with an access level and a TTL.
  "vault/vault.request",
  // Exposure rather than membership: this is the door that makes a workspace
  // projection readable by principals outside it, so it widens who may SEE.
  "workspace/configure_public_projection",
  // The same, one entity at a time: a `visible_to` edge makes the entity
  // readable by every member of the anchor (`exposureMemberWhere`). Filed under
  // its own verb by `relations.exposeToAnchor` precisely so this PAIR can name
  // it — `relation/create` stays objectWork, and nothing here reads the
  // relation `type` out of the payload.
  "relation/expose",
]);

/**
 * How long a class stays answerable once its context is gone, in hours.
 *
 * `null` = never expires. Only `ephemeral` has a lifetime, because only it has a
 * moment that passes: an agent's outbound call is urgent while its session is
 * live and worthless after. A merge candidate or a proposed entity is exactly as
 * reviewable next week as today.
 *
 * The BACKSTOP, not the mechanism — the real trigger is session close (OpenID
 * CIBA: terminate "when it knows the client is no longer interested"). 24h is
 * chosen to outlive a working day plus a night, so a run proposed at 6pm is
 * still answerable next morning; 158 of the 441 ephemeral rows carry no
 * session at all, so for those this is the ONLY trigger.
 */
export const CLASS_LIFETIME_HOURS: Record<ProposalClass, number | null> = {
  ephemeral: 24,
  curatorial: null,
  objectWork: null,
  governance: null,
  // NEVER. An access request that silently expires is strictly worse than one
  // that waits: the agent is still blocked either way, but the expiry deletes
  // the only record that anyone was ever asked. `null` also keeps it out of
  // `diesWithSession` (expire-lapsed-proposals.ts), whose first arm is exactly
  // "belongs to a class WITH a lifetime" — so closing the session an agent
  // asked from cannot retire the question of whether it may join at all.
  access: null,
};

/**
 * Classify a proposal. Total over the two columns — an unrecognised pair falls
 * to `objectWork`, the class with NO lifetime, so a proposal type this function
 * has not been taught can never be expired by accident. Failing closed here
 * means failing toward "keep it", which is the only safe direction.
 */
export function classifyProposal(
  proposalType: string,
  targetType: string
): ProposalClass {
  // A capability run is an outbound call bound to a live session. The literal
  // is `CAPABILITY_RUN_PROPOSAL_TYPE`, which every producer imports; a tripwire
  // scans EVERY `targetType: "capability"` proposal call site so the producers
  // and this table can never drift — they did once (three producers, two
  // literals), and the class table silently filed most runs as objectWork,
  // which never expires.
  if (
    proposalType === CAPABILITY_RUN_PROPOSAL_TYPE &&
    targetType === "capability"
  )
    return "ephemeral";
  // Governance meta-proposals are the policy lane, already rendered apart.
  // Checked BEFORE access so a `governance.widen_lane` — which does change who
  // may act — keeps the lane it already has. Widening a lane is a change to the
  // RULE; the access lane is a decision about one principal, one grant, once.
  if (proposalType.startsWith("governance.")) return "governance";
  // Who may act. Pair-keyed, exactly like every rule above it, so the security
  // property is unchanged: an agent can influence neither column.
  if (ACCESS_DOORS.has(`${targetType}/${proposalType}`)) return "access";
  // "Are these two records the same thing?" — unhurried, batched work.
  if (proposalType === "merge") return "curatorial";
  return "objectWork";
}

/** Convenience: the lifetime for a proposal, or null when it never expires. */
export function proposalLifetimeHours(
  proposalType: string,
  targetType: string
): number | null {
  return CLASS_LIFETIME_HOURS[classifyProposal(proposalType, targetType)];
}

/**
 * The two class-derived fields every READ door stamps onto a proposal row.
 *
 * Returned as a PAIR, and only as a pair, on purpose: `class` without
 * `lifetimeHours` forces a surface that wants to show the ephemeral countdown
 * to re-derive the lifetime from a table it does not own, which is how a second
 * (and eventually disagreeing) copy of `CLASS_LIFETIME_HOURS` gets written.
 * `lifetimeHours` is `null` for every class that never expires.
 */
export interface ProposalClassFields {
  class: ProposalClass;
  lifetimeHours: number | null;
}

/**
 * Stamp the class fields for a `(proposalType, targetType)` pair. THE one door
 * every read-side projection calls — `enrichProposalsForDisplay` (tRPC
 * list/get), `collapseProposalsToClusters` (groups), and `toProposalBasic` /
 * `withProposalClass` (Hub REST + MCP).
 */
export function proposalClassFields(
  proposalType: string,
  targetType: string
): ProposalClassFields {
  const cls = classifyProposal(proposalType, targetType);
  return { class: cls, lifetimeHours: CLASS_LIFETIME_HOURS[cls] };
}
