/**
 * Canonical "is this tool still advertised?" predicate.
 *
 * A tool is RETIRED, never deleted: `tools` has no foreign keys, so a DELETE
 * would silently strand every `links` / grant / secret reference pointing at it.
 * The duplicate-config repair (`packages/database/scripts/repair-duplicate-config-rows.ts`)
 * therefore flips a losing row to `status = 'inactive'` + `approved = false`.
 * Retiring only actually HIDES the row if the discovery reads agree on one
 * predicate — this is it.
 *
 * `status <> 'inactive'`, deliberately NOT `status = 'active'`:
 *   - `tools.status` is `["active","inactive","error"]`, notNull, DEFAULT
 *     'active' — so `<> 'inactive'` is a no-op for every existing row, which is
 *     what makes adding it safe.
 *   - `'error'` is a HEALTH state, not a retirement. A user must still SEE an
 *     errored tool in order to fix it; `= 'active'` would hide it — a regression.
 *
 * `approved` is deliberately NOT consulted here. It is orthogonal to `status`
 * (see the schema comment on the column): a tool is born NOT approved
 * (DEFAULT false), so filtering on it would hide a large number of legitimate
 * tools. `approved` gates EXECUTION — the dispatcher refuses an unapproved tool
 * at `connectors/external-dispatch.ts` — never visibility.
 */
import { ne, type SQL } from "@synap/database";
import { tools } from "@synap/database/schema";

export function toolNotRetiredWhere(): SQL {
  return ne(tools.status, "inactive");
}
