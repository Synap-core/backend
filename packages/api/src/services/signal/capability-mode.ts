/**
 * CAPABILITY MODE — the callable-vs-standing axis, pure decision only.
 *
 * Split out of `signal/index.ts` so `diagnose/capability-composition.ts` can
 * depend on the mode decision without importing the rest of the signal
 * service (which itself depends on `capability-composition.ts` for
 * `buildCapabilityComposition`) — that mutual import was a circular import.
 * This module has no DB access and no other service dependency; `signal/index.ts`
 * re-exports it so its own callers are unaffected.
 *
 * See `signal/index.ts` Door 7 for the full mode semantics (standing vs
 * callable, health-by-liveness vs health-by-success-rate).
 */

export type CapabilityProducerMode = "standing" | "callable" | "unknown";
export type CapabilityModeSource =
  "declared" | "derived_transport" | "derived_produced" | "unknown";

/**
 * Pure decision: given a capability's declared metadata, its member tools'
 * configs, and how many channels it PRODUCES (all already in hand — no DB
 * access here), derive the producer mode. Rung order: `metadata.mode`
 * (declared) wins; else a member tool with `config.transport = 'bridge'`
 * derives `standing`; else `producedChannelCount > 0` (the capability is the
 * source of a live channel — Discord/Proton/Telegram) also derives `standing`;
 * else an honest `unknown`. Single source of truth for the mode decision —
 * callers fetch the inputs, this function never does.
 */
export function deriveCapabilityMode(params: {
  metadata: unknown;
  memberToolConfigs: unknown[];
  /** How many channels this capability PRODUCES (`resolveCapabilityChannelIds`
   *  length) — a channel-producing capability is standing even without a
   *  declared mode or a `transport:'bridge'` tool. Defaults to 0 (no signal). */
  producedChannelCount?: number;
}): { mode: CapabilityProducerMode; source: CapabilityModeSource } {
  const declared = (params.metadata as Record<string, unknown> | null)?.mode;
  if (declared === "standing" || declared === "callable")
    return { mode: declared, source: "declared" };

  // Derive: an always-on bridge member tool ⇒ standing. `config.transport` is the
  // one concrete transport marker the catalog carries today (proton /
  // telegram-bridge tools).
  const hasBridge = params.memberToolConfigs.some(
    (config) =>
      ((config ?? {}) as Record<string, unknown>).transport === "bridge"
  );
  if (hasBridge) return { mode: "standing", source: "derived_transport" };

  // Derive: the capability is the source of at least one channel (the
  // `producer --produced--> channel` edge) ⇒ standing, even without a declared
  // mode or a transport marker (e.g. a Discord/Telegram bot capability).
  if ((params.producedChannelCount ?? 0) > 0)
    return { mode: "standing", source: "derived_produced" };

  // No signal — honest unknown, never a guessed green.
  return { mode: "unknown", source: "unknown" };
}
