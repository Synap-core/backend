/**
 * When a pending proposal stops being a decision: its asked-at time plus its
 * class's lifetime (`lifetimeHours`, the pod's — `proposalClassFields`), the
 * rule the pod's expiry sweep applies. The sweep runs every few hours, so a
 * proposal can still read `pending` after its moment passed: past this
 * instant it is history, never a decision, on every console surface.
 */

import { lensRowExpiry } from "@synap-core/types/lens";

/** The instant it expires (ISO), or null when it never does. */
export function proposalExpiresAt(
  at: string | Date | null | undefined,
  lifetimeHours: number | null | undefined
): string | null {
  if (lifetimeHours == null || !Number.isFinite(lifetimeHours) || !at)
    return null;
  const start = at instanceof Date ? at.getTime() : Date.parse(at);
  return Number.isFinite(start)
    ? new Date(start + lifetimeHours * 3_600_000).toISOString()
    : null;
}

/** Its moment passed (the shared expiry reading, `lensRowExpiry`). */
export function proposalLapsed(
  expiresAt: string | null,
  now: number = Date.now()
): boolean {
  return lensRowExpiry({ expiresAt }, now)?.expired === true;
}
