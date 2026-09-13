/**
 * A run's "What came in" — the stored intake sources of one session, as the
 * room lists them for selection ("Rerun selected", "Rerun only the degraded
 * sources").
 *
 * Reads the SAME rows the rerun plan counts (`loadSourceRows`), so a source the
 * list marks degraded or missing is exactly one the dry run counts that way.
 * Metadata only — no bodies.
 *
 * `null` = the session is not the caller's (the procedure answers NOT_FOUND). A
 * failed read throws: an empty list means the run kept no sources, never that
 * they could not be read.
 */

import { db, and, eq, focusSessions } from "@synap/database";
import { readSessionRunManifest } from "../intake/record-session-run-manifest.js";
import type { IntakeSourceKind } from "../intake/stage-intake-source.js";
import { loadSourceRows, RERUN_MAX_SOURCES } from "./rerun-session.js";

/** A run lists at most this many sources (a manifest can hold more). */
export const RUN_SOURCES_LIST_MAX = 200;

export interface RunSourceRow {
  sourceDocumentId: string;
  title: string;
  kind: IntakeSourceKind;
  /** Structuring did not run on it (spend guard, IS down) — kept for re-structure. */
  degraded: { reason: string; at: string } | null;
  /** A later structure of the same source cleared its degraded marker. */
  restructuredAt: string | null;
  filename: string | null;
  url: string | null;
}

export interface RunSources {
  sessionId: string;
  sources: RunSourceRow[];
  /** In the manifest, but the document is gone (deleted / not the caller's). */
  missing: string[];
  /** Every source id the manifest holds, listed or not. */
  total: number;
  /** The rerun door's cap, so a selection can say it before the dry run does. */
  rerunCap: number;
}

export async function listRunSources(args: {
  sessionId: string;
  userId: string;
  database?: typeof db;
}): Promise<RunSources | null> {
  const database = args.database ?? db;
  const [row] = await database
    .select({ id: focusSessions.id, metadata: focusSessions.metadata })
    .from(focusSessions)
    .where(
      and(
        eq(focusSessions.id, args.sessionId),
        eq(focusSessions.userId, args.userId)
      )
    )
    .limit(1);
  if (!row) return null;

  const ids = readSessionRunManifest(row.metadata)?.sourceDocumentIds ?? [];
  const rows = await loadSourceRows(
    database,
    args.userId,
    ids.slice(0, RUN_SOURCES_LIST_MAX)
  );
  return {
    sessionId: row.id,
    sources: rows.present.map((r) => ({
      sourceDocumentId: r.sourceDocumentId,
      title: r.row.title,
      kind: r.meta.kind,
      degraded: r.meta.degraded ?? null,
      restructuredAt: r.meta.restructuredAt ?? null,
      filename: r.meta.filename ?? null,
      url: r.meta.url ?? null,
    })),
    missing: rows.missing,
    total: ids.length,
    rerunCap: RERUN_MAX_SOURCES,
  };
}
