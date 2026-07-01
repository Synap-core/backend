/**
 * Built-in capability verbs (Tier-0) — first-party Synap operations exposed
 * through the SAME capability substrate as external connector verbs.
 *
 * A `kind:'builtin'` skill carries neither code nor a providerSpec; its NAME
 * (= verbId) resolves to a handler here that runs IN-PROCESS by calling the
 * existing governed router/service. No Intelligence Service, no isolate, no
 * external HTTP — the correct vehicle for in-process DB ops (the provider-verb
 * tier is HTTP-to-external only; the code tier round-trips through the IS).
 *
 * GOVERNANCE: each handler delegates to a governed service that runs its OWN
 * permission check (e.g. checkPermissionOrPropose). The capability-level gate in
 * executeCapability still applies to the builtin SKILL (approval + grant), so an
 * owner running their own seeded builtin verb passes straight through; the
 * handler's service is the authoritative gate on the underlying write.
 *
 * Registry starts EMPTY — the `synap-core` built-in capability (W5) registers
 * the pilot verbs (channel.create, feed.post). Adding a handler here is the ONLY
 * way a builtin verb becomes runnable, so the surface is explicit + auditable.
 */

export interface BuiltinVerbContext {
  /** The acting operator (bearer's user id). */
  userId: string;
  /** Acting workspace lens, or null for a pod-wide run. */
  workspaceId: string | null;
}

export type BuiltinVerbHandler = (
  params: Record<string, unknown>,
  ctx: BuiltinVerbContext
) => Promise<unknown>;

/**
 * verbName (= skill.name = verbId) → in-process handler. Populated by W5.
 * Keep names namespaced (`channel.create`, `feed.post`) to mirror the
 * `connector.action` convention used for external verbs.
 */
export const BUILTIN_VERBS: Record<string, BuiltinVerbHandler> = {};
