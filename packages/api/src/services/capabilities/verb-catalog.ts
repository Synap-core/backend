/**
 * The `tools.capabilities` verb-catalog merge — ONE id-keyed upsert, shared by
 * both writers of that jsonb array: `createDeclarativeVerb` (a user minting a
 * single verb) and `createCapabilityFromDefinition` (a template re-apply
 * projecting its whole declared set).
 *
 * Leaf module on purpose: pure, no I/O, and no imports beyond the row type, so
 * either writer can import it without pulling the other's router graph in (they
 * already import each other in one direction).
 */

import type { ToolVerbCatalogEntry } from "@synap/database/schema";

/**
 * Idempotent merge of ONE verb into a tool's `tools.capabilities` catalogue.
 *
 * The catalogue is keyed by `id` (the backing skill's name), so re-creating a
 * verb of the same name REPLACES its entry instead of appending a duplicate —
 * `capability-registry` would otherwise render the same verb twice and the
 * stale entry would keep an outdated `argsSchema`. Position is preserved on
 * replace so the catalogue's order stays stable across re-creates.
 *
 * Pure (no I/O) — the caller does the one-line drizzle update.
 */
export function upsertVerbCatalogEntry(
  existing: ToolVerbCatalogEntry[] | null | undefined,
  entry: ToolVerbCatalogEntry
): ToolVerbCatalogEntry[] {
  const current = Array.isArray(existing) ? existing : [];
  const at = current.findIndex((v) => v.id === entry.id);
  if (at === -1) return [...current, entry];
  const next = [...current];
  next[at] = entry;
  return next;
}

/**
 * Fold a template's WHOLE projected verb set into a live catalogue.
 *
 * ADDITIVE by construction: a declared verb overwrites its live entry by `id`
 * (this is how a template field like `intent` reaches the pod), while a live
 * verb the template does NOT declare is left untouched — a user-minted verb
 * (`createDeclarativeVerb`) must survive the next re-apply. This is the exact
 * subset semantics `capabilityVerbCatalogDrift` compares with, so a converged
 * tool reports no drift on the following pass instead of re-applying forever.
 *
 * Order is deterministic: existing positions are preserved, newly-declared
 * verbs append in template order — a churning jsonb array order would itself
 * read as permanent drift.
 */
export function mergeVerbCatalog(
  existing: ToolVerbCatalogEntry[] | null | undefined,
  projected: ToolVerbCatalogEntry[]
): ToolVerbCatalogEntry[] {
  return projected.reduce(upsertVerbCatalogEntry, existing ?? []);
}
