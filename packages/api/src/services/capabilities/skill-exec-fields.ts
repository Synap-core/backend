/**
 * THE definition of "execution-defining content" for a `skills` row — the ONE
 * rule that decides whether an already-approved skill must be demoted.
 *
 * It lives in this dependency-free leaf (only `canonicalJson`) because BOTH
 * doors that can rewrite a skill row must apply the identical rule:
 *   - `routers/skills.ts` → `update` (the human/agent edit door)
 *   - `services/capabilities/create-from-definition.ts` (the template applier)
 * The applier cannot statically import the router (services → routers cycles —
 * `reconcile-standalone-configs-to-templates.ts` uses a dynamic import for
 * exactly that reason), so the shared rule cannot live in the router.
 *
 * It was defined twice before, and the two definitions disagreed: the applier
 * compared only kind/code/providerSpec, which left `parameters`,
 * `executionMode` and `timeoutSeconds` swappable under an existing approval.
 */

import { canonicalJson } from "./capability-drift.js";

/**
 * Execution-defining fields — a change to any of them means the skill may now
 * run different code, so an approved row is demoted.
 */
export const RE_APPROVAL_FIELDS = [
  "code",
  // For a `declarative` skill the providerSpec IS the executable — it defines
  // the HTTP call (baseUrl, method, path, headers). Re-pointing it is `code`'s
  // equivalent, so it must reset approval too; without this, making it
  // updatable would let an approved declarative skill be silently aimed at a
  // different endpoint while staying approved.
  "providerSpec",
  "parameters",
  "executionMode",
  "timeoutSeconds",
  "kind",
] as const;

/**
 * The ONE comparison rule: true when `patch` actually CHANGES any of `fields`
 * relative to the already-loaded `existing` row.
 *
 * PARAMETERISED over the field list on purpose. The *rule* (value, not
 * presence; canonical JSON, not raw stringify) is universal; the *vocabulary*
 * is not — a skill's execution surface (code/providerSpec/parameters/…) is not
 * a tool's (credentialRef/config/executor/…) is not an MCP server's
 * (command/args/env/url/transport). Merging the three lists would demote rows
 * on fields they do not even have; merging the three comparisons is the whole
 * point. Each door keeps its own list next to its own entity and calls this.
 *
 * Callers: `skillExecFieldsChanged` below, `routers/tools.ts` (update),
 * `routers/mcp-servers.ts` (update).
 */
export function execFieldsChanged(
  fields: readonly string[],
  patch: Record<string, unknown>,
  existing: Record<string, unknown>
): boolean {
  return fields.some(
    (k) =>
      patch[k] !== undefined &&
      canonicalJson(patch[k]) !== canonicalJson(existing[k])
  );
}

/**
 * True when a skill patch actually CHANGES an execution-defining field.
 *
 * PRESENCE is not change, and testing presence was a live defect. The
 * standalone-config reconcile replays a three-way merge that assigns EVERY key
 * of the install baseline — six of these seven fields among them — whenever ANY
 * field drifts. So an upstream description typo-fix re-sent `code`/
 * `providerSpec`/`parameters` byte-identically, the presence test fired, and a
 * market-installed skill was set `approved: false` on every reconcile pass: it
 * silently stopped being runnable, and re-broke each boot.
 *
 * Canonical (key-sorted) JSON because jsonb does not preserve key order — a
 * plain stringify would report change on key order alone.
 */
export function skillExecFieldsChanged(
  patch: Record<string, unknown>,
  existing: Record<string, unknown>
): boolean {
  return execFieldsChanged(RE_APPROVAL_FIELDS, patch, existing);
}
