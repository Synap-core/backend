/**
 * Automation schema reference document — static, agent-readable.
 *
 * Served at GET /api/hub/automations/schema. Describes all trigger types, node
 * types, template syntax, and CLI quick-create flags for the pod automation
 * engine. No DB queries — a frozen reference object.
 *
 * EVENT TAXONOMY (read this before writing an event-trigger pattern):
 *   The runtime emits `<subject>.<action>.completed` for ALL materialized
 *   mutations — that is the phase that ALWAYS fires once a write lands.
 *   `<subject>.<action>.validated` fires ONLY when a mutation goes through the
 *   proposal-approval path (an agent write that needed human approval). An
 *   automation that wants to react to every entity create must therefore match
 *   `.completed`, NOT `.validated` — `.validated` would silently miss every
 *   auto-approved / direct write.
 *
 * NODE TYPES ARE DERIVED, NEVER HAND-LISTED (dogfooded 2026-09-12, D5).
 *   `nodeTypes` used to be a hand-written object literal, and it fell behind the
 *   executor: it documented TEN of the twenty-three types `FLOW_NODE_TYPES`
 *   accepts, silently omitting `playbook_run` and `capability` among others. An
 *   agent authoring a flow from this door (the ONLY machine-readable description
 *   of the DSL) therefore could not emit a playbook step at all — the grammar
 *   accepted it, the reference denied it existed.
 *   The map below is now keyed by `FLOW_NODE_TYPES` through a `Record<…>` whose
 *   key type is the union itself, so a node type added to the executor and not
 *   documented here FAILS THE BUILD. Do not replace this with a plain object.
 */

import { FLOW_NODE_TYPES } from "../../../services/automations/validate-flow.js";

/** One node type's agent-readable reference entry. */
type NodeTypeDoc = {
  description: string;
  fields?: Record<string, string>;
  outputTypes?: Record<string, { fields: Record<string, string> }>;
};

/**
 * COMPILE-TIME COVERAGE FLOOR: the key type is the executor's own union, so
 * every accepted node type must carry a doc entry or `tsc` refuses. This is the
 * derivation — `nodeTypes` below is built by iterating `FLOW_NODE_TYPES`, so the
 * SERVED set is the EXECUTOR's set by construction, not by anyone remembering.
 */
const NODE_TYPE_DOCS: Record<(typeof FLOW_NODE_TYPES)[number], NodeTypeDoc> = {
  trigger: {
    description:
      "Entry node. Always present. No additional data fields beyond triggerType + config (set at top level).",
  },
  output: {
    description:
      "Executes an action — notification, entity write, webhook call, or channel message",
    outputTypes: {
      notification: {
        fields: {
          title: "string",
          body: "string",
          userId: "string (optional — targets specific user)",
        },
      },
      entity_create: {
        fields: {
          profileSlug: "string",
          name: "string (template)",
          properties: "Record<string,unknown> (template values)",
        },
      },
      entity_update: {
        fields: {
          entityId: "string (template)",
          properties: "Record<string,unknown>",
        },
      },
      webhook: {
        fields: {
          url: "string",
          method: "GET|POST|PUT|PATCH|DELETE",
          headers: "Record<string,string>",
          body: "string (template)",
        },
      },
      channel_message: {
        fields: {
          channelId: "string",
          content: "string (template)",
        },
      },
    },
  },
  command: {
    description: "Calls a pod intelligence command by ID",
    fields: {
      commandId: "string — ID of the intelligence_command to invoke",
      commandTitle: "string — human label",
      inputMapping:
        "Record<string,string> — maps command inputs to prior step outputs using {{stepId.output.field}} syntax",
      promptOverride:
        "string (optional) — augments the command's default prompt",
    },
  },
  condition: {
    description: "Evaluates an expression and routes to yes/no branches",
    fields: {
      expression:
        "string — JS-like expression over the trigger payload / prior steps. E.g. \"trigger.payload.data.profileSlug === 'note'\"",
      trueLabel: "string (optional)",
      falseLabel: "string (optional)",
    },
  },
  delay: {
    description: "Pauses execution for a duration before continuing",
    fields: { duration: "string — e.g. '5m', '1h', '2d'" },
  },
  fetch: {
    description: "Makes an HTTP request",
    fields: {
      method: "GET|POST|PUT|DELETE|PATCH",
      url: "string (template)",
      headers: "Record<string,string>",
      body: "string (template)",
    },
  },
  query: {
    description: "Queries entities in the workspace by profile",
    fields: {
      profileSlug: "string",
      filter: "string — filter expression",
      limit: "number",
    },
  },
  transform: {
    description: "Applies a pipe-style expression to a prior step value",
    fields: {
      expression: "string — e.g. '{{stepId.output}} | uppercase'",
    },
  },
  loop: {
    description: "Iterates over a collection, executing child nodes per item",
    fields: {
      iteratorExpression: "string — e.g. 'steps.query1.output.results'",
      itemVariable:
        "string — variable name inside loop, referenced as {{loop.item}}",
    },
  },
  switch: {
    description:
      "Routes to one of several branches based on an expression value",
    fields: {
      expression: "string",
      cases: "Array<{ value: string, label: string }>",
    },
  },
  entity_read: {
    description:
      "Reads ONE entity by id, within the automation's workspace/pod lens",
    fields: {
      entityId: "string (template) — the entity to read",
    },
  },
  related_entities: {
    description:
      "Traverses a bounded set of graph relations and projects the counterparties",
    fields: {
      entityId: "string (template) — the entity to traverse from",
      direction: "outbound|inbound|both (optional)",
      relationTypes: "string[] (optional) — restrict to these relation types",
      propertyEquals: "Record<string,unknown> (optional) — AND predicates",
      propertyAnyEquals:
        "Record<string,unknown[]> (optional) — OR across predicates",
      excludeEntityId:
        "string (optional) — drop a known counterparty (e.g. the trigger entity)",
      limit: "number (optional)",
    },
  },
  guard: {
    description:
      "Fail-CLOSED business guard — refuses to continue with an actionable reason",
    fields: {
      checks:
        "Array<{ path, exists?, equals?, notEquals?, arrayIncludes?, lengthEquals?, minLength?, numberGte? }> — `exists` is a NULL check that '' and 0 satisfy; use `minLength: 1` to assert CONTENT",
    },
  },
  compute: {
    description: "Finite numeric operation over literal or template values",
    fields: {
      operation: "add|subtract|multiply|divide|coalesce|now",
      left: "unknown (template) — operands for the binary operations",
      right: "unknown (template)",
      values: "unknown[] — for `coalesce`: first finite numeric value wins",
    },
  },
  select: {
    description:
      "Chooses one typed value from a boolean produced by a prior deterministic step",
    fields: {
      when: "unknown (template) — the boolean to branch on",
      ifTrue: "unknown",
      ifFalse: "unknown",
    },
  },
  claim: {
    description:
      "Atomically reserves a namespace-scoped key — the FIRST run to claim it sees `claimed: true`, later runs see false (one-time policy decisions; released on terminal failure)",
    fields: {
      namespace: "string",
      key: "string (template)",
    },
  },
  messages_query: {
    description:
      "Source node: reads recent messages from the channel(s) bound to an entity (or one channel directly)",
    fields: {
      subjectEntityId:
        "string (template) — read the channels bound to this entity",
      channelId:
        "string — read this channel directly (wins over subjectEntityId)",
      scope:
        "single-external (default) | all-channels — fan across every bound channel and merge chronologically",
      channelTypes:
        "string[] — all-channels only: restrict to these channel types",
      branchPurpose:
        "string — all-channels only: restrict to this firewall purpose",
      limit: "number — most-recent N per channel (default 40, capped 200)",
      includeDocuments:
        "boolean — also gather the entity's linked document titles + body previews",
    },
  },
  runs_query: {
    description:
      "Source node: reads this pod's OWN automation run ledger (self-narration — 'what broke last night')",
    fields: {
      automationId: "string (template) — only runs of this automation",
      status: "string — one value or a comma-separated list",
      since: "string — ISO-8601 / epoch ms lower bound",
      subjectEntityId: "string — only runs launched ABOUT this entity",
      limit: "number — most-recent N (default 20, capped 100)",
    },
  },
  proposals_query: {
    description: "Source node: reads this pod's governance proposal queue",
    fields: {
      status: "string — one value or a comma-separated list",
      targetType: "string — entity | facet | document | …",
      changeType: "string — the normalized change kind",
      correlationId: "string — all proposals of one request chain",
      sessionId: "string — all proposals produced in one agent session",
      proposalIds: "string (comma-separated) | string[]",
      since: "string — ISO-8601 / epoch ms lower bound",
      limit: "number — most-recent N (default 20, capped 100)",
    },
  },
  skill: {
    description: "Runs a pod SKILL by id, through the capability gate",
    fields: {
      skillId: "string — the skill to run",
      skillTitle: "string — human label",
      inputMapping:
        "Record<string,string> — maps skill inputs to prior step outputs ({{steps.id.output}})",
    },
  },
  capability: {
    description:
      "Typed, governed Tool → Verb step. Pick a tool (`capabilityId`) and a verb on it (`verbId`); the executor resolves the verb to its backing skill and runs it through the SAME gate the `skill` node uses",
    fields: {
      capabilityId: "string — tool row id of the selected capability",
      capabilityName: "string (optional) — display name",
      verbId: "string — the verb id (= the requiring skill's NAME)",
      verbLabel: "string (optional)",
      verbKind: "read|write|action (optional)",
      execMode: "auto|propose|dry-run (optional)",
      inputMapping:
        "Record<string,string> — maps verb args to prior step outputs ({{steps.id.output}})",
    },
  },
  sub_automation: {
    description: "Invokes another automation as a step",
    fields: {
      automationId: "string — the automation to run",
      automationName: "string (optional) — human label",
      payloadMapping:
        "Record<string,string> — builds the sub-automation's trigger payload from prior step outputs",
    },
  },
  playbook_run: {
    description:
      "Spawns a PLAYBOOK run (a focus session with an agent answering it). This is how an automation creates a session — never an output node",
    fields: {
      playbookId: "string — the playbook to run (or use playbookName)",
      playbookName:
        "string — resolve by stable name instead (template-friendly; a capability references its seeded playbook this way). One of playbookId/playbookName is REQUIRED",
      paramsMapping:
        "Record<string,string> — maps prior step outputs to playbook params",
      agentType:
        "string (optional) — `agents.slug` of the agent that should answer the spawned run. Absent ⇒ the default orchestrator ('meta')",
    },
  },
};

export const AUTOMATION_SCHEMA = {
  triggerTypes: {
    event: {
      description: "Fires when a pod event matches the pattern",
      fields: {
        eventPattern:
          "string — event path with optional trailing wildcard. E.g. 'entity.create.completed', 'entity.*', 'capture.complete.completed'",
        filters:
          "Record<string,unknown> — each KEY is a dot-notation path into event.data; each VALUE is either a plain string/number/boolean/null (exact match) or an operator object. Supported operators: $eq, $ne, $in (non-empty array), $gt, $gte, $lt, $lte (compared numerically). E.g. { 'profileSlug': 'note' }, { 'profileSlug': { '$in': ['person','contact'] } }, { 'metadata.priority': 'high' }, { 'score': { '$gt': 30 } }. ENTITY PROPERTIES ARE FLAT: `entity.update.completed` spreads the entity's changed properties directly onto event.data under their BARE slug, so the key is 'score' — NOT 'properties.score', which resolves to undefined and silently never matches. ENFORCED at create/update: a bare ARRAY value or a NESTED OBJECT value is REJECTED (use $in for several values; use a dot-notation key to reach nested data) — such a filter can never match, and the automation would install 'active' and silently never fire.",
      },
      // PHASE GUIDANCE: `.completed` is the phase that ALWAYS fires when a
      // mutation materializes — use it to react to every write. `.validated`
      // fires ONLY on the proposal-approval path (an agent write that required
      // human approval), so a `.validated` trigger silently misses every
      // auto-approved / direct mutation. Prefer `.completed` unless you
      // specifically want "only writes that went through approval".
      phaseGuidance: {
        completed:
          "ALWAYS fires when a mutation materializes (auto-approved, direct, OR proposal-approved). Use this to react to every write.",
        validated:
          "Fires ONLY when a mutation goes through proposal approval. Use this to react specifically to approved-after-review writes; it MISSES auto-approved/direct writes.",
        requested:
          "Fires when a write is first requested (before any approval/materialization). Rarely what you want for a side effect.",
      },
      commonPatterns: [
        "entity.create.completed",
        "entity.update.completed",
        "entity.delete.completed",
        "capture.complete.completed",
        "channel_message.create.completed",
        "connector_sync.complete.completed",
        "relation.create.completed",
        "proposal.approved.completed",
        "proposal.rejected.completed",
        "entity.create.validated (proposal-approval path only)",
        "entity.*",
        "capture.*",
      ],
    },
    cron: {
      description: "Fires on a schedule",
      fields: {
        expression:
          "string — standard cron expression. E.g. '0 9 * * MON' (Mon 9am), '*/30 * * * *' (every 30min), '0 8 * * *' (daily 8am)",
      },
    },
    webhook: {
      description: "Fires when an inbound webhook is received",
      fields: {
        webhookSubscriptionId:
          "string — ID of the webhook subscription to listen on",
      },
    },
    manual: {
      description:
        "User-triggered via API or pod-admin. No trigger config needed.",
    },
  },
  /**
   * DERIVED from the executor's own node-type list — never hand-written.
   * `FLOW_NODE_TYPES` (services/automations/validate-flow.ts) is what
   * `validateFlowDefinition` accepts, so the SERVED set is the ACCEPTED set by
   * construction. `NODE_TYPE_DOCS` is keyed by that union, so an undocumented
   * new node type is a compile error, not a silent omission.
   */
  nodeTypes: Object.fromEntries(
    FLOW_NODE_TYPES.map((t) => [t, NODE_TYPE_DOCS[t]])
  ) as Record<(typeof FLOW_NODE_TYPES)[number], NodeTypeDoc>,
  templateSyntax: {
    description:
      "All string fields in node data support {{...}} template interpolation at runtime",
    variables: {
      "trigger.payload":
        "The full event payload that fired the automation. Shape: { eventType, subjectId, data, userId, timestamp } — there is NO `entity` key.",
      "trigger.payload.subjectId":
        "The id of the entity/subject the event is about (e.g. the created entity's id). This is how you reference the triggering entity — NOT `trigger.payload.entity`.",
      "trigger.payload.data":
        "For entity events: the event's data payload. E.g. entity.create.completed carries { profileSlug, title }; entity.update.completed carries { profileSlug, changedKeys, ...changed values }.",
      "trigger.payload.data.title":
        "Entity title (entity create/update events).",
      "trigger.payload.eventType":
        "The matched event type string, e.g. 'entity.create.completed'.",
      "trigger.payload.timestamp": "ISO timestamp of when the event fired.",
      "steps.<nodeId>.output": "Output of a prior step by node ID",
      "loop.item": "Current item inside a loop node",
      "env.VAR_NAME":
        "Resolved by the CLI from environment variables before sending",
    },
  },
  errorHandling: {
    description:
      "Per-node error handling on command/fetch/transform/query nodes",
    fields: {
      continueOnError: "boolean — record error but continue execution",
      maxRetries: "number 0-3 — retry attempts before failing",
      retryDelay: "number (ms) — wait between retries",
    },
  },
  status: {
    values: ["draft", "active", "paused", "error"],
    description:
      "draft = created but not running; active = live; paused = temporarily stopped; error = execution failure",
  },
  cliQuickCreate: {
    description: "synap automation create quick-mode flag reference",
    flags: {
      "--trigger":
        "event:<pattern> | cron:<expr> | webhook | manual. E.g. --trigger 'event:entity.create.completed'",
      "--filter":
        "key=value filter on event data (only for event triggers). Repeatable. E.g. --filter 'profileSlug=note'",
      "--action":
        "notify | entity-create:<profileSlug> | channel-message | webhook:<url> | none (for draft). E.g. --action notify",
      "--message":
        "Message content for notify/channel-message actions (supports {{trigger.payload.data.title}})",
      "--channel": "Channel ID for channel-message action",
      "--status": "draft (default) | active — whether to activate immediately",
    },
    examples: [
      "synap automation create --name 'Note → notify' --trigger 'event:entity.create.completed' --filter 'profileSlug=note' --action notify --message 'New note: {{trigger.payload.data.title}}'",
      "synap automation create --name 'Weekly digest' --trigger 'cron:0 9 * * MON' --action channel-message --channel '#general' --message 'Weekly digest is ready.'",
      "synap automation create --name 'Import hook' --trigger webhook --status draft",
    ],
  },
  yamlFormat: {
    description:
      "Full YAML format for complex flows (synap automation create --from file.yaml)",
    example:
      "name: 'High-priority note alert'\ntrigger: event\ntriggerConfig:\n  eventPattern: entity.create.completed\n  filters:\n    profileSlug: note\nstatus: active\nflow:\n  nodes:\n    - id: trigger-1\n      type: trigger\n      position: { x: 0, y: 0 }\n      data:\n        triggerType: event\n        label: Entity created\n        config:\n          eventPattern: entity.create.completed\n    - id: output-1\n      type: output\n      position: { x: 0, y: 200 }\n      data:\n        label: Send notification\n        outputType: notification\n        config:\n          title: 'New note'\n          body: '{{trigger.payload.data.title}}'\n  edges:\n    - id: e1\n      source: trigger-1\n      target: output-1",
  },
} as const;
