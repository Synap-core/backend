/**
 * verb-launchable — the ONE predicate for "can the execute door launch this
 * tool verb / anything on this tool row". Dependency-free on purpose: both the
 * runnable-action projection (`action-projection.ts`) and the sectioned
 * catalogue's `blocked:{kind:"enable"}` (`capability-registry.ts`) read it, and
 * the registry must not pull the catalog/connector graph in to reach it.
 *
 * WHAT IT IS NOT: a GRANT check. A tool-level `vault_grants` row
 * (`grantableType:'tool'`) is a governance posture for AGENT runs — no grant
 * means the run is PROPOSED for review (`gateCapabilityExecution`, step 2),
 * never refused. It authorizes no credential (a vault secret is its own
 * `grantableType:'secret'` grant; a Nango provider resolves by connection).
 * The only thing that REFUSES a run is approval: `approved === false` →
 * `not_approved` (execute-capability.ts). Deriving "needs enable" from grants
 * reported Google as blocked while every verb was runnable, and no switch could
 * clear it — enabling flips `approved`, it never issues a grant (2026-09-28).
 * The grant fact stays where it belongs: each verb's run posture (`governance`).
 */

/** A verb as the registry projects it (`buildVerbStates`). */
export interface LaunchableVerbFacts {
  /** Backing skill is active + approved — the execute door resolves THIS. */
  backingSkillExecutable?: boolean;
}

/** The execute door can launch this verb: its backing skill clears lifecycle + approval. */
export function isVerbLaunchable(verb: LaunchableVerbFacts): boolean {
  return verb.backingSkillExecutable === true;
}

/**
 * The tool row's approval (`enabled`) holds AND at least one verb is launchable.
 * A verbless row falls back to its own approval — there is no verb to judge.
 * Connection is a SEPARATE blocker (a different fix), deliberately not folded in.
 */
export function isToolRowLaunchable(row: {
  enabled: boolean;
  verbs: ReadonlyArray<LaunchableVerbFacts>;
}): boolean {
  if (row.enabled !== true) return false;
  return row.verbs.length === 0 || row.verbs.some(isVerbLaunchable);
}
