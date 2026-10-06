/**
 * An AGENT's capability allowlist, edited as a grant.
 *
 * `users.agentMetadata.capabilities` gates an agent's WRITES at the governance
 * gate (rung 1, `agentHasCapability`), which reads the same grammar as a key's
 * grant — so the one grant editor edits both. Three differences, all mapped
 * here and nowhere else:
 *
 *  - **Empty means unrestricted.** A stored `[]` (or the legacy `*.*`) is full
 *    access; the draft spells that `*`. And the reverse: an EMPTY draft must
 *    NOT be stored as `[]` (that would read as full access — the trap the old
 *    matrix had), so it is stored as the read-only list.
 *  - **Reads are always allowed.** The gate exempts reads; an agent reads what
 *    its person can read. The editor shows the read column as on and locked
 *    (`AGENT_ALWAYS_ALLOWED`) rather than pretending a checkbox bounds it.
 *  - **More subjects.** Agents also build: kinds and properties.
 */

import {
  GRANT_SUBJECT_CATALOG,
  type GrantAction,
  type GrantSubjectSpec,
} from "./catalog.js";
import { normalizeGrantPermissions, type GrantDraft } from "./draft.js";

/** Actions an agent can never be refused at the gate (it reads what you read). */
export const AGENT_ALWAYS_ALLOWED: readonly GrantAction[] = ["read"];

/** The subjects an agent editor offers: the grant catalog plus building. */
export const AGENT_GRANT_CATALOG: readonly GrantSubjectSpec[] = [
  ...GRANT_SUBJECT_CATALOG,
  { subject: "profile", actions: ["read", "create", "update", "delete"] },
  { subject: "property_def", actions: ["read", "create", "update", "delete"] },
];

/** Stored when an agent may write nothing: non-empty, permits no write. */
export const AGENT_READ_ONLY_CAPABILITIES: readonly string[] = ["entity.read"];

const LEGACY_FULL = "*.*";

/** Stored capabilities → the draft the editor shows. */
export function agentCapabilitiesToDraft(
  capabilities: readonly string[] | null | undefined
): GrantDraft {
  const caps = (capabilities ?? []).map((c) => c.trim()).filter(Boolean);
  if (caps.length === 0 || caps.includes(LEGACY_FULL) || caps.includes("*"))
    return { permissions: ["*"] };
  return { permissions: normalizeGrantPermissions(caps) };
}

/** The draft → what `agentUsers.update({ capabilities })` stores. */
export function draftToAgentCapabilities(draft: GrantDraft): string[] {
  const perms = normalizeGrantPermissions(draft.permissions);
  if (perms.includes("*")) return [];
  // Empty would read as unrestricted; any non-empty list permits only what
  // it names, so read patterns are kept as written (a preset round-trips).
  if (perms.length === 0) return [...AGENT_READ_ONLY_CAPABILITIES];
  return perms;
}

/** Is this stored list unrestricted (full access)? */
export function isUnrestrictedAgent(
  capabilities: readonly string[] | null | undefined
): boolean {
  return agentCapabilitiesToDraft(capabilities).permissions.includes("*");
}
