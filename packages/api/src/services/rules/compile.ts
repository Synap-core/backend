/**
 * COMPILE A RULE'S BEHAVIOUR — the WHEN/WHERE/THEN sentence → an executable
 * `automations` trigger + flow, or a NAMED REFUSAL.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * `createRuleGoverned` used to only LINK pre-existing automations, and every
 * live caller passed `automationIds: []`. A behavioural intent therefore became
 * a `skills` row of prose that nothing would ever run, and the miss was
 * downgraded to a non-fatal `needsBehaviour` signal. Nine automation products
 * were surveyed for this wave and none stores an intent as an ENABLED rule that
 * cannot execute: Salesforce blocks activation, n8n rejects at the mutation
 * boundary, Home Assistant degrades to text, Zapier keeps the draft OFF.
 *
 * ── This is NOT a second compiler ──────────────────────────────────────────
 * The grammar lives ONCE, in `@synap-core/types/automations` (`sentence.ts`):
 * `toBackendTrigger` folds the WHEN + WHERE into `triggerType`/`triggerConfig`,
 * and `toFlowDefinition` emits the THEN as `type:"output"` nodes keyed on real
 * executor `outputType`s (plus `type:"command"` for `run_command`). Those
 * converters are CORRECT and are called here unchanged. This module adds only
 * the two things a converter cannot do:
 *
 *   1. REFUSE. A converter returns a best-effort artifact for any input — an
 *      event trigger with no subject yields `eventPattern: ""`, an unconfigured
 *      action is silently dropped from the flow. A rule door may not persist
 *      that: it must say WHICH CLAUSE failed and stop.
 *   2. VERIFY THE ARTIFACT AGAINST THE RUNTIME. Every check below is the
 *      runtime's own: the event grammar the trigger matcher matches
 *      (`validateEventPattern`), the node contract the executor dispatches
 *      (`validateFlowDefinition`), and the cron key the cron scheduler reads.
 *      Nothing here is a hand-maintained mirror, so teaching the runtime a new
 *      shape widens this compiler with no edit.
 *
 * ── The two WHEN-half severances this compiler was written to catch ────────
 * Both were real when this file was written, both were the same
 * built-but-severed class as the `type:"action"` THEN bug fixed in `7dd1b233`,
 * and both are now REPAIRED in `packages/types/src/automations/sentence.ts`:
 *
 *   • CRON KEY (fixed). `toBackendTrigger` wrote only `triggerConfig.cron`
 *     while the runtime (`jobs/.../automation-cron-scheduler.ts`) and the insert
 *     door's `nextRunAt` both read `.expression`, so a scheduled rule could
 *     never fire. It now writes `expression` as authoritative and keeps `cron`
 *     for backward compatibility. The check below therefore PASSES for cron
 *     rules; it stays as the tripwire that would catch a regression.
 *   • EVENT VERB MOOD (fixed). `ActionVerb` is PAST (`created`) while
 *     `EVENT_ACTIONS` is IMPERATIVE (`create`), so `buildEventPattern` emitted
 *     `entity.created.completed` — a pattern no emitter produces, which
 *     `validateEventPattern` rejects and the automation create door refuses.
 *     Every entity-event rule was unbuildable. A mood bridge now maps the three
 *     CRUD verbs both ways; a verb with no entity event is left unmapped so it
 *     is refused BY NAME here rather than silently rewritten.
 *
 * ── One vocabulary gap that still refuses, correctly ───────────────────────
 * `notification` and `inbox_item` are real event types in
 * `packages/events/src/event-types.ts`, but `validateEventPattern`'s
 * `SUBJECT_TYPES` is narrower than that catalog (it carries `inboxItem`, not
 * `inbox_item`, and no `notification`). Those two subject categories are
 * therefore unauthorable through EVERY door, not just this one — the automation
 * create door refuses them identically. Refusing here is consistent, not a new
 * restriction; closing it means reconciling the two vocabularies, which is a
 * separate piece of work and not a third spelling in this file.
 */

import {
  toBackendTrigger,
  toFlowDefinition,
  type BackendTrigger,
  type RuleFlowDefinition,
  type RuleSentenceValue,
  type SentenceAction,
} from "@synap-core/types/automations";
// Sub-path import: tsup code-splitting drops `validateEventPattern` from the
// main and `events/index.js` bundles (see the same note in routers/automations.ts).
import { validateEventPattern } from "@synap-core/types/events/unified";
import { flowValidationErrorMessage } from "../automations/validate-flow.js";

/**
 * The clause a refusal is about, in the user's own sentence vocabulary. A rule
 * refusal that does not name the clause is unactionable — the whole point is
 * that the author can see which half of their sentence failed.
 */
export type RuleClause = "WHEN" | "WHERE" | "THEN";

export interface RuleCompileFailure {
  clause: RuleClause;
  /** Short, human, safe to show verbatim. Names the clause and the reason. */
  reason: string;
}

export type RuleCompileResult =
  | { ok: true; trigger: BackendTrigger; flow: RuleFlowDefinition }
  | { ok: false; failure: RuleCompileFailure };

/**
 * The cron key the RUNTIME reads — `automation-cron-scheduler.ts` and the
 * insert door's `nextRunAt` computation both read `triggerConfig.expression`.
 * A cron trigger without it is unschedulable. Pinned against the scheduler's
 * own source by `rule-compiler-emits-executor-true-nodes.test.ts`.
 */
const RUNTIME_CRON_KEY = "expression";

const fail = (clause: RuleClause, reason: string): RuleCompileResult => ({
  ok: false,
  failure: { clause, reason },
});

/**
 * An action is CONFIGURED when the grammar will actually emit a node for it.
 * `toFlowDefinition` filters `type === null` away silently, so an all-null
 * THEN compiles to a trigger wired to nothing — accepted by every structural
 * check and executing nothing.
 */
const isConfigured = (action: SentenceAction): boolean => action.type !== null;

/**
 * Compile the behaviour half of a rule sentence.
 *
 * PURE and synchronous — no DB, no catalog. Catalog-existence checks
 * (does this `commandId` / capability exist?) belong to the automation insert
 * door, which already runs `prepareAutomationForMaterialization` with real
 * resolvers; duplicating them here would be a second, blinder copy.
 */
export function compileRuleSentence(
  sentence: RuleSentenceValue
): RuleCompileResult {
  // ── WHEN ────────────────────────────────────────────────────────────────
  const trigger = sentence.trigger;
  if (!trigger) {
    return fail("WHEN", "This rule has no WHEN — nothing would ever start it.");
  }

  // ── WHERE ───────────────────────────────────────────────────────────────
  // `toBackendTrigger` folds only rows with BOTH a key and a value into
  // `filters`; a half-filled row is dropped, which quietly widens the rule to
  // match more than the author wrote. That is a refusal, not a normalisation.
  const conditions = sentence.conditions ?? [];
  const halfFilled = conditions.find(
    (row) => Boolean(row.key) !== Boolean(row.value)
  );
  if (halfFilled) {
    return fail(
      "WHERE",
      `The WHERE condition on "${halfFilled.key || halfFilled.value}" is incomplete — a condition needs both a field and a value, or the rule would apply more widely than you wrote.`
    );
  }

  const backendTrigger = toBackendTrigger(trigger, conditions);

  if (backendTrigger.triggerType === "event") {
    const pattern = backendTrigger.triggerConfig.eventPattern;
    if (typeof pattern !== "string" || pattern.length === 0) {
      return fail(
        "WHEN",
        "The WHEN does not name what happens — pick the thing this rule reacts to."
      );
    }
    // The trigger matcher's OWN grammar. This is what rejects the past-tense
    // `ActionVerb` severance above: `entity.created.completed` is not an
    // emittable pattern, so an automation carrying it could never match.
    try {
      validateEventPattern(pattern);
    } catch (err) {
      return fail(
        "WHEN",
        `The WHEN cannot fire: ${(err as Error).message} (compiled pattern "${pattern}").`
      );
    }
  }

  if (backendTrigger.triggerType === "cron") {
    if (typeof backendTrigger.triggerConfig[RUNTIME_CRON_KEY] !== "string") {
      return fail(
        "WHEN",
        `The WHEN is a schedule the runtime cannot read: the cron scheduler requires triggerConfig.${RUNTIME_CRON_KEY}, and the shared sentence grammar does not emit it. A schedule rule cannot be enabled until \`toBackendTrigger\` writes that key.`
      );
    }
  }

  // ── THEN ────────────────────────────────────────────────────────────────
  const actions = sentence.actions ?? [];
  const configured = actions.filter(isConfigured);
  if (configured.length === 0) {
    return fail(
      "THEN",
      "This rule has no THEN — it describes something that should run, but nothing to do."
    );
  }

  // `run_command` compiles to a `type:"command"` node, which the schema that
  // owns it documents as a DEAD END end-to-end (`CommandNodeDef`,
  // `packages/database/src/schema/automations.ts`): `executeCommandStep` resolves
  // `commandId` as an IS background-task row, the shipped `intelligence_execute`
  // has ZERO occurrences in the IS, so the lookup 404s and the step THROWS.
  // Compiling it would produce exactly what this module exists to prevent — a
  // rule that validates green, is created active, and dies at run time. The node
  // type is kept alive for stored rows from the two doors that already emit it;
  // it must not gain a third.
  const deadEnd = configured.find((a) => a.type === "run_command");
  if (deadEnd) {
    return fail(
      "THEN",
      "Running a command is not available: the command step has no receiver and would fail every time this rule fires. Use an AI step (`ai.generate`) instead."
    );
  }

  const flow = toFlowDefinition(actions);

  // The executor's OWN node contract — the same validator the automation
  // create/update doors run. It rejects an `output` node with no `outputType`,
  // a `command` node with no `commandId`, a dangling edge, an unknown node
  // type: every shape that would persist green and throw mid-run.
  const flowError = flowValidationErrorMessage(flow);
  if (flowError) {
    return fail("THEN", `The THEN cannot run: ${flowError}`);
  }

  return { ok: true, trigger: backendTrigger, flow };
}
