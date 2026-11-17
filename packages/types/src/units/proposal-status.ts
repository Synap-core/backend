/**
 * The PROPOSAL status declaration (`proposals.status`), in a leaf with no
 * runtime imports. A proposal's status move owes a transition
 * (`transitionProposal`, @synap/database) whose categories are read here. Which
 * move is ALLOWED stays with `PROPOSAL_TRANSITIONS`; this says only what each
 * status MEANS.
 */
import type { LifecycleCategory } from "../lifecycle/option.js";
import type { ProposalStatusValue } from "../proposals/attention.js";

/**
 * THE proposal lifecycle (founder decision D9, 17 Nov 2026). Keyed by every
 * stored status (`PROPOSAL_STATUSES`), so a new one stops the build.
 *
 *   open  pending (waiting on a verdict), approval_failed (approved, but the
 *         apply threw: still a verdict owed, retried or dismissed);
 *   done  approved, auto_approved (applied);
 *   lost  rejected, expired, withdrawn, reverted.
 */
export const PROPOSAL_STATUS_DECLARATION = {
  pending: { category: "open" },
  approval_failed: { category: "open" },
  approved: { category: "done" },
  auto_approved: { category: "done" },
  rejected: { category: "lost" },
  expired: { category: "lost" },
  withdrawn: { category: "lost" },
  reverted: { category: "lost" },
} as const satisfies Record<
  ProposalStatusValue,
  { category: LifecycleCategory }
>;

/** The category of a proposal status; `null` for a value no status declares. */
export function proposalStatusCategory(
  status: string | null | undefined
): LifecycleCategory | null {
  if (status == null) return null;
  return Object.hasOwn(PROPOSAL_STATUS_DECLARATION, status)
    ? PROPOSAL_STATUS_DECLARATION[status as ProposalStatusValue].category
    : null;
}
