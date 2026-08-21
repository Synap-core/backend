/**
 * Intent → capability REVERSE INDEX — the routing side of the capability
 * registry.
 *
 * `tools.capabilities[].id` is vendor-keyed (`gmail_send`,
 * `unipile_send_message`), so an agent asking to "send a message" must already
 * know which vendor is installed. `ToolVerbCatalogEntry.intent` adds a CLOSED
 * abstract axis over the same rows (see `ABSTRACT_VERBS` in
 * @synap/database `schema/tools.ts`); this module answers the reverse question —
 * given an intent, which installed capabilities declare it.
 *
 * SCOPING: there is deliberately NO query here. It folds the rows
 * `listCapabilities` already returned, so the caller's visibility floor is the
 * registry's own — a second predicate would be a second door to keep in sync,
 * which is exactly the drift this codebase keeps paying for.
 *
 * ROUTING, NEVER AUTHORIZATION. This resolves an intent to a CONCRETE verb id;
 * everything downstream (`executeCapability`, the grant gate, `decideAgentPolicy`)
 * then decides on that concrete verb exactly as it did before. An intent must
 * never widen what a caller may run.
 */

import type { AbstractVerb } from "@synap/database/schema";
import {
  listCapabilities,
  type CapabilityRegistryContext,
  type RegistryCapability,
} from "./capability-registry.js";

/** One verb that declares an intent, carried with the capability it lives on. */
export interface IntentVerbMatch {
  intent: AbstractVerb;
  /** The CONCRETE verb id to pass to `synap_run_capability` / executeCapability. */
  verbId: string;
  verbLabel: string;
  /** read = pull · write/action = push. */
  verbKind: "read" | "write" | "action";
  /** Grant state, straight off the registry row — never re-derived here. */
  granted: boolean;
  effectiveExecMode: string;
  /** False when no visible active+approved backing skill can execute the verb. */
  backingSkillExecutable: boolean;
  capabilityId: string;
  capabilityName: string;
  /** Whether the provider tool is connected, when the registry knows. */
  connected?: boolean;
}

/**
 * Fold registry rows into intent → verbs. PURE, so the scoping (which belongs to
 * `listCapabilities`) and the folding are independently testable.
 *
 * A verb with no `intent` is simply absent from the index — legacy catalog
 * entries predate the axis and must never be guessed into a bucket. Rows are
 * deduped by `intent:verbId`, preferring a GRANTED copy, mirroring
 * `sectionCapabilities`' union rule for an integration installed twice.
 */
export function foldVerbsByIntent(
  caps: RegistryCapability[]
): Map<AbstractVerb, IntentVerbMatch[]> {
  const byIntent = new Map<AbstractVerb, IntentVerbMatch[]>();
  const seen = new Map<string, IntentVerbMatch>();
  for (const c of caps) {
    for (const v of c.verbs ?? []) {
      const intent = v.intent;
      if (!intent) continue;
      const match: IntentVerbMatch = {
        intent,
        verbId: v.id,
        verbLabel: v.label,
        verbKind: v.kind,
        granted: v.granted === true,
        effectiveExecMode: v.effectiveExecMode,
        backingSkillExecutable: v.backingSkillExecutable === true,
        capabilityId: c.id,
        capabilityName: c.name,
        ...(c.connection ? { connected: c.connection.connected === true } : {}),
      };
      const key = `${intent}:${v.id}`;
      const prior = seen.get(key);
      if (prior) {
        // Same verb from a duplicate row — keep the granted copy.
        if (match.granted && !prior.granted) Object.assign(prior, match);
        continue;
      }
      seen.set(key, match);
      const list = byIntent.get(intent);
      if (list) list.push(match);
      else byIntent.set(intent, [match]);
    }
  }
  return byIntent;
}

/**
 * Which capabilities visible to THIS caller declare `intent`.
 *
 * Returns `[]` for an intent nothing declares — a real answer (the pod cannot do
 * it through a declared verb), never a placeholder. Pass no `intent` to get the
 * whole index.
 */
export async function capabilitiesByIntent(
  ctx: CapabilityRegistryContext,
  intent: AbstractVerb
): Promise<IntentVerbMatch[]> {
  // `limit: null` — never slice before folding: a genuine match could be pushed
  // out of the window by duplicate rows of something else. Same reason the MCP
  // door passes `null` before `sectionCapabilities`.
  const caps = await listCapabilities(ctx, { limit: null });
  return foldVerbsByIntent(caps).get(intent) ?? [];
}

/** The full intent → verbs index under the caller's lens. */
export async function intentIndex(
  ctx: CapabilityRegistryContext
): Promise<Map<AbstractVerb, IntentVerbMatch[]>> {
  return foldVerbsByIntent(await listCapabilities(ctx, { limit: null }));
}
