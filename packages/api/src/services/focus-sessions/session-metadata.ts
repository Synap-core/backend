import { drizzleSql, focusSessions } from "@synap/database";
import type { SQL } from "@synap/database";

/**
 * Merge a sub-object into `focus_sessions.metadata` without clobbering the
 * rest of the bag — ONE helper for every session-lifecycle stamp (triage,
 * conversion receipts). JSONB `||` is a shallow merge: pass the whole
 * sub-object you want stored under its key.
 */
export function mergeSessionMetadata(patch: Record<string, unknown>): SQL {
  return drizzleSql`${focusSessions.metadata} || ${JSON.stringify(patch)}::jsonb`;
}

/** Shape floor for ids that reach a query — a non-uuid can never match a row. */
export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
