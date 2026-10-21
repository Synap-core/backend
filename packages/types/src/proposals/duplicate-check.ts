/**
 * `duplicateCheck` — the answer of the ONE duplicate door
 * (`findDuplicateCandidates`, `@synap/api` services/duplicates), persisted at
 * the TOP LEVEL of `proposals.data` (beside the request envelope, never inside
 * the record the executors parse) and returned on the create receipt.
 *
 * Founder decisions B2 (2026-10-21): a near match is filed anyway and shown
 * here as "looks like X"; the REVIEWER decides with the existing verbs (keep
 * both, use the existing one, fill its empty fields); a near match turns an
 * agent's auto-approved write into a proposal (`POSSIBLE_DUPLICATE`); same kind
 * only; a person's own create is warned, never blocked.
 *
 * Pure and dependency-free: the backend writes it, the shared proposal
 * presentation (synap-app `@synap-core/hooks/proposal-types`) and any client
 * read it through {@link readDuplicateCheck} — the ONE accessor.
 */

/** Hard cap on persisted candidates, so a pathological name cannot bloat a proposal. */
export const DUPLICATE_CHECK_MAX_CANDIDATES = 5;

/**
 * - `clear`     — the door looked and found nothing.
 * - `possible`  — at least one candidate; the write is filed for review.
 * - `unchecked` — the lookup FAILED. Never folded into `clear`: an empty
 *                 result and a failed read are different facts.
 */
export type DuplicateCheckStatus = "clear" | "possible" | "unchecked";

/** What the door compared. `kind` is a schema definition (a profile). */
export type DuplicateSubjectType = "entity" | "playbook" | "project" | "kind";

/**
 * WHY a candidate matched — a closed set, so a renderer words it from the
 * one vocabulary instead of string-matching prose.
 *  - `same_identity` — a strong identity atom (email, phone, url, handle,
 *                      external id) the door could not merge onto;
 *  - `same_name`     — the same normalized name, same kind;
 *  - `similar_name`  — near-identical name tokens (projects only, today).
 */
export type DuplicateMatchReason =
  "same_identity" | "same_name" | "similar_name";

export interface DuplicateCandidate {
  /** A live record, or a pending proposal that would create one. */
  ref: "record" | "proposal";
  /** The record's id (entity / playbook / project / profile) or the proposal id. */
  id: string;
  /** The candidate's kind: an entity's profile slug, or the subject type. */
  kind: string;
  title: string | null;
  why: DuplicateMatchReason;
  /** Capture graphs only: the op `ref` of the proposed item this candidate is for. */
  forRef?: string;
  /** Capture graphs only: that proposed item's title. */
  forTitle?: string;
}

export interface DuplicateCheck {
  status: DuplicateCheckStatus;
  subject: DuplicateSubjectType;
  candidates: DuplicateCandidate[];
  /** True when more candidates matched than {@link DUPLICATE_CHECK_MAX_CANDIDATES}. */
  truncated?: boolean;
}

const STATUSES: ReadonlySet<string> = new Set([
  "clear",
  "possible",
  "unchecked",
]);
const SUBJECTS: ReadonlySet<string> = new Set([
  "entity",
  "playbook",
  "project",
  "kind",
]);
const REASONS: ReadonlySet<string> = new Set([
  "same_identity",
  "same_name",
  "similar_name",
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readCandidate(value: unknown): DuplicateCandidate | null {
  const row = asRecord(value);
  if (!row) return null;
  if (row.ref !== "record" && row.ref !== "proposal") return null;
  if (typeof row.id !== "string" || row.id.length === 0) return null;
  if (typeof row.kind !== "string") return null;
  if (typeof row.why !== "string" || !REASONS.has(row.why)) return null;
  const title = typeof row.title === "string" ? row.title : null;
  return {
    ref: row.ref,
    id: row.id,
    kind: row.kind,
    title,
    why: row.why as DuplicateMatchReason,
    ...(typeof row.forRef === "string" ? { forRef: row.forRef } : {}),
    ...(typeof row.forTitle === "string" ? { forTitle: row.forTitle } : {}),
  };
}

/**
 * THE accessor for a proposal's (or receipt's) `duplicateCheck`. Reads the
 * top-level `data.duplicateCheck`; `null` when the door did not run for this
 * write (absent) or the stored value is not a duplicate check. Malformed
 * candidate rows are dropped, never guessed.
 */
export function readDuplicateCheck(data: unknown): DuplicateCheck | null {
  const raw = asRecord(asRecord(data)?.duplicateCheck);
  if (!raw) return null;
  if (typeof raw.status !== "string" || !STATUSES.has(raw.status)) return null;
  if (typeof raw.subject !== "string" || !SUBJECTS.has(raw.subject)) {
    return null;
  }
  const candidates = Array.isArray(raw.candidates)
    ? raw.candidates
        .map(readCandidate)
        .filter((c): c is DuplicateCandidate => c !== null)
    : [];
  return {
    status: raw.status as DuplicateCheckStatus,
    subject: raw.subject as DuplicateSubjectType,
    candidates,
    ...(raw.truncated === true ? { truncated: true } : {}),
  };
}
