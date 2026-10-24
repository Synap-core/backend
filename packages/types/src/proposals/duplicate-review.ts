/**
 * "Looks like X" — how a review card presents the pod's duplicate answer
 * (FB1020 B2, founder-approved 2026-10-21). ONE derivation for every review
 * surface (pod-admin, the synap-app browser card, relay), so no two cards can
 * disagree on what a twin is or which verbs resolve it.
 *
 * The pod's one duplicate door files a possible twin ANYWAY, as a proposal,
 * and stores its answer on it (`data.duplicateCheck`, read with
 * {@link readDuplicateCheck}). The REVIEWER decides:
 *  - Fill empty fields    → approve with `{ verb: "fill_empty", existingEntityId }`;
 *  - Use existing         → `{ verb: "keep_existing", existingEntityId }`;
 *  - Overwrite with these → `{ verb: "use_capture", existingEntityId }`;
 *  - Keep both            → `{ verb: "separate" }`.
 * Those are the EXISTING approve verbs (`identityResolutionInput`,
 * `@synap/api` executors/identity-resolution.ts); nothing here invents a
 * second set. They apply to an entity create whose twin is a RECORD (one
 * `identityResolution`), or to each item of a capture graph whose twin is a
 * record (`identityResolutionByRef`, keyed by the item's ref); a twin that is
 * another pending proposal, or a playbook / project / kind twin, is a door to
 * look at — approve keeps both, reject drops this one.
 *
 * Moved DOWN from synap-app `@synap-core/hooks/proposal-types/duplicateCheck.ts`
 * (2026-10-23) so pod-admin, which depends on `@synap-core/types` and not on
 * hooks, reads the same rule instead of a third copy. Pure; the only runtime
 * import is the vocabulary door. The hooks file becomes a re-export of this
 * one once this version of `@synap-core/types` is published.
 */
import { humanizeToken } from "../vocabulary/index.js";
import {
  readDuplicateCheck,
  type DuplicateCandidate,
  type DuplicateCheck,
} from "./duplicate-check.js";

/** The approve verbs a same-name twin can be resolved with (pod: `identityResolutionInput`). */
export type DuplicateResolutionVerb =
  "fill_empty" | "keep_existing" | "use_capture" | "separate";

/** What an approve sends for one create: the verb, and the twin it binds to. */
export interface DuplicateResolution {
  verb: DuplicateResolutionVerb;
  existingEntityId?: string;
}

/**
 * Button order is the product order; hints are the sentences that say what
 * the write will do (a verb label alone does not). THE one copy — every card
 * reads it. The first verb is the ONE primary (lead default, FB1020 wave 2:
 * the least destructive verb that creates no twin); the others are secondary.
 */
export const DUPLICATE_RESOLUTION_VERBS: readonly {
  verb: DuplicateResolutionVerb;
  label: string;
  hint: string;
  needsExisting: boolean;
}[] = [
  {
    verb: "fill_empty",
    label: "Fill empty fields",
    hint: "Adds only what the existing record is missing.",
    needsExisting: true,
  },
  {
    verb: "keep_existing",
    label: "Use existing",
    hint: "Nothing new is created.",
    needsExisting: true,
  },
  {
    verb: "use_capture",
    label: "Overwrite with these",
    hint: "Replaces the existing record's values.",
    needsExisting: true,
  },
  {
    verb: "separate",
    label: "Keep both",
    hint: "Creates a second record with the same name.",
    needsExisting: false,
  },
];

/** The verb a card offers as its one primary (`DUPLICATE_RESOLUTION_VERBS[0]`). */
export const PRIMARY_DUPLICATE_VERB: DuplicateResolutionVerb = "fill_empty";

/** The one line shown above the record-bound verbs while several twins wait for a pick. */
export const PICK_TWIN_FIRST = "Pick the record first.";

/** The quiet mark a card shows when the pod's duplicate lookup FAILED (`unchecked`). */
export const DUPLICATE_UNCHECKED_LINE = "Couldn't check for duplicates";

/**
 * One proposed item of a capture graph whose twin is a RECORD: the reviewer
 * picks a verb for THIS item, sent as `identityResolutionByRef[forRef]`.
 */
export interface DuplicateItemReview {
  /** The graph item's op ref — the key of `identityResolutionByRef`. */
  forRef: string;
  /** The proposed item's title. */
  forTitle: string | null;
  /** The record twins this item's verbs bind to. */
  resolvable: DuplicateCandidate[];
}

/** What a card shows for a proposal's duplicate answer. */
export interface ProposalDuplicateReview {
  check: DuplicateCheck;
  /** Every candidate, each a door (a record opens itself; a proposal opens its review). */
  candidates: DuplicateCandidate[];
  /**
   * The RECORD twins of a single entity create — the set the approve verbs
   * bind to. Empty when the verbs do not apply (a pending-proposal twin, a
   * playbook/project/kind, a graph — whose verbs live on `items`).
   */
  resolvable: DuplicateCandidate[];
  /**
   * A capture graph's items whose twin is a record, one per item ref, each
   * resolved with its own verb (`identityResolutionByRef`). Empty for a single
   * create.
   */
  items: DuplicateItemReview[];
}

/**
 * The card's reading of `data.duplicateCheck`. `null` when the door did not
 * run or found nothing (`clear`). A FAILED lookup (`unchecked`) is returned
 * with no candidates, so the card can say so ({@link DUPLICATE_UNCHECKED_LINE})
 * instead of reading as "no twin".
 */
export function deriveDuplicateReview(
  data: unknown,
  opts: { singleEntityCreate: boolean }
): ProposalDuplicateReview | null {
  const check = readDuplicateCheck(data);
  if (!check) return null;
  if (check.status === "unchecked") {
    return { check, candidates: [], resolvable: [], items: [] };
  }
  if (check.status !== "possible" || check.candidates.length === 0) {
    return null;
  }
  const entity = check.subject === "entity";
  const items: DuplicateItemReview[] = [];
  if (entity) {
    const byRef = new Map<string, DuplicateItemReview>();
    for (const c of check.candidates) {
      if (c.ref !== "record" || !c.forRef) continue;
      let item = byRef.get(c.forRef);
      if (!item) {
        item = {
          forRef: c.forRef,
          forTitle: c.forTitle ?? null,
          resolvable: [],
        };
        byRef.set(c.forRef, item);
        items.push(item);
      }
      item.resolvable.push(c);
    }
  }
  return {
    check,
    candidates: check.candidates,
    resolvable:
      opts.singleEntityCreate && entity
        ? check.candidates.filter((c) => c.ref === "record" && !c.forRef)
        : [],
    items,
  };
}

/**
 * THE check every decide door reads (FB1020 wave 2, M1): a create whose twin
 * is a record. A plain approve of it KEEPS BOTH when the twin was on the card
 * (the pod reads "approved as proposed" — it assumes the reviewer saw "looks
 * like X"), and refuses with `ENTITY_WEAK_DEDUP` only for a twin the card never
 * showed. So while this is true no surface offers a quick Approve, a swipe or a
 * batch approve: each of those would approve without showing the twin, and
 * mint one. The reviewer decides with the verbs on the proposal's page.
 */
export function needsIdentityChoice(
  presentation:
    { duplicate?: ProposalDuplicateReview | null } | null | undefined
): boolean {
  const d = presentation?.duplicate;
  return !!d && (d.resolvable.length > 0 || d.items.length > 0);
}

/**
 * The object kind a candidate's door opens: a record opens itself (an entity,
 * or a playbook / project / kind); a waiting twin opens its review. ONE rule
 * for every card.
 */
export function duplicateObjectKind(candidate: DuplicateCandidate): string {
  if (candidate.ref === "proposal") return "proposal";
  if (
    candidate.kind === "playbook" ||
    candidate.kind === "project" ||
    candidate.kind === "kind"
  ) {
    return candidate.kind;
  }
  return "entity";
}

/** A candidate's name, with the graph item it is for ("Acme (for Acme Corp)"). */
export function duplicateCandidateLabel(candidate: DuplicateCandidate): string {
  const title = candidate.title?.trim() ? candidate.title : "Untitled";
  return candidate.forTitle ? `${title} (for ${candidate.forTitle})` : title;
}

/**
 * The candidate is DEMO data (it sits only in sample projects — founder
 * default 1, FB1020 wave 2): the pod never merges onto it and the card marks
 * it, because "Use existing" on it would put real work on a demo row. Read
 * defensively: `DuplicateCandidate.sample` is new on the wire.
 */
export function duplicateIsSample(candidate: object): boolean {
  return (candidate as { sample?: unknown }).sample === true;
}

/** The mark a sample candidate wears, through the vocabulary door. */
export const DUPLICATE_SAMPLE_MARK = humanizeToken("sample");

/**
 * Why a candidate matched, in words, through the vocabulary door
 * (`same_name` → "Same name", `similar_name` → "Similar name"). No local map.
 */
export function duplicateWhyLabel(candidate: { why: string }): string {
  const why = humanizeToken(candidate.why);
  return duplicateIsSample(candidate)
    ? `${why} · ${DUPLICATE_SAMPLE_MARK}`
    : why;
}

/**
 * The resolution a tap would send, or null when that verb cannot be sent yet.
 * One candidate is the record — no extra pick; several require an explicit
 * pick that is one of them. Nothing in here chooses a verb.
 */
export function duplicateResolutionFor(
  verb: DuplicateResolutionVerb,
  candidates: readonly { id: string }[],
  pickedId: string | null
): DuplicateResolution | null {
  if (verb === "separate") return { verb: "separate" };
  const existingEntityId =
    candidates.length === 1 ? candidates[0]?.id : (pickedId ?? undefined);
  if (!existingEntityId) return null;
  if (!candidates.some((c) => c.id === existingEntityId)) return null;
  return { verb, existingEntityId };
}

/** A reviewer's choice for one graph item: the verb, and the picked twin when several. */
export interface DuplicateItemChoice {
  verb: DuplicateResolutionVerb;
  pickedId: string | null;
}

/**
 * The choice an item starts with: the primary verb ({@link PRIMARY_DUPLICATE_VERB}),
 * bound to the twin when there is exactly one. With several twins nothing is
 * picked — the reviewer picks, the card never guesses a record.
 */
export function defaultDuplicateItemChoice(): DuplicateItemChoice {
  return { verb: PRIMARY_DUPLICATE_VERB, pickedId: null };
}

/**
 * The `identityResolutionByRef` a graph approve sends: one resolution per item
 * with a record twin, keyed by the item's ref. `missing` lists the items whose
 * choice cannot be sent yet (several twins, none picked); while it is non-empty
 * the approve waits.
 */
export function identityResolutionByRefFor(
  items: readonly DuplicateItemReview[],
  choices: Readonly<Record<string, DuplicateItemChoice | undefined>>
): {
  byRef: Record<string, DuplicateResolution>;
  missing: DuplicateItemReview[];
} {
  const byRef: Record<string, DuplicateResolution> = {};
  const missing: DuplicateItemReview[] = [];
  for (const item of items) {
    const choice = choices[item.forRef] ?? defaultDuplicateItemChoice();
    const resolution = duplicateResolutionFor(
      choice.verb,
      item.resolvable,
      choice.pickedId
    );
    if (resolution) byRef[item.forRef] = resolution;
    else missing.push(item);
  }
  return { byRef, missing };
}

/**
 * A PERSON's create landed beside a possible twin (FB1020 B2e: warned, never
 * blocked): the sentence the create door tells them, read off the create
 * receipt's `duplicateCheck` through the one accessor. `null` when nothing
 * matched or the lookup did not say (`clear`, absent). A failed lookup is not
 * a warning about a twin and says nothing here (the create still landed).
 */
export function ownCreateDuplicateWarning(receipt: unknown): string | null {
  const check = readDuplicateCheck(receipt);
  if (!check || check.status !== "possible") return null;
  const records = check.candidates.filter((c) => c.ref === "record");
  const pool = records.length > 0 ? records : check.candidates;
  const first = pool[0];
  if (!first) return null;
  const name = duplicateCandidateLabel({ ...first, forTitle: undefined });
  const rest = pool.length - 1;
  if (check.truncated)
    return `It looks like ${name} and others you already have.`;
  return rest > 0
    ? `It looks like ${name} and ${rest} more you already have.`
    : `It looks like ${name}, which you already have.`;
}
