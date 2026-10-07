/**
 * THE CLOSED INTENT VOCABULARY — what a capability DOES, vendor-independently.
 *
 * Published as its own LEAF subpath (`@synap-core/types/capability-intents`)
 * rather than through the `./` barrel, for the same reason `proposals/intent`
 * is: the barrel re-exports `@synap/database` types, and a VALUE import from a
 * barrel crashes Hermes (relay ships React Native). Pure and dependency-free —
 * consumed today by the workspace-template authoring package (`validate.ts`
 * and `task-intents.test.ts`).
 *
 * ── WHAT IS AN INTENT ───────────────────────────────────────────────────────
 * An intent is the ROUTING axis over the verb catalog. A verb's `id` is
 * vendor-keyed (`gmail_send`, `unipile_send_message`); its `intent` says what it
 * MEANS, so an agent can ask for "send a message" without already knowing the
 * vendor. Routing ONLY — an intent resolves to a concrete verb id BEFORE the
 * governance gate, which continues to decide on the verb exactly as before.
 *
 * ── WHY A MIRROR AND NOT AN IMPORT ─────────────────────────────────────────
 * THE SSOT IS THE POD's `capability_intents` TABLE, seeded by migrations
 * `0283_capability_intents.sql` (the 13), `0284_publish_post_intent.sql`
 * (`publish_post`) and `0314_delegate_agent_task_intent.sql` (`delegate_agent_task`). Slugs live in ROWS, not in a TypeScript union.
 *
 * The pod cannot import this file: `@synap-core/types` devDepends on
 * `@synap/database`, so a reverse import is a build cycle. `@synap/database`
 * therefore keeps its own runtime copy in `schema/tools.ts` (`ABSTRACT_VERBS`)
 * — the same mirror + parity precedent as `GUIDELINE_SCOPE_ORDER` (see
 * `src/guidelines/index.ts`).
 *
 * A hand copy that nothing checks is a comment. A hand copy with a parity guard
 * is a mirror — `src/capability-intents/parity.test.ts` re-derives the pod's
 * seed migration SQL and fails the build the moment these two disagree.
 *
 * ⚠️ MIRRORED IN LOCKSTEP with:
 *   - `ABSTRACT_VERBS` — synap-backend `packages/database/src/schema/tools.ts`
 *   - the `INSERT` slugs — migrations `0283` + `0284`
 *   - `CAPABILITY_INTENTS` — synap-control-plane-api
 *       `src/seeds/capability-intent-vocabulary.ts`
 *
 * That is THREE copies, each with its own parity guard against the migration SQL
 * — none of them importable from any other (each repo links a different subset,
 * and the control plane is a separate deploy target with its own lockfile).
 * Two guards live in this repo, two in the control plane.
 *
 * A FOURTH copy — `AbstractVerb` in `@synap/playbooks` — was DELETED 2026-10-01.
 * It was a TYPE-only union of the 13, stale since 0284, and a whole-repo scan
 * found zero importers, so nothing could have noticed the staleness. Do not
 * re-add it; `packages/playbooks/src/required-intents.test.ts` refuses it.
 *
 * ADD A SLUG TO ALL THREE OR THE GUARDS GO RED AND THAT IS THE POINT. Note that
 * each guard lists its migration FILENAMES, so a slug added in a NEW migration is
 * invisible to all of them until that list is extended — extending it is part of
 * adding the slug, not a follow-up.
 *
 * Full procedure, including the build-cycle and deployment constraints: the
 * `intent-vocabulary-ssot` chapter of the `synap-schema` skill
 * (`skills/synap-schema/intent-vocabulary-ssot.md`), which is where an agent
 * should look first.
 */

/**
 * The 13 seed slugs from migration 0283 — the `ABSTRACT_VERBS` union in the
 * pod's `schema/tools.ts`. Grouped as the source groups them: ACQUIRE (bring
 * information in), ACT OUTWARD (change something outside the pod), BRIDGE
 * (bring external data INTO the pod), CONTROL.
 */
export const ABSTRACT_INTENTS = [
  // ACQUIRE
  "search_external",
  "find_people",
  "enrich_entity",
  "fetch_record",
  "list_records",
  // ACT OUTWARD
  "send_message",
  "request_connection",
  "schedule_event",
  "manage_file",
  "generate_media",
  // BRIDGE
  "capture_into_pod",
  // CONTROL
  "run_external_job",
  "connect_account",
] as const;

/**
 * Slugs inserted by a later migration, so NOT in the seed union. Kept separate
 * deliberately: a reader can see at a glance which slugs came from 0283 and
 * which were added after, rather than one flat list hiding the distinction.
 */
export const REGISTERED_EXTRAS = [
  "publish_post",
  "delegate_agent_task",
] as const;

/**
 * Every intent slug a capability or a workspace template may declare — the
 * closed vocabulary as the wire sees it.
 */
export const CAPABILITY_INTENTS: readonly string[] = [
  ...ABSTRACT_INTENTS,
  ...REGISTERED_EXTRAS,
];

const INTENT_SET: ReadonlySet<string> = new Set(CAPABILITY_INTENTS);

/** True when `value` is a slug the pod's router knows. */
export function isKnownIntent(value: unknown): value is string {
  return typeof value === "string" && INTENT_SET.has(value);
}

/**
 * The intents a declared list leaves UNKNOWN — the actionable answer for a
 * validator, which wants the offenders, not a boolean. `isKnownIntent` stays the
 * membership test; this is the same vocabulary turned into a diagnostic.
 */
export function unknownIntents(values: readonly unknown[]): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    if (
      typeof value === "string" &&
      !INTENT_SET.has(value) &&
      !seen.has(value)
    ) {
      seen.add(value);
    }
  }
  return [...seen];
}

/**
 * One value of the closed vocabulary. Deliberately `string`-widened rather than
 * the seed union: the table — not this list — is the SSOT, so a template that
 * declares `publish_post` must typecheck, and a slug added to the pod must not
 * break authoring here before its parity guard has had a chance to run.
 */
export type CapabilityIntentSlug = string;

/**
 * The intents a set of sources PROVIDES, derived from their declared intents.
 *
 * This is the derivation the `provides` field is required to match — declared in
 * ONE place so the seeder, a guard, and any future consumer cannot each reinvent
 * it (and disagree, which is precisely the failure a routing axis cannot
 * afford). Dedupe preserves first-seen order so the result is stable.
 */
export function deriveProvidedIntents(
  sources: ReadonlyArray<{ intent?: unknown }> | undefined
): CapabilityIntentSlug[] {
  if (!sources) return [];
  const seen = new Set<string>();
  for (const source of sources) {
    const intent = source?.intent;
    if (typeof intent === "string" && !seen.has(intent)) seen.add(intent);
  }
  return [...seen];
}
