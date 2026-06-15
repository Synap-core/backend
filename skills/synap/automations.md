# Automations

Create workflow automations that trigger automatically based on events, schedules, or webhooks.

## Automation Structure

Every automation has:

1. **Trigger** (exactly one) — what starts the automation
2. **Steps** (one or more) — commands, conditions, delays, outputs connected in a flow

## Trigger Types

| Type      | Config                       | Example                              |
| --------- | ---------------------------- | ------------------------------------ |
| `event`   | `{ eventPattern, filters? }` | Entity created with specific profile |
| `cron`    | `{ expression }`             | Daily at 9am: `"0 9 * * *"`          |
| `webhook` | `{ webhookSubscriptionId }`  | External service sends data          |
| `manual`  | `{}`                         | User-triggered from UI               |

### Event Patterns

Format: `{subjectType}.{action}.completed`

Common patterns:

- `entity.create.completed` — entity created and persisted
- `entity.update.completed` — entity updated
- `entity.delete.completed` — entity deleted
- `document.create.completed` — document created
- `document.update.completed` — document updated

Filters narrow the event to specific conditions:

```json
{
  "eventPattern": "entity.create.completed",
  "filters": { "profileSlug": "task", "metadata.priority": "high" }
}
```

### Cron Expressions

Standard 5-field cron (minute hour day month weekday):

- `"0 9 * * *"` — daily at 9am
- `"0 9 * * MON"` — every Monday at 9am
- `"*/30 * * * *"` — every 30 minutes
- `"0 0 1 * *"` — first day of month at midnight

## Step Types

### command

Execute an intelligence command. Reference by `commandId` or describe inline.

```json
{
  "id": "extract",
  "type": "command",
  "data": {
    "commandTitle": "Extract key entities",
    "inputMapping": {
      "content": "{{trigger.payload.entity.content}}",
      "context": "{{trigger.payload.entity.name}}"
    }
  }
}
```

**Input mapping** uses template syntax:

- `{{trigger.payload.*}}` — data from the triggering event
- `{{steps.<stepId>.output.*}}` — output from a prior step
- `{{loop.item}}` — current item in a loop

### condition

Branch the flow based on a boolean expression.

```json
{
  "id": "check-priority",
  "type": "condition",
  "data": {
    "label": "High priority?",
    "expression": "trigger.payload.entity.metadata.priority === 'high'",
    "trueLabel": "Yes",
    "falseLabel": "No"
  }
}
```

Conditions have two output handles: `yes` and `no`. Connect subsequent steps to the appropriate handle.

### delay

Wait before continuing.

```json
{
  "id": "wait",
  "type": "delay",
  "data": { "duration": "5m", "label": "Cool down" }
}
```

Supported durations: `30s`, `5m`, `1h`, `1d`, `1w`.

### output

Terminal action — the end result of the automation.

```json
{
  "id": "notify",
  "type": "output",
  "data": {
    "label": "Send notification",
    "outputType": "notification",
    "config": {
      "message": "New high-priority task: {{trigger.payload.entity.name}}"
    }
  }
}
```

Output types:

- `notification` — in-app notification to the user
- `entity_create` — create a new entity (config: `{ profileSlug, title, properties }`)
- `entity_update` — update an existing entity (config: `{ entityId, properties }`)
- `webhook` — POST to external URL (config: `{ url, headers?, body }`)
- `channel_message` — post a message to a channel (config: `{ channelId, content }`)

### loop

Iterate over a collection from a prior step.

```json
{
  "id": "for-each-result",
  "type": "loop",
  "data": {
    "label": "For each search result",
    "iteratorExpression": "steps.search.output.results",
    "itemVariable": "item"
  }
}
```

Inside the loop, reference `{{loop.item}}` for the current element.

## Connecting Steps

Steps are connected via `dependsOn` (which step must complete first) and optional `conditionBranch` (which branch to follow from a condition).

```json
{
  "steps": [
    { "id": "check", "type": "condition", "data": {...} },
    { "id": "notify-high", "type": "output", "data": {...}, "dependsOn": ["check"], "conditionBranch": "yes" },
    { "id": "log-normal", "type": "output", "data": {...}, "dependsOn": ["check"], "conditionBranch": "no" }
  ]
}
```

## Discovering Commands

Before creating automations with command steps, call `list_commands` to discover available intelligence commands in the workspace. Use the command `id` in the step's `commandId` field.

If no suitable command exists, you can leave `commandId` empty and set `commandTitle` + `inputMapping` — the execution engine will use the title as a prompt template.

## Vault References

Automation configs that need secrets (API keys, auth tokens) should use vault references instead of hardcoded values:

- `vault://secret-uuid` — resolves to the full secret value at runtime
- `vault://secret-uuid/field-name` — resolves a specific field from a JSON secret

Only server-encrypted secrets can be resolved by the automation engine. The user must store the credential in the vault first.

## Best Practices

1. **Keep it simple** — Start with trigger → command → output. Add complexity only when needed.
2. **Name clearly** — Use descriptive labels: "When task created with high priority" not "Trigger 1".
3. **One purpose** — Each automation should do one thing well. Compose multiple automations rather than building one complex flow.
4. **Filter early** — Use trigger filters to avoid unnecessary execution. Don't use a condition step when a trigger filter suffices.
5. **Test first** — Create automations as `draft` status. Let the user review the flow visualization before activating.

## Example: Auto-archive completed tasks

```json
{
  "name": "Auto-archive completed tasks",
  "description": "When a task status changes to 'done', archive it after 24 hours",
  "trigger": {
    "type": "event",
    "config": {
      "eventPattern": "entity.update.completed",
      "filters": { "profileSlug": "task", "metadata.status": "done" }
    }
  },
  "steps": [
    {
      "id": "wait-24h",
      "type": "delay",
      "data": { "duration": "1d", "label": "Wait 24h" }
    },
    {
      "id": "archive",
      "type": "output",
      "data": {
        "label": "Archive task",
        "outputType": "entity_update",
        "config": {
          "entityId": "{{trigger.payload.entity.id}}",
          "properties": { "archived": true }
        }
      },
      "dependsOn": ["wait-24h"]
    }
  ]
}
```

## Example: Notify on high-priority tasks

```json
{
  "name": "High-priority task alerts",
  "description": "Send a notification when a high-priority task is created",
  "trigger": {
    "type": "event",
    "config": {
      "eventPattern": "entity.create.completed",
      "filters": { "profileSlug": "task" }
    }
  },
  "steps": [
    {
      "id": "check-priority",
      "type": "condition",
      "data": {
        "label": "High priority?",
        "expression": "trigger.payload.entity.metadata.priority === 'high'"
      }
    },
    {
      "id": "notify",
      "type": "output",
      "data": {
        "label": "Alert: high-priority task",
        "outputType": "notification",
        "config": {
          "message": "New urgent task: {{trigger.payload.entity.name}}"
        }
      },
      "dependsOn": ["check-priority"],
      "conditionBranch": "yes"
    }
  ]
}
```
