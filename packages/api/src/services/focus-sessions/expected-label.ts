/**
 * Trim + casefold — the ONE comparison used on both sides of a label match.
 *
 * It lives in a LEAF module (no `@synap/database`, no imports at all) because
 * four places now compare a caller-supplied label to a declared slot label:
 * the satisfaction selector, the delegation door (`delegate-output.ts`), the
 * rejection return (`return-delegated-slot.ts`) and the signal id an owed slot
 * carries into the needs-you union (`services/signals/needs-you-union.ts`).
 * That last one is a DB-free module by construction, and importing the rule
 * from `satisfy-expected-output.ts` — which imports `db` — would have made the
 * pure union transitively DB-bound. Copying the two lines instead would be a
 * second answer to "is this the same slot", which is exactly the fork the
 * vocabulary rules forbid: a signal id that casefolds differently from the
 * matcher points at a slot no door can find.
 *
 * Re-exported from `satisfy-expected-output.ts` so the existing importers keep
 * their door and the implementation stays singular.
 */
export function normalizeExpectedLabel(
  label: string | null | undefined
): string | undefined {
  if (typeof label !== "string") return undefined;
  const trimmed = label.trim().toLowerCase();
  return trimmed || undefined;
}
