/**
 * Which proposals only their own page may approve — THE rule every surface
 * and the pod's batch door read (W0, code-runtime wave, 2026-10-26). Before
 * it lived here, five doors each derived "may this be batched" (pod-admin
 * Review, synap-app/browser `isReviewOnlyProposal`, relay's group screen,
 * relay's session "Approve all", the pod's `proposals.batchApprove`), and only
 * pod-admin knew about code: a skill create carrying code could be swept into
 * an "Approve all" everywhere else.
 *
 * Two reasons, each a consent shown only on the proposal's page:
 *  - `identity_choice`: a create whose twin is a record (`needsIdentityChoice`).
 *    A plain approve keeps both without the reviewer seeing the twin; the
 *    page offers the same-name verbs.
 *  - `executable_skill`: a skill create that would RUN something. Approving it
 *    also turns it on (founder decision 2, 2026-10-25), and only the page shows
 *    the code whole.
 *
 * Pure and browser-safe; the twin half reuses the one duplicate derivation.
 */
import {
  deriveDuplicateReview,
  needsIdentityChoice,
} from "./duplicate-review.js";

/** Why a proposal is decided on its own page. */
export type PageOnlyReason = "identity_choice" | "executable_skill";

/** The proposal fields the rule reads: a stored row or a list row both fit. */
export interface PageOnlyProposalFacts {
  proposalType: string;
  targetType: string;
  /** The stored payload: the request rides `data.data` (the gate's envelope). */
  data?: unknown;
}

/**
 * The machine token the pod's batch door refuses a page-only item with
 * (`proposals.batchApprove` → `results[i].reasonCode`). Clients branch on it,
 * never on the sentence.
 */
export const PAGE_ONLY_REASON_CODE = "REVIEW_ON_ITS_PAGE" as const;

/** The sentence a refused batch item carries, one per reason. */
export const PAGE_ONLY_SENTENCE: Readonly<Record<PageOnlyReason, string>> = {
  identity_choice:
    "Open it to approve: it looks like a record you already have, and its page lets you choose.",
  executable_skill:
    "Open it to approve: approving this skill turns its code on, and only its page shows the code.",
};

/**
 * A skill create that would RUN something: code, a declarative call on an
 * installed tool, or any kind other than an instruction. A request with no
 * `kind` is read by what it carries (the stored column defaults to `code`).
 * A skill update is not one: a code edit resets the skill's approval.
 *
 * Reads `targetType === "skill"` + a `create` verb only. A composite's
 * `create_skill` op is instruction-only today (its contract has no `kind` or
 * `code`), so a code skill cannot ride inside one; when a code arm lands
 * there, this rule must read the ops too.
 */
export function isExecutableSkillCreate(p: PageOnlyProposalFacts): boolean {
  if (p.targetType !== "skill") return false;
  if (p.proposalType.slice(p.proposalType.lastIndexOf(".") + 1) !== "create")
    return false;
  const outer = (p.data ?? {}) as { data?: unknown };
  const request = (
    outer.data && typeof outer.data === "object" ? outer.data : outer
  ) as { kind?: unknown; code?: unknown; providerSpec?: unknown };
  if (typeof request.kind === "string") return request.kind !== "instruction";
  return (
    (typeof request.code === "string" && request.code.trim() !== "") ||
    (!!request.providerSpec && typeof request.providerSpec === "object")
  );
}

/**
 * Why only this proposal's page may approve it, or `null` when a row's
 * inline Approve or a batch may. A skill that runs code wins over a twin:
 * its page is the one review either way.
 */
export function proposalPageOnlyReason(
  p: PageOnlyProposalFacts
): PageOnlyReason | null {
  if (isExecutableSkillCreate(p)) return "executable_skill";
  if (
    needsIdentityChoice({
      duplicate: deriveDuplicateReview(p.data, { singleEntityCreate: true }),
    })
  )
    return "identity_choice";
  return null;
}

/** True when no inline Approve and no batch may decide this proposal. */
export function proposalNeedsItsPage(p: PageOnlyProposalFacts): boolean {
  return proposalPageOnlyReason(p) !== null;
}
