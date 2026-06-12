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
 */

export const AUTOMATION_SCHEMA = {
  triggerTypes: {
    event: {
      description: "Fires when a pod event matches the pattern",
      fields: {
        eventPattern:
          "string — event path with optional trailing wildcard. E.g. 'entity.create.completed', 'entity.*', 'capture.complete.completed'",
        filters:
          "Record<string,unknown> — dot-notation key-value equality checks on event.data. E.g. { 'profileSlug': 'note', 'metadata.priority': 'high' }",
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
        "proposal.approved",
        "proposal.rejected",
        "connector_sync.complete.completed",
        "relation.create.completed",
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
  nodeTypes: {
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
          "string — JS-like expression. E.g. \"trigger.payload.entity.metadata.priority === 'high'\"",
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
  },
  templateSyntax: {
    description:
      "All string fields in node data support {{...}} template interpolation at runtime",
    variables: {
      "trigger.payload": "The full event payload that fired the automation",
      "trigger.payload.entity": "For entity events: the entity object",
      "trigger.payload.entity.title": "Entity title",
      "trigger.payload.entity.properties": "Entity properties JSONB",
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
        "Message content for notify/channel-message actions (supports {{trigger.payload.entity.title}})",
      "--channel": "Channel ID for channel-message action",
      "--status": "draft (default) | active — whether to activate immediately",
    },
    examples: [
      "synap automation create --name 'Note → notify' --trigger 'event:entity.create.completed' --filter 'profileSlug=note' --action notify --message 'New note: {{trigger.payload.entity.title}}'",
      "synap automation create --name 'Weekly digest' --trigger 'cron:0 9 * * MON' --action channel-message --channel '#general' --message 'Weekly digest is ready.'",
      "synap automation create --name 'Import hook' --trigger webhook --status draft",
    ],
  },
  yamlFormat: {
    description:
      "Full YAML format for complex flows (synap automation create --from file.yaml)",
    example:
      "name: 'High-priority note alert'\ntrigger: event\ntriggerConfig:\n  eventPattern: entity.create.completed\n  filters:\n    profileSlug: note\nstatus: active\nflow:\n  nodes:\n    - id: trigger-1\n      type: trigger\n      position: { x: 0, y: 0 }\n      data:\n        triggerType: event\n        label: Entity created\n        config:\n          eventPattern: entity.create.completed\n    - id: output-1\n      type: output\n      position: { x: 0, y: 200 }\n      data:\n        label: Send notification\n        outputType: notification\n        config:\n          title: 'New note'\n          body: '{{trigger.payload.entity.title}}'\n  edges:\n    - id: e1\n      source: trigger-1\n      target: output-1",
  },
} as const;
