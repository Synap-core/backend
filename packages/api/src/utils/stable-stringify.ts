/**
 * Deterministic JSON serialization for change detection: object keys are
 * sorted recursively, so two semantically equal payloads that differ only in
 * key insertion order compare equal. Used by the definition version bumps —
 * a re-serialized editor save must not inflate the version.
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
