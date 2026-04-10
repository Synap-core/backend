# Event Chain & Signal Routing

> Last updated: 2026-04-10 — P1-P4 complete

## Overview

Synap's event spine connects every state change to every reaction surface. Two mechanisms work in parallel:

- **pg-boss jobs** — async side-effects (search indexing, automation trigger matching, webhooks)
- **Event log** (`events` table) — audit trail + cross-pod sync source

Every meaningful mutation flows through `emitSideEffects()` + `eventRepository.append()`:

```
Something happens
      │
      ├── pg-boss "automation-trigger-match" → automations react
      ├── pg-boss "search-index"             → Typesense updated
      ├── pg-boss "webhook-delivery"         → outbound webhooks fired
      └── events table append               → audit log + pod sync
```

## Event Type Registry

All event type strings are declared in `packages/events/src/event-types.ts` as `OperationalEventTypes`.

| Constant                  | String                              | Description                     |
| ------------------------- | ----------------------------------- | ------------------------------- |
| `ENTITY_CREATED`          | `entity.create.completed`           | Entity created                  |
| `ENTITY_UPDATED`          | `entity.update.completed`           | Entity properties updated       |
| `ENTITY_DELETED`          | `entity.delete.completed`           | Entity deleted                  |
| `PROPOSAL_CREATED`        | `proposal.created.completed`        | Proposal submitted              |
| `PROPOSAL_APPROVED`       | `proposal.approved.completed`       | Proposal approved by user       |
| `PROPOSAL_REJECTED`       | `proposal.rejected.completed`       | Proposal rejected               |
| `RELATION_CREATED`        | `relation.create.completed`         | Entity relation added           |
| `RELATION_DELETED`        | `relation.delete.completed`         | Entity relation removed         |
| `CAPTURE_COMPLETE`        | `capture.complete.completed`        | Quick capture pipeline finished |
| `CONNECTOR_SYNC_COMPLETE` | `connector_sync.complete.completed` | Connector sync batch finished   |
| `PROACTIVE_POST`          | `proactive.post.completed`          | Proactive message delivered     |
| `NOTIFICATION_CREATED`    | `notification.created`              | Notification persisted          |
| `CHANNEL_MESSAGE_CREATED` | `channel_message.created.completed` | Message posted via automation   |

Import from `@synap/events`:

```typescript
import { OperationalEventTypes } from "@synap/events";
eventType === OperationalEventTypes.ENTITY_CREATED; // "entity.create.completed"
```

## Automation Trigger Config

`AutomationTriggerConfig` in `packages/database/src/schema/automations.ts` is a typed flat
interface. The trigger kind is the `automations.triggerType` column — the config holds the
per-kind settings.

All domain-specific filter fields are typed (no `& Record<string, unknown>` casts needed):

```typescript
interface AutomationTriggerConfig {
  // event trigger
  eventPattern?: string; // "entities.*", "capture.complete.completed"
  filters?: Record<string, unknown>; // generic dot-notation key=value filters

  // connector_sync filters
  provider?: string; // "google-calendar", "github"
  syncStatus?: "success" | "error" | "any";

  // capture filters
  profileSlug?: string; // "person", "company", "any"

  // channel_message filters
  channelId?: string;
  messageRole?: "user" | "assistant" | "any";

  // relation filters
  relationType?: string;
  changeType?: "create" | "delete" | "any";

  // proposal filters
  proposalEventType?: "created" | "approved" | "rejected" | "any";

  // proactive filters
  proactiveType?: string; // "morning_briefing", "insight", "any"

  // cron trigger
  expression?: string; // "0 9 * * MON"

  // webhook trigger
  webhookSubscriptionId?: string;
}
```

## Delivery Router (Phase 4)

Signal routing is now centralized. The path from "AI generates content" to "user sees it" goes
through a single routing layer that reads workspace delivery preferences.

### Two routing paths

**IS-initiated signals** (Hub Protocol `/proactive/post`, automation outputs):

```
POST /api/hub/proactive/post
    └── routeSignal({ domain: "ai_insight", ... })   [packages/api/src/utils/delivery-router.ts]
           ├── deliverToFeed()    → proactive feed channel
           ├── deliverToChat()    → personal chat channel
           └── deliverToNotification() → NotificationService.create()
```

**Cron-initiated signals** (morning briefing, weekly digest, health check):

```
proactive-morning-briefing worker
    └── routeProactiveMessage({ ... })   [packages/jobs/src/utils/proactive-post.ts]
           ├── postToProactiveFeed()     → proactive feed channel + realtime emit
           ├── postToPersonalChat()      → personal chat channel + realtime emit
           └── postProactiveNotification() → notifications table (direct insert)
```

Both paths read `workspace.settings.deliveryPreferences` (same schema, same defaults).

### Signal domains

| Domain       | Default surface | Description                                   |
| ------------ | --------------- | --------------------------------------------- |
| `proactive`  | `feed`          | Cron-driven briefings, digests, health checks |
| `ai_insight` | `feed`          | IS agent-generated content via Hub Protocol   |
| `automation` | `feed`          | Automation channel_message output nodes       |
| `connector`  | `notification`  | Connector sync completion signals             |

### Surfaces

| Surface        | Behavior                                                |
| -------------- | ------------------------------------------------------- |
| `feed`         | Posts to proactive feed channel (channelPurpose='feed') |
| `chat`         | Posts to personal chat channel (channelPurpose='chat')  |
| `notification` | Creates notification row (bell icon)                    |
| `suppress`     | No-op — drops the signal entirely                       |

### Workspace settings schema

```typescript
// workspace.settings.deliveryPreferences
interface DeliveryPreferences {
  proactive?: { surfaces: SignalSurface[] };
  ai_insight?: { surfaces: SignalSurface[] };
  automation?: { surfaces: SignalSurface[] };
  connector?: { surfaces: SignalSurface[] };
}

type SignalSurface = "feed" | "chat" | "notification" | "suppress";
```

## What's wired (as of P4)

| Source                      | Event emitted | Automation-triggerable | Delivery-routed           |
| --------------------------- | ------------- | ---------------------- | ------------------------- |
| Entity create/update/delete | ✓             | ✓                      | —                         |
| Channel messages            | ✓             | ✓                      | —                         |
| Proposals                   | ✓             | ✓                      | —                         |
| Quick capture               | ✓             | ✓                      | —                         |
| Telegram/connector import   | ✓             | ✓                      | —                         |
| Proactive cron posts        | ✓             | ✓                      | ✓ (routeProactiveMessage) |
| IS proactive posts          | ✓             | ✓                      | ✓ (routeSignal)           |
| Notifications               | ✓             | —                      | —                         |

## Gaps (future work)

1. **IS event query tool** — `GET /api/hub/events` exists but IS has no `query_recent_events` tool yet.
   Endpoint: `GET /api/hub/events?types[]=capture.*&since=2h&limit=20`

2. **Automation executor channel_message** — the `channel_message` output node writes to an
   explicitly configured channel. It could optionally go through `routeSignal(domain="automation")`
   to respect delivery preferences, but user-configured explicit channels should remain as-is.

3. **External channel history** — when connectors sync messages (not just contacts), those could
   populate EXTERNAL_IMPORT channels linked to person entities. IS would then answer "what did
   Samir say last week?" from channel history, not just entity properties.
