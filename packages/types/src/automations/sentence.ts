/**
 * MOVED HERE from `@synap-core/automation-intent` (synap-app) so the BACKEND can
 * reach the rule-sentence grammar: synap-backend's pnpm workspace is only
 * `apps/*` / `packages/*` / `marketplaces/*`, so it cannot resolve a synap-app
 * workspace package — and the CLI, Discord and Hub REST rule doors are all
 * server-side. Same shape as `@synap-core/types/vocabulary`, which moved for the
 * same reason. `@synap-core/automation-intent/src/sentence.ts` is now a
 * re-export shim over this file, so every existing importer is unchanged.
 *
 * The pure "rule sentence" value-model + its bidirectional converters.
 *
 * A rule reads as a sentence — WHEN [event] (WHERE [filter]) → THEN [action] — and
 * is stored as an `automations` row (triggerType/triggerConfig + flowDefinition).
 * This module is the ONE UI-agnostic home for that value-model and the pure
 * functions that convert it to/from the stored automation shape, so every editor
 * lineage (Studio's HeroUI builder, browser's spatial-ui editor) consumes the
 * SAME logic instead of forking it. No React, no HeroUI, no tRPC — framework-free
 * so both `features/*` (HeroUI) and `browser/` (spatial-ui) can import it.
 *
 * It deliberately does NOT depend on `@synap-core/workflows` (a FEATURE package —
 * a core package may not import upward). The flow shape is expressed here as the
 * structural `RuleFlowDefinition`, to which `@synap-core/workflows`'s
 * `AutomationFlowDefinition` is assignable (its node `type` union widens to
 * `string`), so callers pass their concrete flow type in unchanged.
 */

// ── Value-model ───────────────────────────────────────────────────────────────

export type ActionType =
  | "notify"
  | "update_entity"
  | "create_entity"
  | "run_command"
  | "post_message"
  | "call_webhook";

export interface SentenceAction {
  type: ActionType | null;
  config: Record<string, unknown>;
}

export type TriggerSubjectCategory =
  | "entity"
  | "external_message"
  | "capture"
  | "notification"
  | "feed_item"
  | "inbox_item";

export type ActionVerb =
  | "created"
  | "updated"
  | "deleted"
  | "received"
  | "completed"
  | "approved"
  | "rejected";

export type ConditionOperator =
  | "is"
  | "is_not"
  | "contains"
  | "starts_with"
  | "greater_than"
  | "less_than"
  | "changed_to"
  | "is_true"
  | "is_false";

export interface ConditionRow {
  id: string;
  key: string;
  operator: ConditionOperator;
  value: string;
}

export type CronFrequency =
  "hourly" | "daily" | "weekdays" | "weekly" | "monthly" | "custom";

export interface SentenceTrigger {
  triggerType: "event" | "cron";
  // event
  subjectCategory?: TriggerSubjectCategory;
  profileSlug?: string;
  actionVerb?: ActionVerb;
  conditions?: ConditionRow[];
  // cron
  cronFrequency?: CronFrequency;
  cronTime?: string; // "HH:mm" 24h
  cronDays?: number[]; // 0=Sun..6=Sat
  cronDayOfMonth?: number; // 1–28
  cronTimezone?: string; // IANA, default "UTC"
}

/**
 * The whole sentence a rule editor edits: a trigger (null until chosen), the
 * WHERE conditions, and the ordered THEN actions. This is the canonical shape
 * both editor lineages hold in state and pass through the converters below.
 */
export interface RuleSentenceValue {
  trigger: SentenceTrigger | null;
  conditions: ConditionRow[];
  actions: SentenceAction[];
}

/**
 * Structural mirror of `@synap-core/workflows` `AutomationFlowDefinition`, kept
 * here so this core module needs no feature dependency. Node `type` is `string`
 * (the union in the feature type widens to it), so a concrete
 * `AutomationFlowDefinition` is assignable to this in both directions the
 * converters need.
 */
// NOTE: `type` aliases (object literals), NOT `interface`s — an object-literal
// type carries the implicit string index compatibility that lets it satisfy the
// backend mutation's `Record<string, unknown>[]` node/edge shape, which an
// interface (open to augmentation) does not.
export type RuleFlowNode = {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: Record<string, unknown>;
};

export type RuleFlowEdge = {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  animated?: boolean;
  label?: string;
};

export type RuleFlowDefinition = {
  nodes: RuleFlowNode[];
  edges: RuleFlowEdge[];
};

export interface BackendTrigger {
  triggerType: "event" | "cron" | "webhook" | "manual";
  triggerConfig: Record<string, unknown>;
}

// ── Sentence → backend (forward converters) ───────────────────────────────────

/**
 * MOOD BRIDGE — the sentence's PAST-tense `ActionVerb` → the event catalog's
 * IMPERATIVE action segment.
 *
 * The two vocabularies were never bridged, and the miss was invisible: the
 * sentence says "when an entity is *created*", while every emitted event and
 * `EVENT_ACTIONS` (`@synap-core/types/events/unified`) uses *create*. So
 * `buildEventPattern` emitted `entity.created.completed` — a pattern no emitter
 * produces and `validateEventPattern` REJECTS, which means the automation
 * create door (`routers/automations.ts:579`) refused it outright. Every
 * entity-event rule was therefore unbuildable. WHEN-side twin of the cron-key
 * bug below and of the `type:"action"` THEN bug fixed in `7dd1b233`.
 *
 * Only the three CRUD verbs have an entity event to map onto. A verb with no
 * entity event (`received`/`completed`/`approved`/`rejected`) is deliberately
 * left UNMAPPED so it reaches `validateEventPattern` and is refused by the
 * runtime's own message, rather than being silently rewritten into a different
 * rule than the author wrote.
 */
const VERB_TO_EVENT_ACTION: Partial<Record<ActionVerb, string>> = {
  created: "create",
  updated: "update",
  deleted: "delete",
};

/** Inverse of {@link VERB_TO_EVENT_ACTION}, for the round trip back to a sentence. */
const EVENT_ACTION_TO_VERB: Record<string, ActionVerb> = {
  create: "created",
  update: "updated",
  delete: "deleted",
};

export function buildEventPattern(trigger: SentenceTrigger): string {
  if (!trigger.subjectCategory) return "";
  const { subjectCategory, actionVerb } = trigger;

  const entityAction = actionVerb
    ? (VERB_TO_EVENT_ACTION[actionVerb] ?? actionVerb)
    : "create";

  const PATTERN_MAP: Record<string, string> = {
    entity: `entity.${entityAction}.completed`,
    external_message: "external_message.received.completed",
    capture: "capture.complete.completed",
    // ⚠️ `notification` and `inbox_item` are REAL event types in
    // `packages/events/src/event-types.ts` (`notification.created.completed`,
    // `inbox_item.received.completed`) that `validateEventPattern` still
    // rejects — its `SUBJECT_TYPES` list is narrower than the event catalog
    // (it carries `inboxItem`, not `inbox_item`, and no `notification` at all).
    // These two subject categories therefore cannot be authored through any
    // door today. That is a vocabulary-parity gap in `events/unified.ts`, not
    // something to paper over here with a third spelling.
    notification: "notification.created.completed",
    feed_item: "feed.new_item.completed",
    inbox_item: "inbox_item.received.completed",
  };

  return (
    PATTERN_MAP[subjectCategory] ??
    `${subjectCategory}.${entityAction}.completed`
  );
}

export function buildCronExpression(trigger: SentenceTrigger): string {
  const [hh, mm] = (trigger.cronTime ?? "09:00").split(":").map(Number);
  const h = hh ?? 9;
  const m = mm ?? 0;

  switch (trigger.cronFrequency) {
    case "hourly":
      return `0 * * * *`;
    case "daily":
      return `${m} ${h} * * *`;
    case "weekdays":
      return `${m} ${h} * * 1-5`;
    case "weekly": {
      const days = (trigger.cronDays ?? [1]).join(",");
      return `${m} ${h} * * ${days}`;
    }
    case "monthly": {
      const dom = trigger.cronDayOfMonth ?? 1;
      return `${m} ${h} ${dom} * *`;
    }
    default:
      return `${m} ${h} * * *`;
  }
}

export function toBackendTrigger(
  trigger: SentenceTrigger,
  conditions: ConditionRow[]
): BackendTrigger {
  if (trigger.triggerType === "cron") {
    const cron = buildCronExpression(trigger);
    return {
      triggerType: "cron",
      triggerConfig: {
        // `expression` is the EXECUTOR-TRUE key — AUTHORITATIVE. The cron
        // scheduler (`jobs/src/workers/automation-cron-scheduler.ts`) and the
        // create/update door's `nextRunAt` computation
        // (`routers/automations.ts`) both read `triggerConfig.expression`; a
        // flow compiled with only `.cron` gets `nextRunAt: null` and NEVER
        // FIRES — invisibly, because `triggerToSentence` below round-trips
        // `.cron` perfectly, so the editor shows nothing wrong. WHEN-side twin
        // of the `type:"action"`/`ActionType` THEN-side bug fixed in
        // `7dd1b233`. Tripwire: `cron-expression-key-parity.tripwire.test.ts`
        // (NOT `sentence.test.ts`, which carries no cron assertion — a wrong
        // pointer is how a guard gets deleted as redundant).
        expression: cron,
        // `cron` is kept for BACKWARD COMPATIBILITY: automations already
        // stored before this fix carry only `.cron`, and `triggerToSentence`
        // below reads `expression ?? cron` so both shapes still load. Do not
        // remove — it would orphan existing rows' round-trip.
        cron,
        timezone: trigger.cronTimezone ?? "UTC",
      },
    };
  }

  if (trigger.triggerType === "event") {
    const pattern = buildEventPattern(trigger);
    const filters: Record<string, string> = {};
    for (const row of conditions) {
      if (row.key && row.value) filters[row.key] = row.value;
    }
    // WHERE the chosen kind goes, and why it is NOT one key.
    //
    // 🔴 `triggerConfig.profileSlug` (top level) is read by the runtime matcher
    // in exactly ONE place: `matchTriggerSpecificFilters`'s
    // `if (eventType.startsWith("capture."))` branch, against
    // `data.profileSlugs` (PLURAL — a capture carries several). There is no
    // `entity.` branch. So an entity rule that said "when a PERSON is created"
    // compiled to a top-level key nothing reads, passed every check, reported
    // itself live, and fired on every company, task and note in the workspace —
    // with `wakeAgent` on the THEN, an agent turn per entity.
    //
    // For an ENTITY trigger the kind belongs in `filters`, which the GENERIC
    // `matchFilters` evaluates against the event's own `data` — and entity
    // emits do carry `data.profileSlug` (`routers/capture.ts:3142,3579`,
    // `run-gcal-import.ts:211`). The event catalog agrees: `ENTITY_CREATED`
    // declares `filterKeys: ["profileSlug"]`.
    //
    // `capture` keeps the top-level key, because its branch reads a DIFFERENT
    // shape (`profileSlugs`, plural) that `matchFilters` could not evaluate.
    const isEntityTrigger = trigger.subjectCategory === "entity";
    if (trigger.profileSlug && isEntityTrigger) {
      filters.profileSlug = trigger.profileSlug;
    }

    return {
      triggerType: "event",
      triggerConfig: {
        ...(pattern ? { eventPattern: pattern } : {}),
        ...(trigger.profileSlug && !isEntityTrigger
          ? { profileSlug: trigger.profileSlug }
          : {}),
        ...(Object.keys(filters).length ? { filters } : {}),
      },
    };
  }

  return {
    triggerType: trigger.triggerType as "webhook" | "manual",
    triggerConfig: {},
  };
}

/**
 * Sentence `ActionType` → the executor-true output-node `outputType`. The
 * sentence vocabulary is a FRIENDLY alias set; the automation executor only runs
 * `type:"output"` nodes keyed on these `outputType`s (steps/output.ts) — so the
 * converter MUST translate, or the THEN silently never fires. `run_command` is
 * the one action that is NOT an output node: it compiles to a `type:"command"`
 * node (executor: automation-executor.ts `case "command"`), handled separately.
 */
const ACTION_TO_OUTPUT_TYPE: Record<
  Exclude<ActionType, "run_command">,
  string
> = {
  notify: "notification",
  create_entity: "entity_create",
  update_entity: "entity_update",
  post_message: "channel_message",
  call_webhook: "webhook",
};

const OUTPUT_TYPE_TO_ACTION: Record<string, ActionType> = Object.fromEntries(
  Object.entries(ACTION_TO_OUTPUT_TYPE).map(([action, output]) => [
    output,
    action as ActionType,
  ])
);

/**
 * THE EXECUTOR-TRUE THEN DIALECT — `type: null` + `config.__*`.
 *
 * `SentenceAction.type` is the friendly `ActionType` lineage (`notify`,
 * `create_entity`, …). It cannot express two shapes the executor supports:
 *   • a CAPABILITY verb call — there is no `ActionType` slot for "call this verb
 *     on this capability";
 *   • an output type with no `ActionType` at all. `ACTION_TO_OUTPUT_TYPE` covers
 *     five of the executor's eleven outputs; `facet_attach`, `relation_create`,
 *     `set_state`, `session_update` and the rest have no friendly alias.
 * So an authoring surface offering the FULL executor vocabulary — which
 * `browser/.../rule-sentence/sentence-io.ts` does — sets `type: null` and puts
 * the executor-true target in `config` under these `__`-prefixed keys.
 *
 * 🔴 Until this was written the grammar could only READ that dialect, never
 * WRITE it: `toFlowDefinition` dropped every `type: null` action, so a sentence
 * authored in the browser compiled to a trigger wired to NOTHING and the rule
 * compiler refused it as "no THEN". The forward and reverse halves of ONE
 * grammar disagreed about what a THEN is — which is why the rule compiler had
 * no producer it could actually consume. Keep the two halves symmetric.
 *
 * These keys are in-memory bookkeeping and are STRIPPED before persisting, so
 * nothing `__`-prefixed ever reaches a stored flow. The `__` prefix exists so a
 * third-party verb param can never collide with them.
 */
const OUTPUT_TYPE_KEY = "__outputType";
const CAPABILITY_NODE_TYPE_KEY = "__nodeType";
const CAPABILITY_ID_KEY = "__capabilityId";
const CAPABILITY_VERB_ID_KEY = "__verbId";
const CAPABILITY_ACTION_KEY = "__actionKey";

/**
 * EXPORTED so the browser's `sentence-io.ts` can derive its `RESERVED_CONFIG_KEYS`
 * from this list instead of re-declaring it.
 *
 * 🔴 Two independent copies of one vocabulary is this repo's dominant defect, and
 * this list is load-bearing in a way that fails SILENTLY: `persistedConfig` strips
 * by EXACT MEMBERSHIP, not by `__` prefix. Add a sixth in-memory key on the
 * browser side (`__label`, a per-param provenance marker) and the browser's own
 * writer strips it — but a sentence sent to `skills.createRule` goes through
 * `persistedConfig`, which does not know it, so `__label` lands verbatim in the
 * stored node's `data.config` and the executor reads it as a real output param.
 * `validateFlowDefinition` checks node SHAPE, not config keys, so it persists
 * green and misbehaves at run time.
 */
export const BOOKKEEPING_KEYS: readonly string[] = [
  OUTPUT_TYPE_KEY,
  CAPABILITY_NODE_TYPE_KEY,
  CAPABILITY_ID_KEY,
  CAPABILITY_VERB_ID_KEY,
  CAPABILITY_ACTION_KEY,
];

/** The action's config with every `__`-prefixed bookkeeping key removed. */
function persistedConfig(
  config: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config ?? {})) {
    if (!BOOKKEEPING_KEYS.includes(k)) out[k] = v;
  }
  return out;
}

/**
 * Is this action CONFIGURED — will it emit a node the executor dispatches?
 *
 * NOT simply `type !== null`: a `type: null` action carrying an executor-true
 * target in `config` is fully configured, and treating it as empty is exactly
 * how a browser-authored THEN silently vanished. Exported because the rule
 * compiler must ask the same question the flow builder answers, from one place.
 */
export function isActionConfigured(action: SentenceAction): boolean {
  if (action.type !== null) return true;
  const cfg = action.config ?? {};
  if (cfg[CAPABILITY_NODE_TYPE_KEY] === "capability") return true;
  const out = cfg[OUTPUT_TYPE_KEY];
  return typeof out === "string" && out.length > 0;
}

function actionToFlowNode(
  action: SentenceAction,
  nodeId: string,
  y: number
): RuleFlowNode {
  // run_command → a `command` node (commandId drives execution; the sentence's
  // free-text `input` becomes the command's promptOverride; inputMapping is empty
  // — resolveInputMapping tolerates {}).
  if (action.type === "run_command") {
    const config = action.config;
    return {
      id: nodeId,
      type: "command",
      position: { x: 0, y },
      data: {
        commandId: config.commandId,
        commandTitle: config.commandTitle ?? "",
        inputMapping: {},
        promptOverride: config.input,
      },
    };
  }
  const cfg = action.config ?? {};

  // `type: null` + `__nodeType: "capability"` → a `capability` node. The exact
  // inverse of `flowNodeToSentenceAction`'s capability branch below; the two
  // must stay byte-for-byte mirrors or a capability THEN cannot round-trip.
  if (action.type === null && cfg[CAPABILITY_NODE_TYPE_KEY] === "capability") {
    return {
      id: nodeId,
      type: "capability",
      position: { x: 0, y },
      data: {
        capabilityId: cfg[CAPABILITY_ID_KEY] ?? "",
        verbId: cfg[CAPABILITY_VERB_ID_KEY] ?? "",
        // `inputMapping` — the key the EXECUTOR reads (`automation-executor.ts`
        // `case "capability"` → `executeCapabilityNode`) and the key the reverse
        // reader below spreads back. Writing `params` here typechecked, matched
        // nothing at run time, and lost every verb argument silently.
        inputMapping: persistedConfig(cfg),
      },
    };
  }

  // Otherwise an `output` node keyed on its executor-true outputType — taken
  // from the friendly `ActionType` alias when there is one, and from the
  // explicit `__outputType` when the surface chose a raw executor output that
  // has no alias.
  const outputType = action.type
    ? ACTION_TO_OUTPUT_TYPE[action.type]
    : typeof cfg[OUTPUT_TYPE_KEY] === "string"
      ? (cfg[OUTPUT_TYPE_KEY] as string)
      : undefined;
  return {
    id: nodeId,
    type: "output",
    position: { x: 0, y },
    data: {
      label: outputType ?? "",
      outputType,
      // Bookkeeping keys are in-memory only — never persist a `__` key into a
      // stored flow, or the executor sees them as verb params.
      config: persistedConfig(cfg),
    },
  };
}

export function toFlowDefinition(
  actions: SentenceAction[]
): RuleFlowDefinition {
  const nodes: RuleFlowNode[] = [
    { id: "trigger", type: "trigger", position: { x: 0, y: 0 }, data: {} },
  ];
  const edges: RuleFlowEdge[] = [];

  // `isActionConfigured`, NOT `type !== null`: an action carrying an
  // executor-true target in `config` is configured even with a null type, and
  // dropping it here is what made a browser-authored THEN compile to nothing.
  const configuredActions = actions.filter(isActionConfigured);
  configuredActions.forEach((action, idx) => {
    const nodeId = `action-${idx + 1}`;
    nodes.push(actionToFlowNode(action, nodeId, 150 + idx * 150));
    const source = idx === 0 ? "trigger" : `action-${idx}`;
    edges.push({ id: `e${idx + 1}`, source, target: nodeId });
  });

  return { nodes, edges };
}

// ── Backend → sentence (reverse converters / fromFlowDefinition) ──────────────

export function parseCron(cron: string): {
  cronFrequency?: CronFrequency;
  cronTime?: string;
  cronDays?: number[];
  cronDayOfMonth?: number;
} {
  const parts = cron.split(" ");
  const m = parts[0] ?? "0";
  const h = parts[1] ?? "9";
  const dom = parts[2] ?? "*";
  const dow = parts[4] ?? "*";
  if (h === "*") return { cronFrequency: "hourly" };
  const time = `${h.padStart(2, "0")}:${m.padStart(2, "0")}`;
  if (dom !== "*")
    return {
      cronFrequency: "monthly",
      cronTime: time,
      cronDayOfMonth: parseInt(dom, 10),
    };
  if (dow === "1-5") return { cronFrequency: "weekdays", cronTime: time };
  if (dow !== "*")
    return {
      cronFrequency: "weekly",
      cronTime: time,
      cronDays: dow.split(",").map(Number),
    };
  return { cronFrequency: "daily", cronTime: time };
}

export function triggerToSentence(
  triggerType: string,
  triggerConfig: Record<string, unknown>
): SentenceTrigger {
  if (triggerType === "cron") {
    // `expression` is authoritative (see `toBackendTrigger`); `cron` is the
    // pre-fix key still carried by rows stored before this fix — read both so
    // neither shape is orphaned.
    const cron =
      (triggerConfig.expression as string | undefined) ??
      (triggerConfig.cron as string | undefined) ??
      "0 9 * * *";
    const timezone = (triggerConfig.timezone as string) ?? "UTC";
    return { triggerType: "cron", ...parseCron(cron), cronTimezone: timezone };
  }
  // webhook/manual don't map to SentenceTrigger — treat as a bare event trigger
  if (triggerType === "event") {
    const pattern = (triggerConfig.eventPattern as string) ?? "";
    // Read from BOTH homes: an entity trigger now stores the kind in `filters`
    // (where the generic matcher reads it), `capture` still at the top level,
    // and rows written before this fix carry the top-level key whatever their
    // subject. Reading only one would blank the WHEN row for the other.
    const storedFilters = triggerConfig.filters as
      Record<string, unknown> | undefined;
    const profileSlug =
      (triggerConfig.profileSlug as string | undefined) ??
      (typeof storedFilters?.profileSlug === "string"
        ? storedFilters.profileSlug
        : undefined);
    const [subjectCategory, action] = pattern.split(".");
    return {
      triggerType: "event",
      subjectCategory: subjectCategory as TriggerSubjectCategory | undefined,
      // Back through the mood bridge: the stored pattern is imperative, the
      // sentence is past. Without this the editor loads `entity.create.completed`
      // as the verb "create", which is not an `ActionVerb`, so the WHEN row
      // renders empty and re-saving would drop it.
      actionVerb: action
        ? (EVENT_ACTION_TO_VERB[action] ?? (action as ActionVerb))
        : undefined,
      profileSlug,
    };
  }
  return { triggerType: "event" };
}

// Capability-THEN bookkeeping keys. A `type:"capability"` flow node (executor:
// automation-executor.ts `case "capability"` → the shared, governed
// `executeCapability` door) has no dedicated `ActionType` — there is no
// `notify`/`create_entity`/… slot for "call this verb on this capability" — so
// the sentence action for it carries `type: null` and encodes the capability +
// verb in `config` under these `__`-prefixed keys. Mirrors
// `browser/.../rule-sentence/sentence-io.ts`'s `makeCapabilityAction` byte-for-
// byte so the two representations can never diverge.
// (The key constants themselves are declared with the FORWARD converters above,
// so one declaration serves both directions of the grammar.)

function flowNodeToSentenceAction(actionNode: RuleFlowNode): SentenceAction {
  const data = actionNode.data;

  // `output` node → reverse the friendly-alias map from its executor-true
  // outputType.
  //
  // When the outputType has NO friendly `ActionType` alias — six of the
  // executor's eleven outputs (`facet_attach`, `relation_create`, `set_state`,
  // `session_update`, …) — the action is `type: null` and MUST carry the
  // outputType back in `config.__outputType`. Without that the reverse is not
  // the inverse of the forward: the reconstructed action fails
  // `isActionConfigured`, so re-saving an edited rule DROPS the THEN node
  // entirely and the automation silently loses its behaviour. This is the same
  // class as the `data.params` / `data.inputMapping` mismatch below — the two
  // halves of one grammar disagreeing — and the round-trip test is the only
  // thing that catches either.
  if (actionNode.type === "output") {
    const outputType = data.outputType as string | undefined;
    const aliased = outputType
      ? (OUTPUT_TYPE_TO_ACTION[outputType] ?? null)
      : null;
    const config = ((data.config as Record<string, unknown>) ?? {}) as Record<
      string,
      unknown
    >;
    if (aliased === null && outputType) {
      return {
        type: null,
        config: {
          [OUTPUT_TYPE_KEY]: outputType,
          [CAPABILITY_ACTION_KEY]: outputType,
          ...config,
        },
      };
    }
    return { type: aliased, config };
  }
  // `command` node → run_command; surface commandId + promptOverride back as the
  // sentence's `input`, mirroring toFlowDefinition.
  //
  // ⚠️ KNOWN GAP (2026-09-03): a flow ALREADY STORED in a pod may carry the
  // LEGACY `prompt`/`input` field names (see `normalizeCommandNodeData` in
  // `@synap/database`). `data.promptOverride` is `undefined` for those, so the
  // sentence editor shows an empty prompt and saving writes that emptiness
  // back. The fix is to route through `normalizeCommandNodeData`, but that is a
  // VALUE import from `@synap/database`, and this module is deliberately
  // frontend-safe (see the barrel's "NOT re-exported — they pull in
  // postgres/drizzle" note). Fixing it means giving the normalizer a pure home
  // both server and frontend can import — a package-placement decision, not a
  // local `?? data.prompt`, which would just fork the contract a third time.
  if (actionNode.type === "command") {
    return {
      type: "run_command",
      config: { commandId: data.commandId, input: data.promptOverride },
    };
  }
  // `capability` node → a verb call; see the bookkeeping-key comment above.
  // `toFlowDefinition` does not emit this node type (a capability THEN is
  // authored via the browser's own `sentenceToWriteInput`, not this module's
  // writer) — this is a READ-side addition only, so an existing capability rule
  // round-trips instead of being silently dropped.
  if (actionNode.type === "capability") {
    const cdata = data as {
      capabilityId?: string;
      verbId?: string;
      inputMapping?: Record<string, unknown>;
    };
    return {
      type: null,
      config: {
        [CAPABILITY_NODE_TYPE_KEY]: "capability",
        [CAPABILITY_ID_KEY]: cdata.capabilityId ?? "",
        [CAPABILITY_VERB_ID_KEY]: cdata.verbId ?? "",
        [CAPABILITY_ACTION_KEY]: `verb:${cdata.verbId ?? ""}`,
        ...(cdata.inputMapping ?? {}),
      },
    };
  }
  // Legacy `type:"action"` nodes (stored before the executor-true fix) still
  // round-trip via their old `stepType`.
  return {
    type: (data.stepType ?? null) as ActionType | null,
    config: (data.config as Record<string, unknown>) ?? {},
  };
}

/**
 * Read ALL non-trigger action nodes off a stored flow, in order — the reverse of
 * `toFlowDefinition` (which writes N `output`/`command` nodes), plus `capability`
 * nodes which `toFlowDefinition` does not emit (see `flowNodeToSentenceAction`).
 * `flowToSentenceAction` (singular) is implemented in terms of this so the two
 * can never disagree.
 */
export function flowToSentenceActions(
  flow: RuleFlowDefinition
): SentenceAction[] {
  return flow.nodes
    .filter((n) => n.type !== "trigger")
    .map(flowNodeToSentenceAction);
}

/**
 * @deprecated lossy — keeps only the FIRST action of a multi-action rule. Kept
 * for existing single-action callers; new code should use
 * `flowToSentenceActions` (plural).
 */
export function flowToSentenceAction(flow: RuleFlowDefinition): SentenceAction {
  return flowToSentenceActions(flow)[0] ?? { type: null, config: {} };
}

export function flowToConditions(
  triggerConfig: Record<string, unknown>
): ConditionRow[] {
  const filters = triggerConfig.filters as Record<string, string> | undefined;
  if (!filters) return [];
  return Object.entries(filters).map(([key, value], i) => ({
    id: `filter-${i}`,
    key,
    operator: "is" as const,
    value,
  }));
}
