/**
 * Rule EXPIRY — the enforced half.
 *
 * A rule may carry `metadata.rule.expiresAt`, an ISO-8601 UTC instant after
 * which it stops influencing anything. This module is the ONE place that
 * decides what "expired" means, and it is a LEAF: it imports the `skills` table
 * and drizzle's SQL builder, nothing else. `services/rules/index.ts` pulls the
 * normaliser from here rather than the other way round, so the predicate can be
 * ANDed into `services/skills/visibility.ts` without dragging the links service
 * (and a cycle) along with it.
 *
 * ── WHY A TEXT COMPARISON AND NOT `::timestamptz` ──────────────────────────
 * `metadata` is JSONB, so the stored value is a STRING. Casting it in SQL
 * (`(metadata #>> '{rule,expiresAt}')::timestamptz`) would throw on any
 * malformed value — and Postgres does not guarantee short-circuit evaluation of
 * an `OR`, so one hand-edited row could make the whole LIST query error out.
 *
 * Instead the write door normalises every value through `normalizeExpiresAt`
 * to `Date#toISOString()` — a fixed-width, UTC, zero-padded
 * `YYYY-MM-DDTHH:mm:ss.sssZ`. Over that canonical form lexicographic order IS
 * chronological order, so a plain `>` on text is exact, never throws, and stays
 * index-friendly. A value that cannot be normalised is REJECTED at the write
 * door rather than stored, so the comparison never sees a foreign format.
 *
 * ── ABSENT MEANS "NO EXPIRY", NEVER "EXPIRED" ──────────────────────────────
 * Mirrors the enforced `governance_rules` pattern
 * (`isNull(expiresAt) OR gt(expiresAt, now())`). Every rule written before this
 * field existed carries no key at all, so `#>>` yields SQL NULL and the row
 * stays visible. No migration, no backfill.
 */

import { drizzleSql, type SQL } from "@synap/database";
import { skills } from "@synap/database/schema";

/** JSONB path to the expiry instant on a rule row. */
const EXPIRES_AT_PATH = "{rule,expiresAt}";

/**
 * Canonicalise an author-supplied expiry into the exact string form the SQL
 * predicate can compare as text. Returns `undefined` for absent input and
 * throws for input that is present but not a real instant — a rule that says
 * "expires 2026-13-45" must not silently become a rule that never expires.
 */
export function normalizeExpiresAt(
  raw: string | Date | null | undefined
): string | undefined {
  if (raw === null || raw === undefined) return undefined;
  const d = raw instanceof Date ? raw : new Date(raw);
  if (Number.isNaN(d.getTime())) {
    throw new Error(
      `Rule expiresAt is not a valid instant: ${JSON.stringify(raw)}`
    );
  }
  return d.toISOString();
}

/**
 * Same normalisation, but for STORED data — a JSONB blob is data, not a
 * contract, so an unreadable value reads as absent rather than throwing a read
 * door. (The write door is where a bad value is refused.)
 */
export function readExpiresAt(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/**
 * Is this rule still in effect at `now`? The JS mirror of the SQL predicate,
 * for callers already holding a decoded blob.
 */
export function isRuleExpired(
  expiresAt: string | undefined,
  now: Date = new Date()
): boolean {
  if (!expiresAt) return false;
  return expiresAt <= now.toISOString();
}

/**
 * The SQL half: rows whose rule has NOT expired. Vacuously true for every row
 * that is not a rule (no `metadata.rule` ⇒ `#>>` is NULL), which is what makes
 * it safe to AND into the shared skill visibility predicate.
 */
export function ruleNotExpiredWhere(now: Date = new Date()): SQL {
  const nowIso = now.toISOString();
  return drizzleSql`(${skills.metadata} #>> ${EXPIRES_AT_PATH} IS NULL OR ${skills.metadata} #>> ${EXPIRES_AT_PATH} > ${nowIso})`;
}
