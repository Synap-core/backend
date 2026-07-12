import type { AiPosture } from "../schema/profiles.js";

/**
 * Code-defaults layer (layer 1 of 3) for `getEffectiveAiPosture()` — the
 * AI Teaching Substrate's per-kind behavioral emphases (D4). Keyed by
 * profile SLUG (not profileKind category — "session" is the actual seeded
 * slug for the `focus_session` profile's runtime instances).
 *
 * PLACEMENT: lives in @synap/database, not @synap/governance-policy. The
 * dependency direction is database → governance-policy (database's
 * package.json depends on governance-policy; the reverse would cycle), and
 * this constant's value type (`AiPosture`) is defined on the `profiles`
 * schema in this package — putting the constant in governance-policy would
 * force governance-policy to import a database schema type, creating that
 * cycle. `DEFAULT_AUTO_APPROVE`'s home (governance-policy) works because it
 * has no such type dependency.
 *
 * Layers (see `ProfileResolutionService.getEffectiveAiPosture`):
 *   1. DEFAULT_AI_POSTURES (this file, code)
 *   2. profiles.aiPosture (base, per-pod)
 *   3. workspaces.settings.profileAiPosture[slug] (workspace overlay)
 * Shallow-merged 1 ← 2 ← 3.
 */
export const DEFAULT_AI_POSTURES: Record<string, AiPosture> = {
  project: { explainWhy: true, openAfterCreate: true },
  session: { explainWhy: true, openAfterCreate: true, attachOutputs: true },
  document: { openAfterCreate: true },
  view: { openAfterCreate: true },
  cell: { openAfterCreate: true },
  playbook: { explainWhy: true, openAfterCreate: true },
  automation: { explainWhy: true, openAfterCreate: true },
  workspace: { explainWhy: true, openAfterCreate: true },
  capability: { explainWhy: true, openAfterCreate: true },
  capture: {},
};
