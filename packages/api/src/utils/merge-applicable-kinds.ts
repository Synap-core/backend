/**
 * Widen a role's applicableKinds allowlist.
 *
 * NULL/empty on the stored row means "any kind" — there is nothing to add.
 * Callers MUST NOT use this to shrink: omit kinds the row already has and they
 * stay. A replace/shrink door does not exist here on purpose.
 */
export function mergeApplicableKinds(
  existing: readonly string[] | null | undefined,
  add: readonly string[] | null | undefined
): { next: string[] | null; widened: boolean } {
  // NULL = any kind (schema). Widening is a no-op.
  if (existing == null) {
    return { next: null, widened: false };
  }
  const next: string[] = [];
  const seen = new Set<string>();
  for (const raw of existing) {
    const s = raw.trim().toLowerCase();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    next.push(s);
  }
  let widened = false;
  for (const raw of add ?? []) {
    const s = raw.trim().toLowerCase();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    next.push(s);
    widened = true;
  }
  return { next, widened };
}
