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
/**
 * The egress allowlist a skill's sandbox actually enforces, read out of the
 * free-form `metadata` bag.
 *
 * `metadata.allowedHosts` is the ONLY thing standing between an approved skill
 * and an arbitrary host: `run-skill-in-sandbox.ts:178` reads it, and
 * `host.fetch` refuses anything not on it (SSRF-checked, redirects rejected).
 * It is therefore execution-defining in every sense that matters — but it could
 * not be added to `RE_APPROVAL_FIELDS`, because `metadata` is a bag that is
 * SHALLOW-MERGED rather than spread, and is peeled off the update payload
 * before the field comparison ever runs (`routers/skills.ts`). So the fields
 * check literally cannot see it.
 *
 * The hole that left: re-pointing a declarative skill's `providerSpec.baseUrl`
 * at evil.com demotes it (there is a test), while ADDING evil.com to its egress
 * allowlist did not — the narrower-looking edit was the ungated one.
 */
export function allowedHostsChanged(
  metadataPatch: Record<string, unknown> | undefined,
  existingMetadata: Record<string, unknown> | null | undefined
): boolean {
  if (!metadataPatch || !("allowedHosts" in metadataPatch)) return false;
  const before = (existingMetadata ?? {})["allowedHosts"];
  // VALUE, not presence — mirrors `execFieldsChanged`. A form that re-sends an
  // unchanged allowlist on every save must not demote the skill, which is the
  // exact regression a presence test caused on the MCP-server door.
  return canonicalJson(metadataPatch["allowedHosts"]) !== canonicalJson(before);
}

/**
 * `metadata.readOnly` WIDENED — false/absent → true — on an already-approved
 * skill.
 *
 * Same blind spot as `allowedHostsChanged` and for the same structural reason:
 * `metadata` is shallow-merged and peeled off the update payload before
 * `RE_APPROVAL_FIELDS` is compared, so the fields check cannot see it.
 *
 * Why it is execution-defining. The capability gate short-circuits a verb
 * declaring `readOnly: true` to `run` BEFORE any grant rung
 * (`execute-capability.ts`) — it stops proposing and starts auto-executing on
 * every call. Flipping this bit on an approved verb therefore converts a
 * human-reviewed action into an unattended one without anyone re-reviewing it,
 * which is precisely the escalation the approval gate exists to prevent.
 *
 * ONE-DIRECTIONAL on purpose. true → false TIGHTENS governance (the verb goes
 * back to proposing), so it needs no re-approval; demoting on it would punish
 * the safe edit and train people to ignore demotions. Only the widening
 * direction resets approval.
 */
export function readOnlyWidened(
  metadataPatch: Record<string, unknown> | undefined,
  existingMetadata: Record<string, unknown> | null | undefined
): boolean {
  if (!metadataPatch || !("readOnly" in metadataPatch)) return false;
  // VALUE, not presence — a form re-sending an unchanged `true` must not
  // demote, the same regression a presence test caused on the MCP-server door.
  const before = (existingMetadata ?? {})["readOnly"] === true;
  return metadataPatch["readOnly"] === true && !before;
}

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
