/**
 * The pod's door onto the ONE manifest rule (`@synap-core/types/capability-
 * manifest`, plan U3): it looks up the contracts of the intents a definition
 * names in `capability_intents`, then runs the rule. The definition applier
 * refuses a definition whose manifest has problems before any write; the
 * template reconcile's no-drift stamp persists the same normalised fields.
 *
 * A known intent is a seed slug or a registry row, the same test the applier's
 * `intent` check uses (`intent-registry.ts`).
 */
import { isAbstractVerb } from "@synap/database/schema";
import {
  manifestIntents,
  parseCapabilityManifest,
  type CapabilityManifest,
} from "@synap-core/types/capability-manifest";
import { loadIntentContracts } from "./intent-registry.js";

export type ReadManifestResult =
  | { ok: true; manifest: CapabilityManifest }
  | { ok: false; problems: string[] };

/** Parse a definition's manifest fields against the pod's intent registry. */
export async function readDeclaredManifest(
  definition: unknown
): Promise<ReadManifestResult> {
  const intents = manifestIntents(definition);
  const contracts = await loadIntentContracts(intents);
  return parseCapabilityManifest(definition, {
    isKnownIntent: (slug) => isAbstractVerb(slug) || contracts.has(slug),
    contractFor: (slug) => contracts.get(slug) ?? null,
  });
}

/**
 * The `capabilities.metadata` keys a manifest writes: only the fields the
 * definition declares, so a re-apply that omits one leaves the stored value
 * untouched (the `emits` rule).
 */
export function manifestMetadata(
  manifest: CapabilityManifest
): Partial<Record<keyof CapabilityManifest, unknown>> {
  const out: Partial<Record<keyof CapabilityManifest, unknown>> = {};
  if (manifest.needs !== undefined) out.needs = manifest.needs;
  if (manifest.offers !== undefined) out.offers = manifest.offers;
  if (manifest.compose !== undefined) out.compose = manifest.compose;
  if (manifest.services !== undefined) out.services = manifest.services;
  return out;
}
