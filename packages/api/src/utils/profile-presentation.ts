/**
 * THE ONE READER between a stored profile row and the human-facing
 * `description` / `icon` every listing door (discover's summary + full tiers,
 * the MCP `synap_list_profiles` digest, the REST `/profiles` digest, and
 * orient's profile sample) advertises.
 *
 * ── Why this file exists (measured live, 2026-09-14) ────────────────────────
 * `profiles` has NO `description` or `icon` column (`@synap/database`
 * `schema/profiles.ts`) — both live inside `uiHints` jsonb (`{ icon, color,
 * description }`). Every door that built its wire shape from
 * `p.description ?? null` / `p.icon ?? null` was reading a key that has never
 * existed on a `Profile` row, so it always emitted `null` regardless of what
 * the profile actually carries. Measured on the live pod: `GET
 * /api/hub/discover` returned `description: null, icon: null` for all 118
 * rows, while 118/118 carry `uiHints.description` and 115/118 carry
 * `uiHints.icon`. Same class of bug `property-presentation.ts`
 * (`@synap/database`) fixed for property defs — a door reading a key nothing
 * writes.
 */

interface HintBag {
  [key: string]: unknown;
}

/** A profile row as read back from the database (or a tRPC projection of one). */
export interface StoredProfilePresentation {
  uiHints?: unknown;
}

function asBag(value: unknown): HintBag | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as HintBag)
    : undefined;
}

function asTrimmedStringOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** This profile's human-facing description: `uiHints.description`, or `null`. */
export function resolveProfileDescription(
  profile: StoredProfilePresentation
): string | null {
  return asTrimmedStringOrNull(asBag(profile.uiHints)?.description);
}

/** This profile's icon key: `uiHints.icon`, or `null`. */
export function resolveProfileIcon(
  profile: StoredProfilePresentation
): string | null {
  return asTrimmedStringOrNull(asBag(profile.uiHints)?.icon);
}
