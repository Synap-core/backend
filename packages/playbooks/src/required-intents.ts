/**
 * `requiredIntents` — WHAT A PLAYBOOK NEEDS THE POD TO BE ABLE TO DO.
 *
 * A playbook names the ABSTRACT intents its stages depend on (`send_message`,
 * `generate_media`), so the run resolves the concrete capability serving each
 * one rather than the author hard-coding a vendor tool that may not be
 * installed. This is the playbook half of the intent spine: Phase 1 gave
 * workspace templates `taskIntents` (what the SPACE needs), Phase 2 gave
 * capability templates `provides` (what a PACK serves); this is what a
 * PROCESS needs.
 *
 * ── WHAT THIS FILE IS, AND IS NOT ───────────────────────────────────────────
 * It holds the field's TYPE, ONE tolerant reader, and the PURE matcher that
 * turns a declaration plus a supplied index into a per-intent verdict. It holds
 * NO vocabulary and NO resolver:
 *
 *   - The CLOSED VOCABULARY is the pod's `capability_intents` TABLE (migrations
 *     0283/0284), mirrored into `@synap-core/types/capability-intents`. It is
 *     NOT re-declared here — a fifth copy is what the four existing
 *     parity-guarded mirrors already cost, and `unknownIntents` from that leaf
 *     is the ONE membership test. Validation lives at the WRITE DOOR
 *     (`@synap/api` `schemas/playbook-definition.ts`), the same split
 *     `PlaybookStage`'s type and `playbookStagesSchema` already use: pure shape
 *     here, zod there.
 *
 *   - The RESOLVER (intent → installed concrete verb) belongs to
 *     `api/services/capabilities/capability-intent-index.ts`. This file does
 *     not duplicate that index and does not import it: the matcher takes the
 *     already-folded index as DATA, so the seam is a `Map` and nothing more.
 *
 * ── A GAP IS A FACT, NEVER A REJECTION ──────────────────────────────────────
 * `requiredIntents` is what a playbook NEEDS TO FUNCTION, not a snapshot of
 * what this pod has installed. A playbook may — SHOULD — declare an intent
 * nothing currently serves; that is the declaration working, and it is what a
 * later install is checked against. So `matchRequiredIntents` REPORTS
 * `unsatisfied`, and the write door rejects only a slug that is not in the
 * closed vocabulary at all.
 *
 * This mirrors `taskIntents` exactly, and for the same reason: an earlier draft
 * of that field gated `declared ⊆ provided` as a hard failure, and it forbade
 * the founder's own reference declaration (Content Studio declares 4 intents
 * its one installed pack covers 1 of). A subset rule is the WRONG invariant.
 */

/**
 * The field name, in ONE place. The wire schema, the reader, the composition
 * merge and any guard all read it from here, so the name cannot be spelled two
 * ways — a reader looking for `intents` under a field written `requiredIntents`
 * reads an empty list forever and reports every playbook as satisfied.
 */
export const REQUIRED_INTENTS_FIELD = "requiredIntents" as const;

/**
 * One value of the closed vocabulary.
 *
 * Deliberately `string`, NOT a union: the SSOT is the pod's TABLE, so a slug
 * added there must be declarable here before its parity guard has had a chance
 * to run — exactly the reasoning behind `CapabilityIntentSlug` in
 * `@synap-core/types/capability-intents`. The closed set is enforced where it
 * is MEANINGFUL (the write door), not by making a mirror go stale silently.
 */
export type PlaybookRequiredIntent = string;

/** A playbook's declared requirements: a SET of intent slugs. */
export type PlaybookRequiredIntents = PlaybookRequiredIntent[];

/** A playbook carries at most this many declared intents. */
export const MAX_REQUIRED_INTENTS = 24;

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Read a playbook's declared requirements out of an untyped jsonb bag.
 * TOLERANT, like `readCriteria` and `readStageLessons`, and for the same
 * reason: a playbook row written before this field existed must read as `[]`,
 * never throw, and a hand-edited or newer-pod row must not break every reader.
 *
 * DROPPED, each a fact rather than an error: a non-string, a blank string, a
 * duplicate (a requirement is a SET — the write door is what reports a
 * duplicate at authoring time, mirroring `playbookParamsInputSchema`), and
 * anything past {@link MAX_REQUIRED_INTENTS} (the doors refuse more; the reader
 * truncates). Order is first-seen and stable.
 *
 * Takes `unknown` so a caller can hand it the row bag directly.
 */
export function readRequiredIntents(
  playbook: unknown
): PlaybookRequiredIntents {
  const raw = (playbook as Record<string, unknown> | null | undefined)?.[
    REQUIRED_INTENTS_FIELD
  ];
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: PlaybookRequiredIntents = [];
  for (const entry of raw) {
    if (out.length >= MAX_REQUIRED_INTENTS) break;
    if (!isNonBlankString(entry)) continue;
    const slug = entry.trim();
    if (seen.has(slug)) continue;
    seen.add(slug);
    out.push(slug);
  }
  return out;
}

/**
 * Whether a declared requirement can be served RIGHT NOW under the supplied
 * index.
 *
 *   `satisfied`   — at least one concrete provider resolves the intent.
 *   `unsatisfied` — nothing does. A FACT to surface (drive an install, report a
 *                   gap), never a reason to refuse the playbook.
 */
export const INTENT_REQUIREMENT_STATUSES = [
  "satisfied",
  "unsatisfied",
] as const;
export type IntentRequirementStatus =
  (typeof INTENT_REQUIREMENT_STATUSES)[number];

// Coverage floor: a status added to the union but not to the list above makes
// this `never`, and the BUILD stops. (`satisfies` alone only catches the
// reverse — a list entry the union does not declare.)
const _statusesExhaustive: Exclude<
  IntentRequirementStatus,
  (typeof INTENT_REQUIREMENT_STATUSES)[number]
> extends never
  ? true
  : never = true;
void _statusesExhaustive;

/** The verdict for ONE declared intent. */
export interface IntentRequirement {
  /** The declared slug. */
  intent: PlaybookRequiredIntent;
  status: IntentRequirementStatus;
  /**
   * The concrete provider ids currently serving this intent — verbatim from the
   * index, never reordered or filtered. EMPTY when `unsatisfied`, which is a
   * real answer ("nothing installed serves this"), not a placeholder.
   */
  providers: string[];
}

/** The whole verdict for a playbook, in declaration order. */
export interface RequiredIntentsReport {
  /** One entry per declared intent, in `required` order. */
  requirements: IntentRequirement[];
  /** Just the unsatisfied slugs — the gap list, for a proposal or a log line. */
  gaps: PlaybookRequiredIntent[];
  /** True when every declared intent can be served right now. */
  satisfied: boolean;
}

/**
 * THE SEAM TO THE RESOLVER — and the whole of it.
 *
 * `provided` is `intent → concrete provider ids`, which is EXACTLY what
 * `intentIndex(ctx)` returns from
 * `api/services/capabilities/capability-intent-index.ts` after a one-line
 * projection of each `IntentVerbMatch[]` down to its `verbId`s. This package
 * therefore never imports, duplicates or shadows that index: it takes the
 * folded answer as data, so the resolver stays the single place that decides
 * which capability serves an intent, and this one decides only what to SAY
 * about it.
 *
 * PURE and total: an empty declaration, an absent index, and an index holding
 * intents nobody declared all resolve without throwing, because "nothing serves
 * this" and "nothing was declared" are both legitimate answers a run must be
 * able to report.
 *
 * Note it does NOT consult the vocabulary — an unknown slug that happens to
 * appear in the index is reported as satisfied, and one that does not is
 * reported as a gap. Membership is the write door's rule; this is a coverage
 * question, and a slug can only reach here through a door that already checked
 * it (or a row stored before the door did — whose gap is exactly the signal a
 * reader wants).
 */
export function matchRequiredIntents(
  required: readonly PlaybookRequiredIntent[],
  provided: ReadonlyMap<string, readonly string[]> = new Map()
): RequiredIntentsReport {
  const requirements: IntentRequirement[] = [];
  const gaps: PlaybookRequiredIntent[] = [];
  for (const intent of required) {
    const providers = [...(provided.get(intent) ?? [])];
    const status: IntentRequirementStatus =
      providers.length > 0 ? "satisfied" : "unsatisfied";
    if (status === "unsatisfied") gaps.push(intent);
    requirements.push({ intent, status, providers });
  }
  return { requirements, gaps, satisfied: gaps.length === 0 };
}

/**
 * Union two declarations, base first — the merge an overlay composition does.
 *
 * Exported as its own rule (not left inside the composer) so the composer and
 * any future merge site share ONE implementation: order is base-then-overlay
 * with first-seen wins, the same shape `unionCapabilityRefs` gives grants.
 * Blank and non-string entries are dropped, so a malformed bag on either side
 * cannot smuggle a phantom requirement into the flattened result.
 */
export function mergeRequiredIntents(
  base: readonly unknown[] | undefined,
  overlay: readonly unknown[] | undefined
): PlaybookRequiredIntents | undefined {
  if (!base && !overlay) return undefined;
  const seen = new Set<string>();
  const out: PlaybookRequiredIntents = [];
  for (const entry of [...(base ?? []), ...(overlay ?? [])]) {
    if (out.length >= MAX_REQUIRED_INTENTS) break;
    if (!isNonBlankString(entry)) continue;
    const slug = entry.trim();
    if (seen.has(slug)) continue;
    seen.add(slug);
    out.push(slug);
  }
  return out;
}
