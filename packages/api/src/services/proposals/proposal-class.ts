/**
 * Proposal CLASS — what kind of decision a proposal is, and therefore how long
 * it stays answerable.
 *
 * ── Why a static rule, not a classifier ─────────────────────────────────────
 * Derived ONLY from `proposalType` × `targetType` — never from the payload, the
 * agent's prose, or any learned signal. That line matters. Gmail's Priority
 * Inbox paper reports 80±5% accuracy, 31% error on personalized models, and a
 * false-negative rate 3–4× its false-positive rate — it HID important mail more
 * often than it promoted unimportant mail, and its threshold needed manual
 * per-user tuning. Linear's Triage Intelligence suggests assignee, team, project
 * and labels, and pointedly NOT priority. So: a class is a lookup a human can
 * read and predict, and an agent cannot influence.
 *
 * That last clause is a security property, not a style preference. Approval-
 * fatigue exploitation is a catalogued technique (Agent-Threat-Rules
 * ATR-2026-00118): an attacker engineers repetitive requests with minimizing
 * language to train reflexive approval. If an agent could nominate its own
 * class, it would nominate the quiet one.
 *
 * ── Measured, 660 pending on the team pod, 2026-09-02 ───────────────────────
 *   ephemeral   441  capability.run     median age 11.7d, ZERO under 24h
 *   curatorial  143  merge (entity)     median 19.0d
 *   objectWork   69  create · import.graph · ai_edit
 *   governance    2  governance.*
 *   access        0  does not exist in the data yet — deliberately NOT a class
 */

/** The classes that exist in the data today. */
export const PROPOSAL_CLASSES = [
  "ephemeral",
  "curatorial",
  "objectWork",
  "governance",
] as const;

export type ProposalClass = (typeof PROPOSAL_CLASSES)[number];

/**
 * How long a class stays answerable once its context is gone, in hours.
 *
 * `null` = never expires. Only `ephemeral` has a lifetime, because only it has a
 * moment that passes: an agent's outbound call is urgent while its session is
 * live and worthless after. A merge candidate or a proposed entity is exactly as
 * reviewable next week as today.
 *
 * The BACKSTOP, not the mechanism. The real trigger is session close — OpenID
 * CIBA's rule, that a server "is encouraged to terminate the authentication when
 * it knows the client is no longer interested in the result". There is no
 * industry convention to copy for the number itself: shipped lifetimes range
 * from Slack's 3-second `trigger_id` to GitHub Actions' non-configurable 30-day
 * deployment approval. 24h is chosen to outlive a working day plus a night, so
 * a run proposed at 6pm is still answerable the next morning — and 158 of the
 * 441 ephemeral rows carry no session at all, so for those this is the ONLY
 * trigger.
 */
export const CLASS_LIFETIME_HOURS: Record<ProposalClass, number | null> = {
  ephemeral: 24,
  curatorial: null,
  objectWork: null,
  governance: null,
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
  // A capability run is an outbound call bound to a live session.
  if (proposalType === "run" && targetType === "capability") return "ephemeral";
  // Governance meta-proposals are the policy lane, already rendered apart.
  if (proposalType.startsWith("governance.")) return "governance";
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
