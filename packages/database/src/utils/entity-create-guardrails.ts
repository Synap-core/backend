/**
 * Entity create guardrails (Phase 1 dedup prevention) — pure helpers for the
 * entities.create door.
 *
 * Policy (product, founder B2 2026-10-21):
 *   - Same-name (same profile/type) is never an auto-merge and never blocks a
 *     FILING: the duplicate door (`findDuplicateCandidates`, @synap/api) files
 *     an agent's create for review and warns a person's. Only an APPROVAL of
 *     a same-name create refuses (`ENTITY_WEAK_DEDUP` below), so the REVIEWER
 *     picks a verb. Strong (email/phone/url/handle) stays the only automatic
 *     merge.
 *   - Junk titles for person/company/contact: reject placeholder names agents
 *     invent when a person/team is not disclosed.
 *
 * Identity matching itself stays in IdentityResolutionService — this module
 * only builds the reviewer-facing refusal and the junk-title messages.
 */

/** Structured cause code for tRPC CONFLICT / REST 409 weak-dedup rejects. */
export const ENTITY_WEAK_DEDUP_CODE = "ENTITY_WEAK_DEDUP" as const;

/** Structured cause code for junk-title BAD_REQUEST rejects. */
export const ENTITY_JUNK_TITLE_CODE = "ENTITY_JUNK_TITLE" as const;

export interface EntityDedupCandidate {
  id: string;
  title: string | null;
  type: string;
}

export interface EntityWeakDedupCause {
  code: typeof ENTITY_WEAK_DEDUP_CODE;
  candidates: EntityDedupCandidate[];
  /** Stable guidance for the reviewer: the verbs that resolve the twin. */
  guidance: string;
}

/** Profiles where empty/placeholder titles are never acceptable. */
export const JUNK_TITLE_PROFILES = new Set(["person", "company", "contact"]);

/**
 * Placeholder titles agents invent when a person/team is not public.
 * Compared after trim + lower-case. Empty/whitespace is also junk.
 *
 * Single source for create-gate + hygiene sentinel detection (import this list /
 * `isJunkEntityTitle` — do not fork a second sentinel set).
 */
export const JUNK_ENTITY_TITLES = [
  "not publicly disclosed",
  "team not publicly disclosed",
  "team anonymous",
  "unknown",
  "tbd",
  "n/a",
  "na",
  "n.a.",
  "none",
  "null",
  "undefined",
  "-",
  "—",
  "?",
] as const;

const JUNK_TITLES = new Set<string>(JUNK_ENTITY_TITLES);

/** Whether this profileSlug rejects junk/placeholder titles. */
export function profileRejectsJunkTitle(
  profileSlug: string | undefined
): boolean {
  if (!profileSlug) return false;
  return JUNK_TITLE_PROFILES.has(profileSlug);
}

/**
 * True when `title` is empty/whitespace or a known placeholder name.
 * Pure — does not know about profile; combine with `profileRejectsJunkTitle`.
 * Also the hygiene "sentinel title" predicate (via `isSentinelTitle` re-export).
 */
export function isJunkEntityTitle(title: string | null | undefined): boolean {
  if (title == null) return true;
  const trimmed = title.trim();
  if (trimmed.length === 0) return true;
  return JUNK_TITLES.has(trimmed.toLowerCase());
}

/** True when this create should be rejected for a junk title. */
export function shouldRejectJunkTitle(
  profileSlug: string | undefined,
  title: string | null | undefined
): boolean {
  return profileRejectsJunkTitle(profileSlug) && isJunkEntityTitle(title);
}

export function buildJunkTitleMessage(profileSlug: string): string {
  return (
    `Cannot create a ${profileSlug} with an empty or placeholder title ` +
    `(e.g. "Not publicly disclosed", "unknown", "TBD", "N/A"). ` +
    `Use a real name, or skip creating the entity until one is known.`
  );
}

/**
 * Stable guidance string embedded in both the CONFLICT message and the
 * structured cause (so MCP text-only error paths stay actionable).
 */
export const WEAK_DEDUP_GUIDANCE =
  "Choose how to resolve it: keep both, use the existing one, or fill its empty fields.";

/**
 * The refusal an APPROVAL of a same-name create gets, naming the existing
 * same-kind records so the reviewer can pick a verb. Candidates are already
 * caller-scoped by the resolver's weak path — never an invisible strong hit.
 */
export function buildWeakEntityDedupMessage(
  candidates: EntityDedupCandidate[],
  profileSlug: string
): string {
  const list = candidates
    .slice(0, 5)
    .map((c) => `${c.title ?? "(untitled)"} (${c.id})`)
    .join("; ");
  return (
    `A ${profileSlug} with this name already exists: ${list}. ` +
    WEAK_DEDUP_GUIDANCE
  );
}

/** Build the structured cause payload for a weak-dedup CONFLICT. */
export function buildWeakDedupCause(
  candidates: EntityDedupCandidate[]
): EntityWeakDedupCause {
  return {
    code: ENTITY_WEAK_DEDUP_CODE,
    candidates,
    guidance: WEAK_DEDUP_GUIDANCE,
  };
}
