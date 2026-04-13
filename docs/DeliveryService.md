# DeliveryService API Documentation

> **Version:** 1.0.0  
> **Last Updated:** 2026-04-12  
> **Location:** `packages/api/src/services/DeliveryService.ts`

---

## Table of Contents

1. [Overview](#1-overview)
2. [API Reference](#2-api-reference)
3. [Types](#3-types)
4. [Usage Examples](#4-usage-examples)
5. [Surfaces](#5-surfaces)
6. [Best Practices](#6-best-practices)
7. [Integration Guide](#7-integration-guide)
8. [Troubleshooting](#8-troubleshooting)

---

## 1. Overview

### What is DeliveryService?

**DeliveryService** is a unified service for delivering messages to users across all communication surfaces in Synap. It consolidates multiple legacy delivery patterns into a single, consistent API.

**Consolidates:**

- Proactive channel posting (AI briefings, insights)
- Automation output delivery
- Cross-channel notifications
- Feed posting
- Direct notification creation

### When to Use DeliveryService

| Use Case                                 | Service to Use                                          |
| ---------------------------------------- | ------------------------------------------------------- |
| AI wants to post a proactive insight     | `DeliveryService.deliver()` with `feed` surface         |
| Automation needs to notify a user        | `DeliveryService.deliver()` with `notification` surface |
| System needs to send multi-surface alert | `DeliveryService.deliver()` with multiple surfaces      |
| Posting to personal chat channel         | `DeliveryService.deliver()` with `chat` surface         |
| Simple notification (bell icon)          | `DeliveryService.deliverToNotification()`               |
| Cron-driven proactive message            | `routeProactiveMessage()` in jobs package               |

### Relationship to Event Chain

```
DeliveryService.deliver()
        │
        ├──► deliverToFeed() ────────► messages table ───────► Socket.IO emit
        │                                    │
        │                                    └──► "message.created" event
        │
        ├──► deliverToChat() ────────► messages table ───────► Socket.IO emit
        │                                    │
        │                                    └──► "message.created" event
        │
        └──► deliverToNotification() ─► NotificationService.create()
                                                │
                                                ├──► notifications table
                                                ├──► Socket.IO emit
                                                └──► "notification.created" event
```

Every successful delivery triggers side effects and event log entries for audit trails and cross-pod sync.

---

## 2. API Reference

### `DeliveryService.deliver(request)`

Main delivery method. Routes content to one or more surfaces concurrently.

```typescript
static async deliver(request: DeliveryRequest): Promise<DeliveryResult>
```

**Parameters:**

- `request` (`DeliveryRequest`): The delivery request containing content, surfaces, and options

**Returns:**

- `Promise<DeliveryResult>`: Result object with per-surface delivery status

**Example:**

```typescript
import { DeliveryService } from "@synap/api/services";

const result = await DeliveryService.deliver({
  userId: "user-123",
  workspaceId: "ws-456",
  content: {
    title: "Task Due Soon",
    body: "Your task 'Review Q4 Report' is due tomorrow.",
    sourceType: "system",
    actions: [
      {
        label: "View Task",
        action: "navigate",
        data: { entityId: "task-789" },
      },
    ],
  },
  surfaces: [
    { type: "notification", notificationType: "task.due_soon" },
    { type: "feed" },
  ],
  priority: "high",
  deduplicationKey: "task-due-task-789-user-123",
});
```

---

### `DeliveryService.deliverToFeed(request)`

Convenience method for single feed delivery.

```typescript
static async deliverToFeed(
  request: Omit<DeliveryRequest, 'surfaces'> & { feedChannelId?: string }
): Promise<DeliveryResult>
```

**Parameters:**

- `request`: Delivery request without `surfaces`, optionally with specific `feedChannelId`

**Example:**

```typescript
const result = await DeliveryService.deliverToFeed({
  userId: "user-123",
  workspaceId: "ws-456",
  content: {
    body: "Daily briefing ready",
    sourceType: "ai_proactive",
    sourceId: "morning-briefing-001",
  },
  // Automatically uses feed surface
});
```

---

### `DeliveryService.deliverToNotification(request)`

Convenience method for single notification delivery.

```typescript
static async deliverToNotification(
  request: Omit<DeliveryRequest, 'surfaces'> & { notificationType: string }
): Promise<DeliveryResult>
```

**Parameters:**

- `request`: Delivery request without `surfaces`, with required `notificationType`

**Example:**

```typescript
const result = await DeliveryService.deliverToNotification({
  userId: "user-123",
  workspaceId: "ws-456",
  notificationType: "proposal.created",
  content: {
    title: "New Proposal",
    body: "AI Agent created a proposal to create entity 'Project Alpha'",
    sourceType: "agent",
    sourceId: "proposal-789",
  },
  priority: "normal",
});
```

---

## 3. Types

### `DeliveryRequest`

Main input type for delivery operations.

```typescript
interface DeliveryRequest {
  /** Target user ID (required) */
  userId: string;

  /** Target workspace ID (optional - some deliveries are pod-wide) */
  workspaceId?: string;

  /** Content to deliver */
  content: DeliveryContent;

  /** Target surfaces for delivery */
  surfaces: DeliverySurface[];

  /** Delivery priority (affects notification urgency) */
  priority?: "low" | "normal" | "high" | "urgent";

  /** Key for deduplication (optional) */
  deduplicationKey?: string;

  /** Expiration time for time-sensitive deliveries */
  expiresAt?: Date;
}
```

---

### `DeliveryContent`

Content payload for delivery.

```typescript
interface DeliveryContent {
  /** Optional title (used by notifications, feed items) */
  title?: string;

  /** Main content body (required) */
  body: string;

  /** Source of the content (for tracking/auditing) */
  sourceType: "ai_proactive" | "automation" | "user" | "external" | "system";

  /** Optional source identifier */
  sourceId?: string;

  /** Optional action buttons */
  actions?: Array<{
    label: string;
    action: string;
    data?: Record<string, unknown>;
  }>;

  /** Additional metadata */
  metadata?: Record<string, unknown>;
}
```

**Example:**

```typescript
const content: DeliveryContent = {
  title: "Meeting Starting Soon",
  body: "Your meeting with Engineering Team starts in 15 minutes.",
  sourceType: "system",
  sourceId: "event-cal-123",
  actions: [
    {
      label: "Join Meeting",
      action: "open_url",
      data: { url: "https://meet.example.com/abc123" },
    },
    {
      label: "Snooze 10m",
      action: "snooze",
      data: { duration: 600 },
    },
  ],
  metadata: {
    eventId: "cal-123",
    calendarProvider: "google",
  },
};
```

---

### `DeliverySurface`

Discriminated union of all supported delivery surfaces.

```typescript
type DeliverySurface =
  | { type: "feed"; feedChannelId?: string }
  | { type: "chat"; channelId?: string }
  | { type: "notification"; notificationType: string }
  | { type: "external"; platform: string; externalChannelId?: string }
  | { type: "email" };
```

| Surface Type   | Required Fields                                   | Description                                                                  |
| -------------- | ------------------------------------------------- | ---------------------------------------------------------------------------- |
| `feed`         | — (optional: `feedChannelId`)                     | Posts to user's proactive feed channel                                       |
| `chat`         | — (optional: `channelId`)                         | Posts to user's personal chat channel                                        |
| `notification` | `notificationType` (string)                       | Creates notification entry                                                   |
| `external`     | `platform` (string), optional `externalChannelId` | Routes to external platform (Slack, Discord, etc.) — **Not yet implemented** |
| `email`        | —                                                 | Sends email — **Not yet implemented**                                        |

---

### `DeliveryResult`

Result type returned by all delivery methods.

```typescript
interface DeliveryResult {
  /** True if ALL surface deliveries succeeded */
  success: boolean;

  /** Per-surface delivery results */
  deliveries: Array<{
    surface: DeliverySurface["type"];
    success: boolean;
    id?: string; // Message ID or Notification ID
    error?: string; // Error message if failed
  }>;
}
```

**Example:**

```typescript
const result: DeliveryResult = {
  success: true,
  deliveries: [
    { surface: "feed", success: true, id: "msg-abc-123" },
    { surface: "notification", success: true, id: "notif-xyz-456" },
  ],
};
```

---

## 4. Usage Examples

### Basic Delivery to Single Surface

```typescript
import { DeliveryService } from "@synap/api/services";

// Simple feed post
await DeliveryService.deliver({
  userId: user.id,
  workspaceId: workspace.id,
  content: {
    body: "Welcome to your new workspace!",
    sourceType: "system",
  },
  surfaces: [{ type: "feed" }],
});
```

### Multi-Surface Delivery

```typescript
// Send to both feed and notification
const result = await DeliveryService.deliver({
  userId: user.id,
  workspaceId: workspace.id,
  content: {
    title: "Important Update",
    body: "Your workspace settings have been updated.",
    sourceType: "system",
    actions: [
      {
        label: "View Settings",
        action: "navigate",
        data: { path: "/settings" },
      },
    ],
  },
  surfaces: [
    { type: "feed" },
    { type: "notification", notificationType: "system.settings_updated" },
  ],
  priority: "high",
});

// Check results
for (const delivery of result.deliveries) {
  if (!delivery.success) {
    console.error(`Failed to deliver to ${delivery.surface}:`, delivery.error);
  }
}
```

### With Deduplication

```typescript
// Prevent duplicate deliveries within 60-second window
await DeliveryService.deliver({
  userId: user.id,
  workspaceId: workspace.id,
  content: {
    title: "Sync Complete",
    body: "Google Calendar sync completed successfully.",
    sourceType: "connector",
  },
  surfaces: [
    { type: "notification", notificationType: "connector.sync_complete" },
  ],
  deduplicationKey: `sync-complete-${user.id}-${connector.id}-${(Date.now() / 60000) | 0}`,
});
```

### With Priority

```typescript
// Urgent alert - will show with higher priority in notification center
await DeliveryService.deliver({
  userId: user.id,
  workspaceId: workspace.id,
  content: {
    title: "⚠️ Security Alert",
    body: "New login detected from unfamiliar location.",
    sourceType: "system",
  },
  surfaces: [
    { type: "notification", notificationType: "security.new_login" },
    { type: "chat" },
  ],
  priority: "urgent",
});
```

### Error Handling

```typescript
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "my-feature" });

async function notifyUser(
  userId: string,
  workspaceId: string,
  message: string
) {
  try {
    const result = await DeliveryService.deliver({
      userId,
      workspaceId,
      content: {
        body: message,
        sourceType: "automation",
      },
      surfaces: [
        { type: "notification", notificationType: "automation.notification" },
      ],
    });

    if (!result.success) {
      // Some surfaces failed
      const failures = result.deliveries.filter((d) => !d.success);
      logger.warn({ failures }, "Partial delivery failure");

      // Retry failed surfaces or alert ops
      for (const failure of failures) {
        await alertOpsTeam(
          `Delivery to ${failure.surface} failed: ${failure.error}`
        );
      }
    }

    return result;
  } catch (error) {
    // This shouldn't happen (DeliveryService never throws), but handle defensively
    logger.error({ error, userId }, "Unexpected delivery error");
    throw error;
  }
}
```

---

## 5. Surfaces

### Feed Surface

**When to Use:**

- Proactive AI content (briefings, insights, suggestions)
- System announcements
- Activity summaries
- Non-urgent updates the user should see when they check their feed

**Behavior:**

- Posts to the user's proactive feed channel (`channelType: 'feed'`)
- Creates a `MessageRole.SYSTEM` message
- Emits `chat:message` via Socket.IO for real-time updates
- Fires `proactive.post.completed` event
- Deduplication: One message per `proactiveType` per day (handled by underlying `postProactiveMessage`)

**Best For:** Content that should be visible in the user's feed/stream but doesn't need immediate attention.

```typescript
{ type: "feed", feedChannelId?: string }
```

If `feedChannelId` is not provided, the service finds or creates the user's default feed channel.

---

### Chat Surface

**When to Use:**

- Direct AI responses
- Conversation-style interactions
- Personal assistant messages
- Content that should appear in the user's main chat

**Behavior:**

- Posts to the user's personal chat channel (`channelType: 'personal'`)
- Creates a `MessageRole.ASSISTANT` message
- Emits `chat:message` via Socket.IO for real-time updates
- No per-day deduplication (chat is a conversation surface)

**Best For:** Interactive, conversational content that should appear alongside other chat messages.

```typescript
{ type: "chat", channelId?: string }
```

If `channelId` is not provided, the service finds or creates the user's personal channel.

---

### Notification Surface

**When to Use:**

- Action-required alerts
- Time-sensitive updates
- User attention needed
- Events that should appear in the notification bell

**Behavior:**

- Creates a notification row via `NotificationService.create()`
- Emits `notification:new` via Socket.IO
- Persists to `notifications` table
- Fires `notification.created` event
- Respects user notification preferences (quiet hours, muting, routing rules)
- Uses notification registry for templates, icons, actions

**Best For:** Urgent content that requires user attention or action.

```typescript
{ type: "notification", notificationType: string }
```

The `notificationType` must be registered in the notification registry (see `packages/api/src/notifications/registry.ts`).

---

### External Surface

**When to Use:**

- Cross-posting to Slack
- Discord notifications
- Webhook deliveries
- Third-party integrations

**Behavior:**

- **Not yet implemented** — currently returns `{ success: false, error: "external delivery not yet implemented" }`

**Future Implementation:**
Will route to external platforms via connectors or webhooks.

```typescript
{ type: "external", platform: string; externalChannelId?: string }
```

---

### Email Surface

**When to Use:**

- Offline notifications
- Digest summaries
- Important account updates
- When user is not actively using the app

**Behavior:**

- **Not yet implemented** — currently returns `{ success: false, error: "email delivery not yet implemented" }`

**Future Implementation:**
Will queue emails for delivery via email service provider.

```typescript
{
  type: "email";
}
```

---

## 6. Best Practices

### When to Use Which Surface

| Scenario                  | Recommended Surface(s)   | Priority |
| ------------------------- | ------------------------ | -------- |
| AI daily briefing         | `feed`                   | `normal` |
| AI insight/suggestion     | `feed`                   | `normal` |
| Task due reminder         | `notification`           | `high`   |
| Meeting starting soon     | `notification` + `chat`  | `high`   |
| Proposal created          | `notification`           | `normal` |
| Proposal approved         | `notification`           | `normal` |
| System maintenance notice | `feed`                   | `normal` |
| Security alert            | `notification` + `chat`  | `urgent` |
| Connector sync complete   | `notification`           | `low`    |
| Automation completed      | `notification` or `feed` | `normal` |

### Deduplication Strategies

**Time-based deduplication (60-second window):**

```typescript
deduplicationKey: `${eventType}-${userId}-${entityId}-${Math.floor(Date.now() / 60000)}`;
```

**Event-based deduplication:**

```typescript
// Prevent duplicate notifications for same event
deduplicationKey: `proposal-created-${proposalId}-${userId}`;
```

**Daily deduplication (cron jobs):**

```typescript
// Jobs package handles this automatically via postProactiveMessage
deduplicationKey: `morning-briefing-${userId}-${new Date().toDateString()}`;
```

### Error Handling Patterns

**DeliveryService is non-fatal — it never throws.** Always check `result.success`:

```typescript
const result = await DeliveryService.deliver({ ... });

if (!result.success) {
  // Handle partial failures
  const failed = result.deliveries.filter(d => !d.success);
  for (const failure of failed) {
    logger.warn(`Failed to deliver to ${failure.surface}: ${failure.error}`);
  }
}
```

**For critical deliveries, consider fallback:**

```typescript
async function criticalNotify(userId: string, message: string) {
  // Try notification first
  let result = await DeliveryService.deliverToNotification({ ... });

  // Fallback to feed if notification fails
  if (!result.success) {
    result = await DeliveryService.deliverToFeed({ ... });
  }

  return result;
}
```

### Performance Considerations

1. **Batch multi-surface deliveries:** Use a single `deliver()` call with multiple surfaces instead of multiple individual calls
2. **Use deduplication keys:** Prevents unnecessary DB writes and event emissions
3. **Set appropriate priorities:** Helps notification service prioritize high-urgency items
4. **Don't await side effects:** DeliveryService handles side effects fire-and-forget

---

## 7. Integration Guide

### How to Integrate with Existing Code

**Step 1: Import the service**

```typescript
import { DeliveryService } from "@synap/api/services";
```

**Step 2: Identify your use case**

- Are you posting proactive AI content? → Use `feed` surface
- Are you sending a notification? → Use `notification` surface
- Are you responding in chat? → Use `chat` surface

**Step 3: Build your DeliveryRequest**

```typescript
const request: DeliveryRequest = {
  userId: targetUserId,
  workspaceId: currentWorkspaceId,
  content: {
    title: "Your Title",
    body: "Your message content",
    sourceType: "automation", // or "system", "ai_proactive", etc.
    actions: optionalActionButtons,
  },
  surfaces: [{ type: "notification", notificationType: "your.type.here" }],
  priority: "normal",
};
```

**Step 4: Call deliver and handle results**

```typescript
const result = await DeliveryService.deliver(request);

if (result.success) {
  console.log(
    "Delivered successfully to",
    result.deliveries.map((d) => d.surface)
  );
} else {
  console.error(
    "Some surfaces failed:",
    result.deliveries.filter((d) => !d.success)
  );
}
```

### Migration from Old Patterns

#### From `postProactiveMessage()` (API package)

**Before:**

```typescript
import { postProactiveMessage } from "@synap/api/utils/proactive-channel-post";

await postProactiveMessage({
  userId,
  workspaceId,
  content: "Your message",
  proactiveType: "insight",
});
```

**After:**

```typescript
import { DeliveryService } from "@synap/api/services";

await DeliveryService.deliverToFeed({
  userId,
  workspaceId,
  content: {
    body: "Your message",
    sourceType: "ai_proactive",
    sourceId: "insight-001",
  },
});
```

#### From `NotificationService.create()` (direct calls)

**Before:**

```typescript
import { NotificationService } from "@synap/api/notifications";

await NotificationService.create({
  type: "proposal.created",
  workspaceId,
  userId,
  sourceType: "proposal",
  sourceId: proposalId,
  data: { proposalType: "entity.create", description: "..." },
});
```

**After:**

```typescript
import { DeliveryService } from "@synap/api/services";

await DeliveryService.deliverToNotification({
  userId,
  workspaceId,
  notificationType: "proposal.created",
  content: {
    title: "New Proposal",
    body: "AI created a proposal",
    sourceType: "agent",
    sourceId: proposalId,
  },
});
```

**Note:** Direct `NotificationService.create()` calls are still valid and preferred for complex notification scenarios (custom data objects, grouping, etc.).

#### From Jobs Package `routeProactiveMessage()`

**No migration needed.** The jobs package maintains its own routing logic to avoid circular dependencies. Continue using:

```typescript
import { routeProactiveMessage } from "@synap/jobs/utils/proactive-post";
```

For cron workers, this is the correct path.

### Testing Deliveries

**Unit Test Example:**

```typescript
import { describe, it, expect, vi } from "vitest";
import { DeliveryService } from "@synap/api/services";

// Mock the database and socket modules
vi.mock("@synap/database", () => ({
  db: {
    query: { channels: { findFirst: vi.fn() } },
    insert: vi.fn(() => ({ returning: vi.fn(() => [{ id: "msg-123" }]) })),
  },
}));

describe("DeliveryService", () => {
  it("should deliver to feed surface", async () => {
    const result = await DeliveryService.deliver({
      userId: "user-123",
      workspaceId: "ws-456",
      content: {
        body: "Test message",
        sourceType: "system",
      },
      surfaces: [{ type: "feed" }],
    });

    expect(result.success).toBe(true);
    expect(result.deliveries).toHaveLength(1);
    expect(result.deliveries[0].surface).toBe("feed");
    expect(result.deliveries[0].id).toBe("msg-123");
  });
});
```

**Integration Test Example:**

```typescript
// Test actual delivery to test database
import { testDb } from "@synap/test-utils";

it("should create notification record", async () => {
  const result = await DeliveryService.deliverToNotification({
    userId: testUser.id,
    workspaceId: testWorkspace.id,
    notificationType: "test.notification",
    content: {
      title: "Test",
      body: "Test body",
      sourceType: "system",
    },
  });

  expect(result.success).toBe(true);

  // Verify in database
  const notification = await testDb.query.notifications.findFirst({
    where: eq(notifications.id, result.deliveries[0].id),
  });

  expect(notification).toBeDefined();
  expect(notification.title).toBe("Test");
});
```

---

## 8. Troubleshooting

### Common Issues

#### "No feed channel found for user"

**Cause:** User doesn't have a feed channel, and auto-creation failed.

**Solution:**

```typescript
// Ensure user has channels before delivery
import { ensureProactiveFeedChannel } from "@synap/api/utils/personal-channel";

await ensureProactiveFeedChannel(userId, workspaceId);
await DeliveryService.deliverToFeed({ ... });
```

#### Deduplication not working

**Cause:** Deduplication key not unique enough or window expired.

**Check:**

- Key should include user ID, entity ID, and time bucket
- Default window is 60 seconds (`DEDUP_WINDOW_MS = 60000`)

#### Notification not showing in UI

**Checklist:**

1. Verify `notificationType` is registered in registry
2. Check user notification preferences (may be muted)
3. Check quiet hours settings
4. Verify Socket.IO connection is active
5. Check browser console for `notification:new` event

#### "email delivery not yet implemented"

**This is expected.** Email surface is planned but not yet implemented. Use `notification` surface for now.

### Debug Techniques

**Enable verbose logging:**

```typescript
// Set in environment
LOG_LEVEL = debug;

// Or programmatically
import { createLogger } from "@synap-core/core";
const logger = createLogger({ module: "delivery-service", level: "debug" });
```

**Check delivery result:**

```typescript
const result = await DeliveryService.deliver({ ... });
console.log(JSON.stringify(result, null, 2));
// {
//   "success": true,
//   "deliveries": [
//     { "surface": "feed", "success": true, "id": "msg-abc" },
//     { "surface": "notification", "success": true, "id": "notif-xyz" }
//   ]
// }
```

**Trace through event log:**

```sql
-- Check recent deliveries
SELECT * FROM events
WHERE type IN ('message.created', 'notification.created')
  AND data->>'userId' = 'your-user-id'
ORDER BY timestamp DESC
LIMIT 10;
```

### FAQ

**Q: Can I deliver to multiple users at once?**

A: No, DeliveryService is designed for single-user delivery. For bulk delivery, loop over users:

```typescript
await Promise.all(
  users.map(user =>
    DeliveryService.deliver({ userId: user.id, ... })
  )
);
```

**Q: What's the difference between `feed` and `chat` surfaces?**

A: Feed is for proactive, broadcast-style content (briefings, insights). Chat is for conversational, interactive content. Feed posts are SYSTEM role; Chat posts are ASSISTANT role.

**Q: How do I customize notification appearance?**

A: Register your notification type in `packages/api/src/notifications/registry.ts` with custom templates, icons, and actions.

**Q: Can I send to external platforms like Slack?**

A: Not yet. The `external` surface type is defined but not implemented. Use webhooks or connectors for now.

**Q: Does DeliveryService respect user preferences?**

A: The `notification` surface respects notification preferences (muting, quiet hours, routing rules). Feed and chat surfaces respect proactive AI preferences (`workspace.settings.proactiveAi`).

**Q: What happens if one surface fails?**

A: Other surfaces continue. `result.success` is false if ANY surface failed, but successful surfaces remain successful.

---

## Related Documentation

- [Event Chain & Signal Routing](./EVENT-CHAIN.md) — Understanding the event system
- [Notification System](./architecture/NOTIFICATION_SYSTEM.md) — Deep dive into notifications
- [Channel System](./CHANNEL-SYSTEM.md) — Understanding channels

## See Also

- `packages/api/src/services/DeliveryService.ts` — Service implementation
- `packages/api/src/utils/delivery-router.ts` — Signal routing for AI content
- `packages/api/src/notifications/NotificationService.ts` — Notification service
- `packages/jobs/src/utils/proactive-post.ts` — Jobs package routing
