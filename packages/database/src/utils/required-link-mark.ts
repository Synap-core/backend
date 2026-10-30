/**
 * A REQUIRED link, as a template declares it (`entityLinks[].required`) and as
 * the pod stores it: `profile_relations.metadata.required` (+ `requiredBy`, the
 * template that asked). The ONE reader and the ONE writer of that mark: the
 * reconcile writes it through `withRequiredLinkMark`, the warn and list doors
 * (`@synap/api` services/links/required-links.ts) read it through
 * `readRequiredLinkMark`.
 *
 * The comparator is exactly the two keys the writer sets, so a reconcile that
 * finds them equal has nothing to write, and one that finds them different
 * rewrites exactly them (backend-rules: a marker asserts only what the
 * comparator checked).
 */

export interface RequiredLinkMark {
  required: true;
  /** The template slug that declared it, when the reconcile knew one. */
  requiredBy: string | null;
}

export function readRequiredLinkMark(
  metadata: unknown
): RequiredLinkMark | null {
  if (!metadata || typeof metadata !== "object") return null;
  const bag = metadata as Record<string, unknown>;
  if (bag.required !== true) return null;
  return {
    required: true,
    requiredBy: typeof bag.requiredBy === "string" ? bag.requiredBy : null,
  };
}

/**
 * The metadata a link should carry once the template's `required` is applied.
 * `declared` undefined = the template says nothing: the stored mark stays (two
 * templates sharing a link never undo each other's mark by silence). `false`
 * clears it. Every other key of the bag is kept.
 */
export function withRequiredLinkMark(
  metadata: unknown,
  declared: boolean | undefined,
  templateSlug: string | null
): { metadata: Record<string, unknown>; changed: boolean } {
  const bag: Record<string, unknown> =
    metadata && typeof metadata === "object"
      ? { ...(metadata as Record<string, unknown>) }
      : {};
  if (declared === undefined) return { metadata: bag, changed: false };
  const before = readRequiredLinkMark(bag);
  if (declared) {
    const requiredBy = templateSlug ?? before?.requiredBy ?? null;
    const changed = !before || before.requiredBy !== requiredBy;
    bag.required = true;
    if (requiredBy) bag.requiredBy = requiredBy;
    else delete bag.requiredBy;
    return { metadata: bag, changed };
  }
  const changed = before !== null || "requiredBy" in bag;
  delete bag.required;
  delete bag.requiredBy;
  return { metadata: bag, changed };
}
