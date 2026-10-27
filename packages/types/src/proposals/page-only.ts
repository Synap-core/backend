/**
 * Which proposals only their own page may approve — THE rule every surface
 * and the pod's approve doors read. Why one rule: five doors each derived it
 * and only pod-admin knew about code.
 *
 * Three reasons, each a consent shown only on the proposal's page:
 *  - `executable_skill`: a skill create that would RUN something. Approving it
 *    also turns it on (the one-approval rule), and only the page shows the
 *    code whole.
 *  - `acts_on_its_own`: anything else that sets up a skill, an automation or a
 *    rule: an instruction skill create (its prose lands in an agent's system
 *    prompt, a prompt-injection vector once a person approves it), any skill
 *    update, and a composite carrying such ops.
 *  - `identity_choice`: a create whose twin is a record (`needsIdentityChoice`).
 *    A plain approve keeps both without the reviewer seeing the twin; the
 *    page offers the same-name verbs.
 *
 * The two acting reasons also bind the approval to the revision the page
 * rendered (`PAGE_ONLY_REVISION_REASON_CODE`).
 *
 * Pure and browser-safe; the twin half reuses the one duplicate derivation.
 */
import {
  deriveDuplicateReview,
  needsIdentityChoice,
} from "./duplicate-review.js";
import {
  isActingOperation,
  isCompositeProposalData,
  type StoredProposalData,
} from "./index.js";

/** Why a proposal is decided on its own page. */
export type PageOnlyReason =
  "identity_choice" | "executable_skill" | "acts_on_its_own";

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

/**
 * The token `proposals.approve` refuses (CONFLICT) an acting page-only
 * proposal with when the call names no `expectedRevision`: the approval turns
 * something on, so it must be bound to the version the page showed.
 */
export const PAGE_ONLY_REVISION_REASON_CODE =
  "REVIEWED_REVISION_REQUIRED" as const;

/** The sentence a refused batch item carries, one per reason. */
export const PAGE_ONLY_SENTENCE: Readonly<Record<PageOnlyReason, string>> = {
  identity_choice:
    "Open it to approve: it looks like a record you already have, and its page lets you choose.",
  executable_skill:
    "Open it to approve: approving this skill turns its code on, and only its page shows the code.",
  acts_on_its_own:
    "Open it to approve: it sets up a skill, automation or rule that acts on its own, and only its page shows it whole.",
};

/** The reasons whose approval turns something on. */
export function pageOnlyReasonActs(
  reason: PageOnlyReason | null
): reason is "executable_skill" | "acts_on_its_own" {
  return reason === "executable_skill" || reason === "acts_on_its_own";
}

/** The verb of a proposal type (`skill.create` → `create`). */
function verbOf(proposalType: string): string {
  return proposalType.slice(proposalType.lastIndexOf(".") + 1);
}

/** The request a stored payload carries: `data.data` (the envelope), or flat. */
function requestOf(data: unknown): Record<string, unknown> {
  const outer = (data ?? {}) as { data?: unknown };
  return (
    outer.data && typeof outer.data === "object" ? outer.data : outer
  ) as Record<string, unknown>;
}

/**
 * Whether a skill would RUN something, read from what it carries whatever its
 * `kind` says: non-blank `code` (the runtime evaluates any code it finds), a
 * `providerSpec` object, or a runnable kind. Only an instruction (or no kind)
 * with neither is prose.
 */
export function skillRequestExecutes(skill: {
  kind?: unknown;
  code?: unknown;
  providerSpec?: unknown;
}): boolean {
  if (typeof skill.kind === "string") return skill.kind !== "instruction";
  if (typeof skill.code === "string" && skill.code.trim() !== "") return true;
  if (!!skill.providerSpec && typeof skill.providerSpec === "object")
    return true;
  return typeof skill.kind === "string" && skill.kind !== "instruction";
}

/**
 * A skill create that would RUN something (`skillRequestExecutes`). Reads
 * `targetType === "skill"` + a `create` verb only; a composite's
 * `create_skill` op is instruction-only (its contract has no `kind` or
 * `code`) and is read by `acts_on_its_own`.
 */
export function isExecutableSkillCreate(p: PageOnlyProposalFacts): boolean {
  if (p.targetType !== "skill") return false;
  if (verbOf(p.proposalType) !== "create") return false;
  return skillRequestExecutes(requestOf(p.data));
}

/**
 * Any other proposal that sets up something acting on its own: a skill create
 * or update of any kind, or a composite whose ops create or change a skill,
 * an automation or a rule (`ACTING_OPERATION_KINDS`).
 */
export function actsOnItsOwn(p: PageOnlyProposalFacts): boolean {
  if (p.targetType === "skill") {
    const verb = verbOf(p.proposalType);
    if (verb === "create" || verb === "update") return true;
  }
  // The stored row carries the ops at the top; a client row rebuilt from its
  // request carries them one level down (`pageOnlyFactsOf`).
  return [p.data, requestOf(p.data)].some((d) => {
    const data = d as StoredProposalData | null | undefined;
    return (
      isCompositeProposalData(data) && data.operations.some(isActingOperation)
    );
  });
}

/**
 * Why only this proposal's page may approve it, or `null` when a row's
 * inline Approve or a batch may. A skill that runs code wins over everything:
 * its page is the one review either way.
 */
export function proposalPageOnlyReason(
  p: PageOnlyProposalFacts
): PageOnlyReason | null {
  if (isExecutableSkillCreate(p)) return "executable_skill";
  if (false as boolean) return actsOnItsOwn(p) ? "acts_on_its_own" : null;
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
