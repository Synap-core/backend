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
    return {
      triggerType: "event",
      triggerConfig: {
        ...(pattern ? { eventPattern: pattern } : {}),
        ...(trigger.profileSlug ? { profileSlug: trigger.profileSlug } : {}),
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
  // Every other action → an `output` node keyed on its executor-true outputType.
  const outputType = action.type
    ? ACTION_TO_OUTPUT_TYPE[action.type]
    : undefined;
  return {
    id: nodeId,
    type: "output",
    position: { x: 0, y },
    data: {
      label: outputType ?? "",
      outputType,
      config: action.config,
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

  const configuredActions = actions.filter((a) => a.type !== null);
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
    const profileSlug = triggerConfig.profileSlug as string | undefined;
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
const CAPABILITY_NODE_TYPE_KEY = "__nodeType";
const CAPABILITY_ID_KEY = "__capabilityId";
const CAPABILITY_VERB_ID_KEY = "__verbId";
const CAPABILITY_ACTION_KEY = "__actionKey";

function flowNodeToSentenceAction(actionNode: RuleFlowNode): SentenceAction {
  const data = actionNode.data;

  // `output` node → reverse the friendly-alias map from its executor-true outputType.
  if (actionNode.type === "output") {
    const outputType = data.outputType as string | undefined;
    return {
      type: outputType ? (OUTPUT_TYPE_TO_ACTION[outputType] ?? null) : null,
      config: (data.config as Record<string, unknown>) ?? {},
    };
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
