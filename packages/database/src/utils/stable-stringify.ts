/**
 * Deterministic JSON serialization: object keys are sorted recursively, so two
 * semantically equal payloads that differ only in key insertion order compare
 * equal. Used by the pending-proposal dedup hash (insert-pending-proposal.ts) so
 * an agent that re-proposes the same change — with its object keys in a different
 * order — still hashes identically and is deduped.
 *
 * Mirrors packages/api/src/utils/stable-stringify.ts. It is duplicated (not
 * imported) because @synap/api depends on @synap/database, so @synap/database
 * cannot import from @synap/api without a circular dependency.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      out[key] = sortKeys(source[key]);
    }
    return out;
  }
  return value;
}
