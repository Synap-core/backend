/**
 * `requiredLinks` — the answer of the required-link check
 * (`@synap/api` services/links/required-links.ts) for a record a write
 * creates: which of the links its kind's template marks REQUIRED
 * (`entityLinks[].required`) the write leaves out. Persisted at the TOP LEVEL
 * of `proposals.data` (beside the request envelope, like `duplicateCheck`) and
 * returned on the create receipt, where each missing link is also one
 * `warnings[]` sentence ({@link missingLinkWarning}).
 *
 * Founder decisions (wave e4cd5f18, plan 38fb38a7 §3): a missing required
 * link WARNS, it never refuses yet (D3.2); the order is warn → list → check →
 * refuse.
 *
 * Pure and dependency-free: the backend writes it, the shared proposal
 * presentation and any client read it through {@link readRequiredLinkCheck}.
 */

/**
 * - `clear`     — the check ran and nothing required is missing.
 * - `missing`   — at least one required link is missing.
 * - `unchecked` — the check FAILED. Never folded into `clear`.
 */
export type RequiredLinkCheckStatus = "clear" | "missing" | "unchecked";

export interface MissingRequiredLink {
  /** The record's kind (profile slug). */
  kind: string;
  /** The relation slug the link must carry, e.g. `relates_to`. */
  type: string;
  /** The kinds the link may point at (any one satisfies it). */
  targetKinds: string[];
  /** The template that marked it required, when known. */
  requiredBy: string | null;
  /** Capture graphs only: the op `ref` of the proposed record. */
  forRef?: string;
  /** Capture graphs only: that proposed record's title. */
  forTitle?: string;
}

export interface RequiredLinkCheck {
  status: RequiredLinkCheckStatus;
  missing: MissingRequiredLink[];
}

/** The ONE sentence for a missing required link (receipt `warnings[]`, cards). */
export function missingLinkWarning(link: MissingRequiredLink): string {
  const subject = link.forTitle ? `${link.kind} "${link.forTitle}"` : link.kind;
  const targets = link.targetKinds.length
    ? ` to ${link.targetKinds.join(" or ")}`
    : "";
  const by = link.requiredBy
    ? `required by template ${link.requiredBy}`
    : "required by its template";
  return `${subject} has no ${link.type}${targets}: ${by}. Add the link (synap_link_entities) once the record exists.`;
}

/** The sentence for a check that could not run. */
export const REQUIRED_LINKS_UNCHECKED_WARNING =
  "The links this kind requires could not be checked.";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readMissing(value: unknown): MissingRequiredLink | null {
  const row = asRecord(value);
  if (!row) return null;
  if (typeof row.kind !== "string" || typeof row.type !== "string") {
    return null;
  }
  return {
    kind: row.kind,
    type: row.type,
    targetKinds: Array.isArray(row.targetKinds)
      ? row.targetKinds.filter((k): k is string => typeof k === "string")
      : [],
    requiredBy: typeof row.requiredBy === "string" ? row.requiredBy : null,
    ...(typeof row.forRef === "string" ? { forRef: row.forRef } : {}),
    ...(typeof row.forTitle === "string" ? { forTitle: row.forTitle } : {}),
  };
}

/**
 * THE accessor for a proposal's (or receipt's) `requiredLinks`. `null` when
 * the check did not run for this write or the stored value is not one.
 */
export function readRequiredLinkCheck(data: unknown): RequiredLinkCheck | null {
  const raw = asRecord(asRecord(data)?.requiredLinks);
  if (!raw) return null;
  if (
    raw.status !== "clear" &&
    raw.status !== "missing" &&
    raw.status !== "unchecked"
  ) {
    return null;
  }
  const missing = Array.isArray(raw.missing)
    ? raw.missing
        .map(readMissing)
        .filter((m): m is MissingRequiredLink => m !== null)
    : [];
  return { status: raw.status, missing };
}

/** The `warnings[]` sentences a check contributes to a reply. */
export function requiredLinkWarnings(
  check: RequiredLinkCheck | null | undefined
): string[] {
  if (!check) return [];
  if (check.status === "unchecked") return [REQUIRED_LINKS_UNCHECKED_WARNING];
  return check.missing.map(missingLinkWarning);
}
