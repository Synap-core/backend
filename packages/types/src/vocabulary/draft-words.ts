/**
 * A DRAFT: an AI's proposed text that a person decides IN PLACE, in the app
 * that asked for it (a one-shot playbook's result, `executor: "generate"`,
 * backend#988; plan 08e4fba7). It is a pending proposal, so its state comes
 * from the proposal's status, and the person decides it with two verbs:
 * APPROVE it, or DISCARD it. "Discard", not "Reject": nothing was refused, the
 * person threw away text written for them (the API verb behind it stays
 * `reject`, see {@link DRAFT_DECISION_API}). Decision "Apps read the shared
 * vocabulary through the SDK; Discard is defined once" (founder, 10 Nov 2026).
 *
 * The ONE definition of these words: `ACTION_VERBS.approve` / `.discard` and
 * the French catalog's `action.approve.*` / `action.discard.*` are built from
 * {@link DRAFT_DECISION_WORDS} (`./index.ts`, `./catalog.fr.ts`), so the pod,
 * the browser and an app built on the SDK say the same word.
 *
 * DEPENDENCY-FREE LEAF, on purpose: `@synap-core/sdk` vendors this file byte
 * for byte (synap-app `packages/sdk/scripts/vendor-draft-words.mjs`, pinned by
 * its tripwire) because generated apps may only import the SDK. No import may
 * be added here.
 */

/**
 * Where a draft stands, from its proposal's status: `proposed` (it waits for
 * the person: approve or discard it), `approved` (it was applied), `discarded`
 * (the person threw it away), `failed` (approved, but the pod could not apply
 * it), `gone` (withdrawn or expired: nobody decided it), `reverted` (approved,
 * then undone), `unknown` (a status this table does not know: only the
 * proposal's own page says where it stands, never a guess).
 */
export const DRAFT_STATES = [
  "proposed",
  "approved",
  "discarded",
  "failed",
  "gone",
  "reverted",
  "unknown",
] as const;

export type DraftState = (typeof DRAFT_STATES)[number];

/** Each proposal status (`proposals.status`) as the draft's state. */
const DRAFT_STATE_OF_STATUS: Readonly<Record<string, DraftState>> = {
  pending: "proposed",
  approved: "approved",
  auto_approved: "approved",
  rejected: "discarded",
  approval_failed: "failed",
  withdrawn: "gone",
  expired: "gone",
  reverted: "reverted",
};

/** A draft's state from its proposal's status; an unknown status is `unknown`, never another state. */
export function draftStateOf(status: string | null | undefined): DraftState {
  const key = typeof status === "string" ? status.trim().toLowerCase() : "";
  return Object.hasOwn(DRAFT_STATE_OF_STATUS, key)
    ? DRAFT_STATE_OF_STATUS[key]!
    : "unknown";
}

/** The two ways a person decides a draft. */
export const DRAFT_DECISIONS = ["approve", "discard"] as const;

export type DraftDecision = (typeof DRAFT_DECISIONS)[number];

/** The proposal API verb behind each decision (`POST /proposals/:id/<verb>`). */
export const DRAFT_DECISION_API = {
  approve: "approve",
  discard: "reject",
} as const satisfies Record<DraftDecision, string>;

/** The languages these words are curated in (`@synap-core/types/i18n` locales). */
export type DraftWordsLocale = "en" | "fr";

/**
 * A decision verb in its three moods: `imperative` (the button: what it will
 * do), `past` (what happened: a receipt, a state's name), `progressive` (the
 * busy button while it lands).
 */
export interface DraftDecisionWords {
  imperative: string;
  past: string;
  progressive: string;
}

/** The words, per language. French: "vous", a past participle alone is masculine ("Écarté"). */
export const DRAFT_DECISION_WORDS = {
  en: {
    approve: {
      imperative: "Approve",
      past: "Approved",
      progressive: "Approving",
    },
    discard: {
      imperative: "Discard",
      past: "Discarded",
      progressive: "Discarding",
    },
  },
  fr: {
    approve: {
      imperative: "Approuver",
      past: "Approuvé",
      progressive: "Approbation en cours",
    },
    discard: {
      imperative: "Écarter",
      past: "Écarté",
      progressive: "Mise à l’écart en cours",
    },
  },
} as const satisfies Record<
  DraftWordsLocale,
  Record<DraftDecision, DraftDecisionWords>
>;

/** A draft decision's word in `mood`, in `locale` (English for any other locale). */
export function draftDecisionWord(
  decision: DraftDecision,
  mood: keyof DraftDecisionWords,
  locale: string = "en"
): string {
  const words =
    locale === "fr" ? DRAFT_DECISION_WORDS.fr : DRAFT_DECISION_WORDS.en;
  return words[decision][mood];
}
