/**
 * Pure property-hint matcher for the retrieval re-rank. Kept separate from the
 * db-coupled orchestrator so it stays unit-testable.
 *
 * Matches property VALUES (never keys, never the serialized JSON blob), honors a
 * hint's target key when present, and requires a WORD BOUNDARY for short values
 * so role "vp" doesn't false-match "revamp" (a real bug the review caught).
 */
import type { PropertyHint } from "./understand-query.js";

const escapeRegex = (s: string): string =>
  s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function matchesHint(
  properties: Record<string, unknown>,
  hint: PropertyHint
): boolean {
  const haystacks = hint.key
    ? [properties[hint.key]]
    : Object.values(properties);
  const needle = hint.value.toLowerCase();
  const boundary =
    needle.length <= 4 ? new RegExp(`\\b${escapeRegex(needle)}\\b`) : null;
  return haystacks.some((v) => {
    if (v === null || v === undefined) return false;
    const s = String(v).toLowerCase();
    return boundary ? boundary.test(s) : s.includes(needle);
  });
}
