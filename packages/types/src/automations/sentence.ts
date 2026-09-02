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

export function buildEventPattern(trigger: SentenceTrigger): string {
  if (!trigger.subjectCategory) return "";
  const { subjectCategory, actionVerb } = trigger;

  const PATTERN_MAP: Record<string, string> = {
    entity: `entity.${actionVerb ?? "create"}.completed`,
    external_message: "external_message.received.completed",
    capture: "capture.complete.completed",
    notification: "notification.created.completed",
    feed_item: "feed.new_item.completed",
    inbox_item: "inbox_item.received.completed",
  };

  return (
    PATTERN_MAP[subjectCategory] ??
    `${subjectCategory}.${actionVerb ?? "created"}.completed`
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
    return {
      triggerType: "cron",
      triggerConfig: {
        cron: buildCronExpression(trigger),
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
    const cron = (triggerConfig.cron as string) ?? "0 9 * * *";
    const timezone = (triggerConfig.timezone as string) ?? "UTC";
    return { triggerType: "cron", ...parseCron(cron), cronTimezone: timezone };
  }
  // webhook/manual don't map to SentenceTrigger — treat as a bare event trigger
  if (triggerType === "event") {
    const pattern = (triggerConfig.eventPattern as string) ?? "";
    const profileSlug = triggerConfig.profileSlug as string | undefined;
    const [subjectCategory, actionVerb] = pattern.split(".");
    return {
      triggerType: "event",
      subjectCategory: subjectCategory as TriggerSubjectCategory | undefined,
      actionVerb: actionVerb as ActionVerb | undefined,
      profileSlug,
    };
  }
  return { triggerType: "event" };
}

export function flowToSentenceAction(flow: RuleFlowDefinition): SentenceAction {
  // Find the first non-trigger node — it holds the sentence action
  const actionNode = flow.nodes.find((n) => n.type !== "trigger");
  if (!actionNode) return { type: null, config: {} };
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
  if (actionNode.type === "command") {
    return {
      type: "run_command",
      config: { commandId: data.commandId, input: data.promptOverride },
    };
  }
  // Legacy `type:"action"` nodes (stored before the executor-true fix) still
  // round-trip via their old `stepType`.
  return {
    type: (data.stepType ?? null) as ActionType | null,
    config: (data.config as Record<string, unknown>) ?? {},
  };
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
