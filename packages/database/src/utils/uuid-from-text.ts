/**
 * THE UUID A TEXT SPELLS, for SQL that joins a uuid primary key to an id kept
 * as text (a JSONB metadata value, a text column).
 *
 * `pk::text = <text>` is correct but casts the KEY, so the planner cannot use
 * the primary-key index: every probe is a sequential scan. On the founder's
 * pod (27 Nov 2026) the session sweep's ended-run check did that against
 * `automation_runs` (63k rows, 660 MB) once per candidate session: 150 ms a
 * probe, 21 s a tick. `pk = uuidFromTextSql(<text>)` is an index probe.
 *
 * A bare `<text>::uuid` would throw on a malformed value and fail the whole
 * statement. This casts only text in the exact form Postgres prints a uuid
 * (lowercase, hyphenated); anything else is NULL, which matches no row. That
 * is the same answer `pk::text = <text>` gives for every input: the canonical
 * text of a uuid is the only text equal to `pk::text`.
 */
import { sql as drizzleSql, type SQL } from "drizzle-orm";

/** The exact text form of a uuid as Postgres prints it (`uuid::text`). */
export const CANONICAL_UUID_TEXT_PATTERN =
  "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";

const PATTERN_SQL = drizzleSql.raw(`'${CANONICAL_UUID_TEXT_PATTERN}'`);

/** SQL uuid: `text` as a uuid when it is a canonical uuid text, else NULL. Never throws. */
export function uuidFromTextSql(text: SQL): SQL {
  return drizzleSql`(CASE WHEN (${text}) ~ ${PATTERN_SQL} THEN (${text})::uuid END)`;
}
