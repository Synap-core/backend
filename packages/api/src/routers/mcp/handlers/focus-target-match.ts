/**
 * PURE name/id → target resolution for the "focus" tools.
 *
 * Deliberately dependency-free (no db, no drizzle, no schema barrel) so it can
 * be unit-tested without a database — this package's DB-backed suites cannot
 * run in every environment, and the two guards this file carries are exactly
 * the ones that must never regress silently.
 *
 * THE TWO GUARDS
 *
 * 1. NEVER A SILENT PICK. Names are not unique. The live pod carries two
 *    workspaces called "Foundation" and two called "CRM"; project names are
 *    under even less pressure to be unique. `.find()` returns the FIRST row and
 *    discards the rest, so an ambiguous name used to pin whichever row the
 *    database happened to return and report `✓ focused`. Every ambiguous branch
 *    here returns `{ kind: "ambiguous", candidates }` instead. The house rule is
 *    stated at `handlers/build.ts:518` — "Multi-match returns candidates …
 *    never a silent pick."
 *
 * 2. THE CANDIDATE SET *IS* THE EXISTENCE + VISIBILITY CHECK. `rows` MUST be
 *    the rows the caller can actually see, loaded through an EXISTING
 *    visibility predicate. An id that is not in `rows` resolves to
 *    `{ kind: "not_found" }` — it is NEVER passed through on the assumption
 *    that "an id must be real". That assumption is what writes a GHOST
 *    `belongs_to_project` edge (`relations.target_entity_id` has no FK to
 *    `projects`) which the project lens never resolves: a silent drop reported
 *    as success. See `routers/capture.ts:2260-2273`, which fixed the same class
 *    at the write door.
 */

export interface FocusCandidate {
  id: string;
  name: string;
}

export type FocusTargetMatch =
  | { kind: "resolved"; target: FocusCandidate }
  | {
      kind: "ambiguous";
      matchedBy: "name" | "substring";
      candidates: FocusCandidate[];
    }
  | { kind: "not_found" };

/**
 * Resolve `raw` (an id, an exact name, or a unique substring) against the
 * caller's VISIBLE rows.
 *
 * Order: exact id → exact case-insensitive name → unique case-insensitive
 * substring. Both name branches are ambiguity-checked; only the id branch can
 * ever be unambiguous by construction.
 */
export function matchFocusTarget(
  raw: string,
  rows: readonly FocusCandidate[]
): FocusTargetMatch {
  const needle = raw.trim();
  if (needle === "") return { kind: "not_found" };

  // 1) exact id — but ONLY among rows the caller can see. This is the
  //    existence + visibility verification; do not shortcut it.
  const byId = rows.find((r) => r.id === needle);
  if (byId) return { kind: "resolved", target: byId };

  const lowered = needle.toLowerCase();

  // 2) exact case-insensitive name — ambiguity-checked (see guard 1).
  const exactNames = rows.filter((r) => r.name.toLowerCase() === lowered);
  if (exactNames.length === 1) {
    return { kind: "resolved", target: exactNames[0]! };
  }
  if (exactNames.length > 1) {
    return { kind: "ambiguous", matchedBy: "name", candidates: exactNames };
  }

  // 3) unique case-insensitive substring — ambiguity-checked.
  const substrings = rows.filter((r) => r.name.toLowerCase().includes(lowered));
  if (substrings.length === 1) {
    return { kind: "resolved", target: substrings[0]! };
  }
  if (substrings.length > 1) {
    return {
      kind: "ambiguous",
      matchedBy: "substring",
      candidates: substrings,
    };
  }

  return { kind: "not_found" };
}

/** Whether the tool argument means "clear the focus" rather than "set it". */
export function isClearFocusArg(raw: unknown): boolean {
  const value = typeof raw === "string" ? raw.trim() : "";
  return value === "" || /^(none|clear|null)$/i.test(value);
}
