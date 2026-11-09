/**
 * Backfill — a part follows its whole (founder decision 22226da5,
 * 2026-11-09): file in its entity's space every POD-WIDE document that is the
 * body of a live entity STORED in a space.
 *
 * Agent-written bodies (`synap_create_document({ entityId })`, a body written
 * before its entity was moved into a space) landed with `workspace_id` NULL
 * while their entity sat in a space. The read rule now shows such a body to
 * its entity's readers wherever it is stored (`spaceEntityBodyDocumentWhere`,
 * @synap/api utils/project-scope.ts) and new bodies are filed with their
 * entity; this moves the ones already stored, so that space's editors and a
 * key limited to it can also SAVE them, and a space purge reclaims them.
 *
 * Touches nothing but `documents.workspace_id`, and only on a live document
 * whose workspace is NULL and that is the body of live entities in exactly ONE
 * space. A body of entities in two spaces is AMBIGUOUS: counted, left
 * pod-wide (the read rule still shows it to both). Bodies of pod-wide entities
 * (homed or not), standalone documents and trashed rows are not candidates.
 * Idempotent: a filed body no longer matches.
 *
 * Run by `scripts/backfill-entity-body-spaces.ts` (dry run by default).
 */

import { sql } from "drizzle-orm";

export interface SpaceEntityBodyCounts {
  /** Pod-wide bodies of live entities in exactly one space. */
  fileable: number;
  /** Pod-wide bodies of live entities in two or more spaces: left alone. */
  ambiguous: number;
  /** Rows changed by this run (0 on a dry run). */
  filed: number;
}

type ExecDb = { execute: (query: ReturnType<typeof sql>) => Promise<unknown> };

/** postgres-js returns an array-like RowList; PGlite `{ rows }`. */
function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: T[] } | null)?.rows;
  return rows ? [...rows] : [...((result as Iterable<T>) ?? [])];
}

/**
 * The body documents to file, with the one space of their entities. ONE
 * definition, used by the count and the update alike.
 */
const OWNERS = sql`
  SELECT e.document_id AS document_id,
         (array_agg(DISTINCT e.workspace_id))[1] AS workspace_id,
         count(DISTINCT e.workspace_id) AS spaces
  FROM entities e
  JOIN documents d ON d.id = e.document_id
  WHERE e.deleted_at IS NULL
    AND e.workspace_id IS NOT NULL
    AND d.workspace_id IS NULL
    AND d.deleted_at IS NULL
  GROUP BY e.document_id
`;

export async function fileSpaceEntityBodies(
  database: ExecDb,
  opts: { apply: boolean }
): Promise<SpaceEntityBodyCounts> {
  const [counts] = rowsOf<{ fileable: unknown; ambiguous: unknown }>(
    await database.execute(sql`
      WITH owners AS (${OWNERS})
      SELECT count(*) FILTER (WHERE spaces = 1) AS fileable,
             count(*) FILTER (WHERE spaces > 1) AS ambiguous
      FROM owners
    `)
  );
  const fileable = Number(counts?.fileable ?? 0);
  const ambiguous = Number(counts?.ambiguous ?? 0);
  if (!opts.apply || fileable === 0) return { fileable, ambiguous, filed: 0 };

  const updated = rowsOf<{ id: string }>(
    await database.execute(sql`
      WITH owners AS (${OWNERS})
      UPDATE documents d
      SET workspace_id = o.workspace_id
      FROM owners o
      WHERE o.spaces = 1
        AND d.id = o.document_id
        AND d.workspace_id IS NULL
      RETURNING d.id
    `)
  );
  return { fileable, ambiguous, filed: updated.length };
}
