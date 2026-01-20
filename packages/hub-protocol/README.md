# @synap/hub-protocol

**Hub Protocol V1.0** - Standardized schemas for communication between Synap Intelligence Hub and Synap Core OS (Data Pod).

## Installation

```bash
pnpm add @synap/hub-protocol
# or
npm install @synap/hub-protocol
```

## Usage

### Basic Validation

```typescript
import { validateHubInsight, type HubInsight } from "@synap/hub-protocol";

const insight: HubInsight = {
  version: "1.0",
  type: "action_plan",
  correlationId: "123e4567-e89b-12d3-a456-426614174000",
  actions: [
    {
      eventType: "project.creation.requested",
      data: { title: "My Project" },
      requiresConfirmation: false,
    },
  ],
  confidence: 0.95,
  reasoning: "Based on user preferences",
};

// Validate the insight
const validated = validateHubInsight(insight);
```

### Type Guards

```typescript
import { isActionPlan, isAnalysis } from "@synap/hub-protocol";

if (isActionPlan(insight)) {
  // TypeScript knows actions is defined
  insight.actions.forEach((action) => {
    console.log(action.eventType);
  });
}

if (isAnalysis(insight)) {
  // TypeScript knows analysis is defined
  console.log(insight.analysis.title);
}
```

### Schemas

```typescript
import {
  HubInsightSchema,
  ActionSchema,
  AnalysisSchema,
} from "@synap/hub-protocol";

// Use with Zod for custom validation
const result = HubInsightSchema.safeParse(data);
if (result.success) {
  // Valid insight
}
```

## Schema Reference

### HubInsight

The main schema for insights returned by the Intelligence Hub.

- `version`: `'1.0'` (literal)
- `type`: `'action_plan' | 'suggestion' | 'analysis' | 'automation'`
- `correlationId`: UUID string
- `actions`: Array of `Action` (optional, for action_plan/automation)
- `analysis`: `Analysis` object (optional, for analysis/suggestion)
- `confidence`: Number between 0.0 and 1.0
- `reasoning`: String (optional)
- `metadata`: Record<string, unknown> (optional)

### Action

Represents an action to be transformed into a SynapEvent.

- `eventType`: String (must match EventTypes)
- `subjectId`: UUID string (optional)
- `data`: Record<string, unknown>
- `requiresConfirmation`: Boolean (default: false)
- `priority`: Number 0-100 (optional)
- `metadata`: Record<string, unknown> (optional)

### Analysis

Contains textual analysis to display to the user.

- `title`: String
- `content`: String (markdown supported)
- `keyPoints`: Array of strings (optional)
- `recommendations`: Array of strings (optional)
- `sources`: Array of Source objects (optional)
- `tags`: Array of strings (optional)

## Documentation

See [Hub Protocol V1.0 Specification](../../docs/architecture/PRDs/HUB_PROTOCOL_V1.md) for complete documentation.

## License

MIT
