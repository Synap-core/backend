/**
 * A STORED rule (an automation row: trigger type + config + flow) read back as
 * human words — and the ONE trigger/action wording rule every door phrases with.
 *
 * MOVED HERE from `browser/…/apps/rules/rule-words.ts` (2026-10-06). It sat
 * beside a second spelling of the same rule: the pod's event and action pickers
 * (`eventLabelFor` / `actionLabelFor`, `api/src/routers/automations.ts`) built
 * "A person was created" / "Create a report" by hand from the same vocabulary
 * calls. Two spellings of one sentence drift; now the pod's picker labels, the
 * Rules page rows and the composers all phrase a WHEN / THEN through
 * {@link eventPatternWhenText} and {@link actionPhrase}.
 *
 * Narrowing clauses go through the composers' own clause builder
 * (`conditionClauses` + `clauseText`, `rule-sentence-words.ts`) reading the
 * stored filters back with the grammar's reverse converter (`flowToConditions`)
 * — so a rule reads the same on the page that lists it as on the card that
 * authored it. Schedules read through `cronWords` (`cron-recurrence.ts`).
 *
 * Pure, platform-agnostic.
 */

import {
  humanizeToken,
  resolveActionLabel,
  resolveObjectNoun,
} from "../vocabulary/index.js";
import { normalizeServiceId } from "../service-marks/index.js";
import { cronWords } from "./cron-recurrence.js";
import { readPlaybookRunMode } from "./rule-run-policy.js";
import {
  clauseText,
  conditionClauses,
  propertyLabel,
} from "./rule-sentence-words.js";
import { flowToConditions } from "./sentence.js";

/** "a person" / "an invoice" — the article a lowercased noun takes. */
export function withArticle(noun: string): string {
  return `${/^[aeiou]/i.test(noun) ? "an" : "a"} ${noun}`;
}

/** A composed sentence's first letter raised. Never applied to a raw token. */
function sentenceStart(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/**
 * The WHEN a first-party event pattern reads as, PAST mood.
 *
 *   ("entity.create.completed", ["person"])      → "A person was created"
 *   ("entity.*", ["task"])                        → "Any task activity"
 *   ("invoice.update.completed", ["invoice"])     → "An invoice was updated"
 *
 * `kinds` are the object kinds the rule concerns (profile slugs, else the
 * pattern's subject); several read "a person or company". Empty → the
 * pattern's own subject.
 */
export function eventPatternWhenText(
  pattern: string,
  kinds: readonly string[] = []
): string {
  const [subject = "", action = ""] = pattern.split(".");
  const noun = (kinds.length ? kinds : [subject || "entity"])
    .map((k) => resolveObjectNoun(k).toLowerCase())
    .join(" or ");
  // Full/action wildcard ("<subject>.*", "<subject>.<action>.*") — no single verb.
  if (!action || action === "*") return `Any ${noun} activity`;
  const past = resolveActionLabel(action, "past").toLowerCase();
  return `${sentenceStart(withArticle(noun))} was ${past}`;
}

/**
 * The THEN an action on an object kind reads as, IMPERATIVE mood:
 * ("create", "report") → "Create a report". `objectKind` null → "record".
 */
export function actionPhrase(verb: string, objectKind: string | null): string {
  const noun = objectKind
    ? resolveObjectNoun(objectKind).toLowerCase()
    : "record";
  return `${resolveActionLabel(verb, "imperative")} ${withArticle(noun)}`;
}

// ── WHEN ────────────────────────────────────────────────────────────────────

export interface RuleWhenWords {
  /** The whole WHEN as one sentence ("A person was created"). */
  text: string;
  /**
   * The object noun inside `text` the row emphasises ("person"), or null.
   * Always a substring of `text`.
   */
  noun: string | null;
  /** A known third-party service the trigger comes from (for its mark). */
  service: string | null;
  /** The object kinds the rule watches (profile slugs, else the subject). */
  watches: string[];
  /** "Only if" clauses — the trigger's narrowing, in words. */
  onlyIf: string[];
}

/** A filter's `profileSlug`: a slug, `{ $eq }`, or `{ $in: [...] }`. */
function profileSlugs(value: unknown): string[] {
  if (typeof value === "string" && value) return [value];
  if (value && typeof value === "object") {
    const v = value as { $eq?: unknown; $in?: unknown };
    if (typeof v.$eq === "string") return [v.$eq];
    if (Array.isArray(v.$in))
      return v.$in.filter((s): s is string => typeof s === "string");
  }
  return [];
}

/**
 * The trigger's narrowing as words, through the composers' clause builder.
 *
 * The two stored shapes the authoring grammar never writes — a membership
 * (`$in`, written by agents) and a presence test (`$ne: null`) — have no
 * `ConditionRow` to round-trip into, so they are phrased here with the same
 * field words; everything else goes through `flowToConditions` +
 * `conditionClauses` + `clauseText`, the one clause rule.
 */
function onlyIfClauses(filters: Record<string, unknown>): string[] {
  const out: string[] = [];
  const grammar: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(filters)) {
    if (key === "profileSlug" || key === "entityType") continue;
    const v =
      value && typeof value === "object"
        ? (value as Record<string, unknown>)
        : null;
    if (v && Array.isArray(v.$in)) {
      out.push(`${propertyLabel(key)} is ${v.$in.map(String).join(" or ")}`);
    } else if (v && "$ne" in v && v.$ne === null) {
      out.push(`${propertyLabel(key)} is set`);
    } else {
      grammar[key] = value;
    }
  }
  const rows = flowToConditions({ filters: grammar });
  return [...conditionClauses({ conditions: rows }).map(clauseText), ...out];
}

/** The first segment that names a known service (`gmail.message.received`). */
function serviceOf(
  pattern: string,
  config: Record<string, unknown>
): string | null {
  for (const raw of [
    config.provider,
    config.connector,
    config.service,
    pattern.split(".")[0],
  ]) {
    if (typeof raw !== "string") continue;
    const id = normalizeServiceId(raw);
    if (id) return id;
  }
  return null;
}

/**
 * WHEN words for a stored trigger. Schedules read through `cronWords`; a
 * trigger this renderer cannot phrase falls back to `fallback` (the shared
 * prose) rather than a raw token.
 */
export function ruleWhenWords(
  triggerType: string,
  triggerConfig: Record<string, unknown> | null | undefined,
  fallback?: string | null
): RuleWhenWords {
  const config = triggerConfig ?? {};
  const none = { noun: null, service: null, watches: [], onlyIf: [] };
  if (triggerType === "manual") return { text: "When you run it", ...none };
  if (triggerType === "webhook")
    return { text: "When a webhook arrives", ...none };
  if (triggerType === "cron") {
    const expr =
      (typeof config.expression === "string" && config.expression) ||
      (typeof config.cron === "string" && config.cron) ||
      "";
    return { text: cronWords(expr) ?? "On a custom schedule", ...none };
  }
  if (triggerType !== "event") {
    return { text: fallback?.trim() || humanizeToken(triggerType), ...none };
  }

  const pattern =
    typeof config.eventPattern === "string" ? config.eventPattern : "";
  const filters = (config.filters ?? {}) as Record<string, unknown>;
  const service = serviceOf(pattern, config);
  const onlyIf = onlyIfClauses(filters);
  const [subject = "", action = ""] = pattern.split(".");
  const firstParty =
    pattern.endsWith(".completed") || action === "*" || pattern.endsWith(".*");

  // An observation (`dev.commit`) is phase-less and names its own fact.
  if (!firstParty) {
    return {
      text: pattern
        ? `${humanizeToken(pattern.replace(/\./g, "_"))} is recorded`
        : "An event happens",
      noun: null,
      service,
      watches: [],
      onlyIf,
    };
  }

  const slugs = profileSlugs(config.profileSlug ?? filters.profileSlug);
  const watches = slugs.length
    ? slugs
    : subject && subject !== "entity"
      ? [subject]
      : [];
  const noun = (watches.length ? watches : [subject || "entity"])
    .map((k) => resolveObjectNoun(k).toLowerCase())
    .join(" or ");
  return {
    text: eventPatternWhenText(pattern, watches),
    noun,
    service,
    watches,
    onlyIf,
  };
}

// ── THEN ────────────────────────────────────────────────────────────────────

export interface RuleThenWords {
  text: string;
  /** What the THEN does, for its icon: a playbook, a record, or something else. */
  kind: "playbook" | "record" | "other" | "none";
  /** The playbook a playbook THEN runs, when it names one. */
  playbookId: string | null;
}

interface FlowNodeLike {
  type?: unknown;
  data?: Record<string, unknown> | null;
}

function flowNodes(flow: unknown): FlowNodeLike[] {
  const nodes = (flow as { nodes?: unknown } | null | undefined)?.nodes;
  return Array.isArray(nodes) ? (nodes as FlowNodeLike[]) : [];
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/**
 * THEN words for a stored flow: its FIRST action node. A playbook reads as
 * "Run “X”" / "Propose “X”"; a record creation as "Create a report"; anything
 * else keeps the shared prose's first clause (`fallback`).
 */
export function ruleThenWords(
  flow: unknown,
  playbookNames: ReadonlyMap<string, string>,
  fallback?: string | null
): RuleThenWords {
  const actions = flowNodes(flow).filter((n) => n.type !== "trigger");
  const first = actions[0];
  if (!first) return { text: "Nothing yet", kind: "none", playbookId: null };
  const data = first.data ?? {};
  if (first.type === "playbook_run") {
    const id = str(data.playbookId);
    const name = (id ? playbookNames.get(id) : null) ?? str(data.playbookName);
    const mode = readPlaybookRunMode(data.mode);
    const verb = resolveActionLabel(
      mode === "propose" ? "propose" : "run",
      "imperative"
    );
    return {
      text: name ? `${verb} “${name}”` : verb,
      kind: "playbook",
      playbookId: id,
    };
  }
  const config = (
    data.config && typeof data.config === "object" ? data.config : data
  ) as Record<string, unknown>;
  const outputType = str(data.outputType) ?? str(data.stepType);
  if (outputType === "entity_create") {
    return {
      text: actionPhrase(
        "create",
        str(config.profileSlug) ?? str(data.profileSlug)
      ),
      kind: "record",
      playbookId: null,
    };
  }
  const prose = fallback?.split("; ")[0]?.trim();
  return {
    text: prose || humanizeToken(outputType ?? String(first.type ?? "step")),
    kind: "other",
    playbookId: null,
  };
}
