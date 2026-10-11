/**
 * The lifecycle floor for a row BORN with a status (founder decision
 * 2026-10-11): an agent creating an entity, or attaching a role, directly in a
 * done/lost option — or in a human-only one — is governed like a MOVE from
 * `null` into it (`lifecycleMove`, rungs 2.075 / 2.85).
 *
 * TIGHTEN-ONLY: the returned classification is passed to the create/attach
 * gate ONLY when it would propose. A born row in an open/active/paused option
 * returns `undefined`, so rung 2.86 (execute) can never WIDEN a create that
 * the gate would otherwise have proposed.
 */
import {
  db,
  ProfileResolutionService,
  classifyStatusMove,
} from "@synap/database";

export async function initialStatusFloor(input: {
  profileId: string | null | undefined;
  workspaceId: string | null | undefined;
  /** The explicit status (facet attach), if given. */
  status?: unknown;
  properties?: Record<string, unknown> | null;
}): Promise<{ intoTerminal: boolean; humanOnly: boolean } | undefined> {
  if (!input.profileId) return undefined;
  const lifecycle = await new ProfileResolutionService(
    db
  ).getEffectiveLifecycle(input.profileId, input.workspaceId);
  if (!lifecycle) return undefined;
  const value = input.status ?? input.properties?.[lifecycle.propertySlug];
  if (typeof value !== "string") return undefined;
  const move = classifyStatusMove(lifecycle, value);
  return move && (move.intoTerminal || move.humanOnly) ? move : undefined;
}
