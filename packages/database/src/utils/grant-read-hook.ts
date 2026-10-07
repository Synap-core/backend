/**
 * W1 — the grant clause, reachable from database-level visibility helpers.
 *
 * The clause itself lives in `@synap/api` (`access/grant-read.ts`, it needs the
 * per-table subject map and the project lens), which this package must not
 * import. The API REGISTERS it at load (`registerGrantReadProvider`), the same
 * pattern as `onApiKeysRevoked`; helpers here call `grantReadClauseFor(column)`.
 * A process that registers nothing (realtime, a script) carries no key grant,
 * so it adds no clause. If a SCOPED grant ever reaches such a process the
 * clause is deny-all: an unregistered provider must never read as "no limit".
 *
 * Imported by the API through its own subpath (`@synap/database/grant-read-hook`)
 * so a test that mocks the `@synap/database` barrel still loads the real hook.
 */
import { sql, type SQL } from "drizzle-orm";
import { getRequestGrant, isFullAccessGrant } from "./request-write-context.js";

type Provider = (table: object) => SQL | undefined;
let provider: Provider | null = null;

/** The API registers its grant clause builder once at load. */
export function registerGrantReadProvider(fn: Provider): void {
  provider = fn;
}

/** The request's grant clause for the table that owns `column`, if any. */
export function grantReadClauseFor(column: unknown): SQL | undefined {
  if (!provider) {
    const grant = getRequestGrant();
    return grant && !isFullAccessGrant(grant) ? sql`false` : undefined;
  }
  const table = (column as { table?: object } | null)?.table;
  return table ? provider(table) : undefined;
}
