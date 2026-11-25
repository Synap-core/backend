/**
 * Re-entrancy guard for status-link propagation (Phase 0 of the dynamic status
 * links plan, decision aa0de6e6).
 *
 * A status move may ripple to linked entities through the governed
 * `moveStatus` door (see `propagate-status-link.ts`). That ripple is itself a
 * status move and would re-trigger propagation — one hop only is Phase 0's
 * behaviour, so the flag is set for the duration of one propagation pass and
 * the re-entrant call site in `move-status.ts` skips.
 *
 * Module-level, one per process: status moves run in this one module and the
 * flag is never persisted.
 */

export const propagationGuard = { active: false };

export function isPropagationActive(): boolean {
  return propagationGuard.active;
}

export function setPropagationActive(active: boolean): void {
  propagationGuard.active = active;
}
