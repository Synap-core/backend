/**
 * The rows of a raw `database.execute(sql)`: postgres-js returns the rows,
 * PGlite / node-postgres wrap them in `rows`. ONE helper for every caller.
 */
export function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}
