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
  // is the one `execute-capability.ts` writes (`capability.run`); a test scans
  // that source so the two can never drift — they did once, and the class
  // table silently filed every run as objectWork, which never expires.
  if (proposalType === "capability.run" && targetType === "capability")
    return "ephemeral";
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
