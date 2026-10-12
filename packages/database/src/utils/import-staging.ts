/**
 * A STAGED import item (Import → Curate → Build) is an intake-source document
 * that carries `metadata.intakeSource.pending = "awaiting_curation"` until its
 * group is built. Nothing lists it as a capture or a document, and the search
 * reindex skips it: it is the person's raw batch, not yet anybody's record.
 *
 * The value mirrors `IMPORT_STAGED_MARKER` in `@synap-core/types/imports`
 * (this package does not depend on that one); a parity test in `@synap/api`
 * (`services/imports/__tests__/staged-marker-parity.test.ts`) keeps them equal.
 */

import { sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

export const IMPORT_AWAITING_CURATION = "awaiting_curation";

/**
 * `metadata` does NOT carry the staged marker. Spelled `IS DISTINCT FROM` so a
 * row with no metadata / no intake source (NULL) is kept, never dropped.
 */
export function notStagedImportItemWhere(metadataColumn: AnyPgColumn): SQL {
  return sql`(${metadataColumn} #>> '{intakeSource,pending}') IS DISTINCT FROM ${IMPORT_AWAITING_CURATION}`;
}

/** True when a document's metadata bag marks it as a staged import item. */
export function isStagedImportItem(metadata: unknown): boolean {
  const source = (metadata as { intakeSource?: { pending?: unknown } } | null)
    ?.intakeSource;
  return source?.pending === IMPORT_AWAITING_CURATION;
}
