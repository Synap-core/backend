/**
 * SLOT KEYS — a declared deliverable's stable identity, stamped by the server.
 *
 * Every slot door used to find "the" slot by its LABEL (prose, rewordable,
 * clipped in places). An outcome needs an identity that survives a reworded
 * label, so every slot now carries a `key` (A2 of the outcome model):
 *
 *   - DERIVED by ONE function (`deriveSlotKeys`, `@synap-core/types/units`) —
 *     a slug of the label, `-2`/`-3` on collision, in array order — so the key
 *     a reader projects for a slot stored before keys existed is the key the
 *     next write stamps on it (`projectSessionOutcomes` reads the same way).
 *   - CARRIED, never re-minted: a write that rebuilds the array (the wholesale
 *     merge, `addOutput`, the locked mutators) gets each prior slot's key back
 *     onto the slot that replaces it ({@link carrySlotKeys}), matched by the
 *     same trim+casefold label rule every door uses. A legacy slot's DERIVED
 *     key is what gets frozen on its first write.
 *   - Never authored by a client: the wire schema does not carry `key`, so an
 *     agent cannot name, move or forge one. (Opening it to declarers is the
 *     external-contract wave, A4.)
 *
 * Lookups prefer the key and fall back to the label ({@link findSlotIndex}),
 * so a caller holding either finds the same slot, and every caller that only
 * knows labels keeps working unchanged.
 *
 * A LEAF: no `@synap/database`, so pure doors and the governance layer can
 * import it without becoming DB-bound (the `expected-label.ts` precedent).
 */

import { deriveSlotKeys, stampSlotKeys } from "@synap-core/types/units";
import { normalizeExpectedLabel } from "./expected-label.js";

export { deriveSlotKeys, stampSlotKeys };

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function labelOf(v: unknown): string | undefined {
  const label = asRecord(v)?.label;
  return typeof label === "string" ? label : undefined;
}

function storedKeyOf(v: unknown): string | undefined {
  const key = asRecord(v)?.key;
  return typeof key === "string" && key.trim() ? key.trim() : undefined;
}

/**
 * `next` with every slot keyed: a slot that already carries a key keeps it; a
 * slot without one inherits the key of the PRIOR slot it replaces (same
 * label, first unused prior wins — the merge's own tie-break), stored or
 * derived; anything left is minted by {@link stampSlotKeys}. Pure.
 */
export function carrySlotKeys<T>(prior: readonly unknown[], next: T[]): T[] {
  const priorKeys = deriveSlotKeys(prior);
  const byLabel = new Map<string, string>();
  prior.forEach((slot, i) => {
    const label = normalizeExpectedLabel(labelOf(slot));
    const key = priorKeys[i];
    if (label && key && !byLabel.has(label)) byLabel.set(label, key);
  });
  const used = new Set<string>();
  for (const slot of next) {
    const own = storedKeyOf(slot);
    if (own) used.add(own);
  }
  const carried = next.map((slot) => {
    const record = asRecord(slot);
    if (!record || storedKeyOf(slot)) return slot;
    const key = byLabel.get(normalizeExpectedLabel(labelOf(slot)) ?? "");
    if (!key || used.has(key)) return slot;
    used.add(key);
    return { ...record, key } as T;
  });
  return stampSlotKeys(carried);
}

/** The key of slot `index` (stored, else derived). `null` out of range. */
export function slotKeyAt(
  slots: readonly unknown[],
  index: number
): string | null {
  if (index < 0 || index >= slots.length) return null;
  return deriveSlotKeys(slots)[index] ?? null;
}

/**
 * The FIRST slot a caller names that `accept`s — by KEY first (stored or
 * derived, exact), then by LABEL (trim + casefold). `ref` may be a key, a
 * label, or both; a bare string is tried as a key and then as a label, so a
 * door that only ever received labels keeps resolving them. `-1` when none.
 */
export function findSlotIndex<T>(
  slots: readonly T[],
  ref: string | { key?: string | null; label?: string | null },
  accept: (slot: T, index: number) => boolean = () => true
): number {
  const key = typeof ref === "string" ? ref.trim() : ref.key?.trim();
  const label = normalizeExpectedLabel(
    typeof ref === "string" ? ref : ref.label
  );
  if (key) {
    const keys = deriveSlotKeys(slots);
    const byKey = slots.findIndex((s, i) => keys[i] === key && accept(s, i));
    if (byKey !== -1) return byKey;
  }
  if (!label) return -1;
  return slots.findIndex(
    (s, i) => normalizeExpectedLabel(labelOf(s)) === label && accept(s, i)
  );
}

/**
 * The slot KEY a proposal claims (`proposals.data.expectedKey`), written beside
 * `expectedLabel` by `checkPermissionOrPropose`. The label stays the alias every
 * pending proposal filed before keys existed carries; readers try the key first.
 */
export function readProposalExpectedKey(data: unknown): string | undefined {
  const value = asRecord(data)?.expectedKey;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** The shape a DECLARED key must have: the same alphabet `slotKeyBase` mints. */
export const DECLARED_SLOT_KEY_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * A key a declarer PROPOSED for a slot at its birth (`outcomes[].key`), or
 * `undefined` when it is absent, malformed, or already `taken` by another
 * slot. Never honoured on an existing slot — a stored key is a receipt.
 */
export function declaredSlotKey(
  value: unknown,
  taken: ReadonlySet<string> = new Set()
): string | undefined {
  if (typeof value !== "string") return undefined;
  const key = value.trim();
  return DECLARED_SLOT_KEY_RE.test(key) && !taken.has(key) ? key : undefined;
}
