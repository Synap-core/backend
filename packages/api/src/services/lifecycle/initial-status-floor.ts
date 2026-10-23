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

/**
 * The floor for an entity CREATE: born with the caller's status, else the
 * kind's default (`defaultValues`). The ONE derivation the create door gates
 * on and every door that PREDICTS that gate reads (capture auto-apply), so the
 * two cannot answer differently for one write — they did: a decision captured
 * as `accepted` was judged "execute" by the capture pre-check and "a person
 * approves" by the create door it then ran (live 2026-10-18).
 */
export async function initialCreateStatusFloor(input: {
  profile: { id?: string | null; defaultValues?: unknown } | null | undefined;
  workspaceId: string | null | undefined;
  properties?: Record<string, unknown> | null;
}): Promise<{ intoTerminal: boolean; humanOnly: boolean } | undefined> {
  return initialStatusFloor({
    profileId: input.profile?.id,
    workspaceId: input.workspaceId,
    properties: {
      ...((input.profile?.defaultValues as Record<string, unknown> | null) ??
        {}),
      ...(input.properties ?? {}),
    },
  });
}

/**
 * `initialCreateStatusFloor` for a create named by kind SLUG — what a door
 * that predicts the create gate holds before any entity exists (a capture
 * graph's `create_entity` op). Resolves the kind the way the create door does.
 */
export async function initialCreateStatusFloorOfSlug(input: {
  profileSlug: string;
  userId: string;
  workspaceId: string | null;
  properties?: Record<string, unknown> | null;
}): Promise<{ intoTerminal: boolean; humanOnly: boolean } | undefined> {
  const profile = await new ProfileResolutionService(db).resolveProfile(
    input.profileSlug,
    input.userId,
    input.workspaceId
  );
  return initialCreateStatusFloor({
    profile,
    workspaceId: input.workspaceId,
    properties: input.properties,
  });
}
