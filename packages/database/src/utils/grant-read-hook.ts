/**
 * W1 — the grant clause, reachable from database-level visibility helpers.
 *
 * The clause itself lives in `@synap/api` (`access/grant-read.ts`, it needs the
 * per-table subject map and the project lens), which this package must not
 * import. The API REGISTERS it at load (`registerGrantReadProvider`), the same
 * pattern as `onApiKeysRevoked`; helpers here call `grantReadClauseFor(column)`.
 * A process that registers nothing (realtime, a script) adds no clause — and
 * carries no key grant either.
 */
import type { SQL } from "drizzle-orm";

type Provider = (table: object) => SQL | undefined;
let provider: Provider | null = null;

/** The API registers its grant clause builder once at load. */
export function registerGrantReadProvider(fn: Provider): void {
  provider = fn;
}

/** The request's grant clause for the table that owns `column`, if any. */
export function grantReadClauseFor(column: unknown): SQL | undefined {
  if (!provider) return undefined;
  const table = (column as { table?: object } | null)?.table;
  return table ? provider(table) : undefined;
}
