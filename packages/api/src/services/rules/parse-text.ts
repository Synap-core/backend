/**
 * Typed text → a rule SENTENCE, for a composer to show as chips. NEVER saves.
 *
 * The one server door behind `skills.parseRule` (tRPC) and `POST /rules/parse`
 * (Hub REST). Two passes, in this order, and the order is the contract:
 *
 *   1. The SHARED deterministic matcher (`matchRuleText` +
 *      `parseConditionClauses`, `@synap-core/types/automations`) — the very
 *      code relay and the browser run on every keystroke, so what it resolves
 *      reads identically on every surface.
 *   2. Only if a half is still open, the intelligence service
 *      (`POST /api/automations/parse-rule`), which may only PICK from the
 *      vocabulary sent to it. Its answer is re-checked here against the same
 *      option objects; nothing it names outside them reaches the sentence.
 *
 * The sentence is BUILT here from the pod's own option objects (the same
 * constructors every composer uses) and VALIDATED with `compileRuleSentence` —
 * the compiler `skills.createRule` runs before the gate — so a parse that says
 * "ok" is a sentence that will create. Saving stays `skills.createRule`
 * (governed); nothing here writes.
 *
 * FAILURE IS NOT EMPTINESS. A dead or slow IS returns the matcher's reading
 * with `aiUnavailable: true` and a warning — never an empty "nothing found",
 * which would tell the user their sentence meant nothing when in fact nobody
 * read it.
 */

import {
  actionOptionToSentenceAction,
  conditionWindowLabel,
  cronRecurrence,
  CRON_RECURRENCES,
  matchGap,
  matchRuleText,
  ruleTextTokens,
  triggerToSentence,
  type ConditionRow,
  type ParsedClause,
  type RuleSentenceValue,
  type SentenceAction,
  type SentenceTrigger,
} from "@synap-core/types/automations";

import type { ActionOption, EventOption } from "../../routers/automations.js";
import { compileRuleSentence, type RuleCompileFailure } from "./compile.js";
import { conditionOperatorSchema } from "./sentence-schema.js";

// ── Shapes ──────────────────────────────────────────────────────────────────

export interface ParseRuleVocabulary {
  events: readonly EventOption[];
  actions: readonly ActionOption[];
  /** The pod's entity kinds (slug + display label). */
  kinds: readonly { slug: string; label: string }[];
}

/** What the IS is sent — labels only, the pod keeps the option objects. */
export interface IsParseRuleRequest {
  text: string;
  vocabulary: {
    events: { pattern: string; label: string }[];
    actions: { key: string; label: string }[];
    kinds: { slug: string; label: string }[];
    schedules: { id: string; label: string }[];
  };
  resolved?: { eventPattern?: string; actionKeys?: string[] };
}

/** The IS answer (`routes/parse-rule.ts` `ParseRuleResult`), as read here. */
export interface IsParseRuleAnswer {
  sentence: {
    eventPattern: string | null;
    scheduleId: string | null;
    kind: string | null;
    conditions: { field: string; operator: string; value: string }[];
    actionKeys: string[];
  };
  model?: string;
}

export type AskIsParseRule = (
  request: IsParseRuleRequest
) => Promise<IsParseRuleAnswer>;

/** A slot the parse could not fill — the composer leaves it open. */
export interface RuleParseGap {
  slot: "trigger" | "actions" | "condition";
  /** For a `condition`: the property words as typed. */
  field?: string;
  reason: string;
}

export interface ParseRuleTextResult {
  /** Built from the pod's own options. May be partial — gaps are `unresolved`. */
  sentence: RuleSentenceValue;
  /**
   * The same reading as references into the vocabulary, for a composer that
   * applies it through its own reducers (relay's `applyRuleTextMatch`).
   * `clauses` are ALL narrowings, property words unresolved: a composer that
   * has the kind's property list resolves the ones this door could not.
   */
  picks: {
    eventPattern: string | null;
    scheduleId: string | null;
    objectSegment: string | null;
    kind: string | null;
    actionKeys: string[];
    clauses: ParsedClause[];
  };
  unresolved: RuleParseGap[];
  source: "matcher" | "ai";
  /** The IS was needed and could not answer. The matcher's reading stands. */
  aiUnavailable?: true;
  warnings: string[];
  /**
   * `compileRuleSentence` over the sentence. `null` when the sentence is not
   * complete enough to compile (no trigger or no action) — that is a gap, not
   * a refusal, and it is already in `unresolved`.
   */
  validation: { ok: true } | { ok: false; failure: RuleCompileFailure } | null;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const norm = (s: string): string => s.toLowerCase().replace(/[\s_-]+/g, "");

function isOperator(op: string): op is ConditionRow["operator"] {
  return conditionOperatorSchema.safeParse(op).success;
}

/**
 * A clause becomes a WHERE row only when its words name a key this event can
 * actually be narrowed on (`EventOption.filterKeys`). Never a guessed key: a
 * filter on a field the event does not carry silently narrows the rule to
 * never. Entity PROPERTY slugs are resolved by the composer, which holds the
 * kind's property list; here they are reported, not dropped.
 */
function clauseToRow(
  clause: ParsedClause,
  option: EventOption | undefined
): ConditionRow | null {
  const key = option?.filterKeys?.find((k) => norm(k) === norm(clause.field));
  if (!key) return null;
  return { id: key, key, operator: clause.operator, value: clause.value };
}

/**
 * "when an invoice is created, …" — the clause parser reads `when` as a
 * narrowing marker, so the trigger itself comes back as a clause ("invoice" is
 * "created"). A clause whose every word is already in the matched trigger's
 * label is the WHEN restated, not a narrowing; reporting it as an unresolved
 * condition would ask the user to fix something they never asked for.
 */
function restatesTrigger(
  clause: ParsedClause,
  triggerLabel: string | null
): boolean {
  if (!triggerLabel) return false;
  // The clause splitter only breaks on " , " / " and ", so the value of the
  // restated WHEN usually runs on into the THEN ("created, send a …"). Hence:
  // every FIELD word is in the label, and the value STARTS with a label word
  // (the verb). A real narrowing names a field the label does not.
  const label = new Set(ruleTextTokens(triggerLabel));
  const field = ruleTextTokens(clause.field);
  const firstValueWord = ruleTextTokens(clause.value)[0];
  return (
    field.length > 0 &&
    field.every((w) => label.has(w)) &&
    firstValueWord !== undefined &&
    label.has(firstValueWord)
  );
}

// ── The door ────────────────────────────────────────────────────────────────

export async function parseRuleText(
  text: string,
  vocabulary: ParseRuleVocabulary,
  askIs: AskIsParseRule
): Promise<ParseRuleTextResult> {
  const warnings: string[] = [];
  const match = matchRuleText(text, vocabulary);

  let eventPattern = match.trigger?.pattern ?? null;
  let scheduleId: string | null = null;
  let kind: string | null = null;
  let actionKeys = match.actions.map((a) => a.key);
  const clauses: ParsedClause[] = match.clauses.filter(
    (c) => !restatesTrigger(c, match.trigger?.label ?? null)
  );
  let source: ParseRuleTextResult["source"] = "matcher";
  let aiUnavailable = false;

  if (match.attempted && matchGap(match) !== null) {
    try {
      const answer = await askIs({
        text,
        vocabulary: {
          events: vocabulary.events.map((e) => ({
            pattern: e.pattern,
            label: e.label,
          })),
          actions: vocabulary.actions.map((a) => ({
            key: a.key,
            label: a.label,
          })),
          kinds: vocabulary.kinds.map((k) => ({
            slug: k.slug,
            label: k.label,
          })),
          schedules: CRON_RECURRENCES.map((r) => ({
            id: r.id,
            label: r.label,
          })),
        },
        resolved: {
          ...(eventPattern ? { eventPattern } : {}),
          ...(actionKeys.length ? { actionKeys } : {}),
        },
      });
      const ai = answer.sentence;
      // Re-checked against the SAME option objects: the IS already filters to
      // the vocabulary, but this door does not trust a second service to have
      // done its job — an unknown pick is ignored here too.
      if (
        !eventPattern &&
        ai.eventPattern &&
        vocabulary.events.some((e) => e.pattern === ai.eventPattern)
      ) {
        eventPattern = ai.eventPattern;
        source = "ai";
      }
      if (!eventPattern && ai.scheduleId && cronRecurrence(ai.scheduleId)) {
        scheduleId = ai.scheduleId;
        source = "ai";
      }
      if (ai.kind && vocabulary.kinds.some((k) => k.slug === ai.kind)) {
        kind = ai.kind;
      }
      const extra = ai.actionKeys.filter(
        (k) =>
          !actionKeys.includes(k) && vocabulary.actions.some((a) => a.key === k)
      );
      if (actionKeys.length === 0 && extra.length > 0) {
        actionKeys = extra;
        source = "ai";
      }
      for (const c of ai.conditions) {
        if (!isOperator(c.operator)) {
          warnings.push(
            `Ignored a condition on “${c.field}”: unknown comparison.`
          );
          continue;
        }
        if (c.operator === "is_within" && !conditionWindowLabel(c.value)) {
          warnings.push(
            `Ignored a condition on “${c.field}”: unknown time window.`
          );
          continue;
        }
        if (clauses.some((m) => norm(m.field) === norm(c.field))) continue;
        clauses.push({ field: c.field, operator: c.operator, value: c.value });
      }
    } catch {
      // NOT swallowed into emptiness: the matcher's reading is returned and the
      // flag says the assistant was needed and did not answer.
      aiUnavailable = true;
      warnings.push(
        "The assistant could not read the rest of this rule. What the words matched is shown; fill the open slots by hand."
      );
    }
  }

  // ── Build the sentence from the pod's own options ─────────────────────────
  const eventOption = eventPattern
    ? vocabulary.events.find((e) => e.pattern === eventPattern)
    : undefined;

  let trigger: SentenceTrigger | null = null;
  if (eventOption) {
    trigger = triggerToSentence("event", {
      eventPattern: eventOption.pattern,
      ...(eventOption.profileSlug
        ? { profileSlug: eventOption.profileSlug }
        : {}),
    });
  } else if (scheduleId) {
    trigger = cronRecurrence(scheduleId)?.trigger ?? null;
  } else if (match.objectSegment) {
    // An object with no verb: a real, unsaveable trigger (`task.*`). It lands
    // the composer on the right object instead of nowhere; the verb is a gap.
    trigger = triggerToSentence("event", {
      eventPattern: `${match.objectSegment}.*`,
    });
  }
  // The kind binds a GENERIC entity trigger only — never overrides a kind the
  // event option already carries.
  if (
    kind &&
    trigger?.triggerType === "event" &&
    trigger.subjectCategory === "entity" &&
    !trigger.profileSlug
  ) {
    trigger = { ...trigger, profileSlug: kind };
  }

  const actions: SentenceAction[] = [];
  for (const key of actionKeys) {
    const option = vocabulary.actions.find((a) => a.key === key);
    const built = option ? actionOptionToSentenceAction(option) : null;
    if (built) actions.push(built);
  }

  const conditions: ConditionRow[] = [];
  const unresolved: RuleParseGap[] = [];
  for (const clause of clauses) {
    const row = clauseToRow(clause, eventOption);
    if (row && !conditions.some((c) => c.key === row.key)) {
      conditions.push(row);
    } else if (!row) {
      unresolved.push({
        slot: "condition",
        field: clause.field,
        reason: `“${clause.field}” is not a field this trigger can be narrowed on yet — pick it from the trigger's fields.`,
      });
    }
  }

  const triggerComplete =
    trigger !== null &&
    (trigger.triggerType === "cron" || Boolean(trigger.actionVerb));
  if (!triggerComplete) {
    unresolved.unshift({
      slot: "trigger",
      reason: trigger
        ? "Which change to this should start the rule?"
        : "What should start this rule?",
    });
  }
  if (actions.length === 0) {
    unresolved.push({ slot: "actions", reason: "What should happen?" });
  }

  const sentence: RuleSentenceValue = { trigger, conditions, actions };

  let validation: ParseRuleTextResult["validation"] = null;
  if (triggerComplete && actions.length > 0) {
    const compiled = compileRuleSentence(sentence);
    validation = compiled.ok
      ? { ok: true }
      : { ok: false, failure: compiled.failure };
    if (!compiled.ok) warnings.push(compiled.failure.reason);
  }

  return {
    sentence,
    picks: {
      eventPattern: eventOption?.pattern ?? null,
      scheduleId,
      objectSegment: eventOption ? null : match.objectSegment,
      kind,
      actionKeys: actions.length ? actionKeys : [],
      clauses,
    },
    unresolved,
    source,
    ...(aiUnavailable ? { aiUnavailable: true as const } : {}),
    warnings,
    validation,
  };
}

// ── The IS leg ──────────────────────────────────────────────────────────────

/** Long enough for the cheapest tier; a composer is waiting on it. */
const IS_PARSE_TIMEOUT_MS = 15_000;

/**
 * POST the labels to the IS. THROWS on any non-2xx or transport failure — the
 * caller turns that into `aiUnavailable`, so a 500 can never read as "no
 * match".
 */
export const askIsParseRule: AskIsParseRule = async (request) => {
  const { getDefaultActiveService } =
    await import("../../utils/intelligence-routing.js");
  const { endpoint, apiKey } = await getDefaultActiveService();
  const res = await fetch(`${endpoint}/api/automations/parse-rule`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(IS_PARSE_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`IS parse-rule answered ${res.status}`);
  const body = (await res.json()) as Partial<IsParseRuleAnswer>;
  const s = body.sentence;
  if (!s || !Array.isArray(s.actionKeys) || !Array.isArray(s.conditions)) {
    throw new Error("IS parse-rule answered an unreadable body");
  }
  return body as IsParseRuleAnswer;
};

// ── The vocabulary: the SAME menus the composers offer ──────────────────────

/**
 * The WHEN / THEN menus and the kinds, under the caller's own floors — the very
 * resolvers behind `automations.availableTriggerEvents` / `.availableActions`
 * and `profiles.list`, so the parse can never pick something the picker would
 * not have offered.
 */
export async function loadParseRuleVocabulary(input: {
  access: import("../../access/context.js").AccessContext;
  userId: string;
  workspaceId: string | null;
}): Promise<ParseRuleVocabulary> {
  const { resolveAvailableTriggerEvents, resolveAvailableActions } =
    await import("../../routers/automations.js");
  const { getDb, ProfileRepository } = await import("@synap/database");
  const scope = input.workspaceId ? { workspaceId: input.workspaceId } : {};
  const [events, actions, profiles] = await Promise.all([
    resolveAvailableTriggerEvents(input.access, scope),
    resolveAvailableActions(input.access, scope),
    new ProfileRepository(await getDb()).getAccessibleProfiles(
      input.userId,
      input.workspaceId ?? ""
    ),
  ]);
  return {
    events,
    actions,
    // A role is never a trigger's subject (it is a facet on an entity).
    kinds: profiles
      .filter((p) => p.profileKind !== "role")
      .map((p) => ({ slug: p.slug, label: p.displayName })),
  };
}
