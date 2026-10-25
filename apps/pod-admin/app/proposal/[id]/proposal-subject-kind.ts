/**
 * The kind a proposal is about — the ONE derivation the session page, Review's
 * rows and the review page read.
 *
 * An entity proposal's `targetType` is the generic `entity`; the thing's own
 * kind is the profile slug its payload carries (`profileSlug`, else `type`).
 * Anything else keeps its `targetType`.
 */

/** The profile slug a payload names (`profileSlug`, else `type`), or null. */
export function proposalProfileSlug(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const { profileSlug, type } = payload as Record<string, unknown>;
  for (const slug of [profileSlug, type]) {
    if (typeof slug === "string" && slug.trim()) return slug.trim();
  }
  return null;
}

export function proposalSubjectKind(
  p: { targetType: string },
  payload: unknown
): string {
  return p.targetType === "entity"
    ? (proposalProfileSlug(payload) ?? p.targetType)
    : p.targetType;
}
