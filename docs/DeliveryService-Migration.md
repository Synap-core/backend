# DeliveryService Migration Guide

> Migrating from legacy delivery patterns to the unified DeliveryService API.

---

## Overview

This guide helps you migrate from legacy delivery patterns to `DeliveryService`. The new service consolidates multiple older APIs into one consistent interface.

**What it replaces:**

- `postProactiveMessage()` (API package)
- Direct `NotificationService.create()` calls (simple cases)
- Custom feed posting code
- Ad-hoc message insertion

---

## Migration Cheat Sheet

| Old Pattern                                        | New Pattern                                                                        |
| -------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `postProactiveMessage({ content, proactiveType })` | `DeliveryService.deliverToFeed({ content: { body, sourceType: "ai_proactive" } })` |
| `NotificationService.create({ type, data })`       | `DeliveryService.deliverToNotification({ notificationType, content })`             |
| `db.insert(messages).values({ ... })`              | `DeliveryService.deliver({ surfaces: [{ type: "feed" }] })`                        |

---

## Detailed Migrations

### 1. Migrating from `postProactiveMessage()`

**File:** `packages/api/src/utils/proactive-channel-post.ts`

**Before:**

```typescript
import { postProactiveMessage } from "@synap/api/utils/proactive-channel-post";

async function sendInsight(
  userId: string,
  workspaceId: string,
  content: string
) {
  const result = await postProactiveMessage({
    userId,
    workspaceId,
    content,
    proactiveType: "insight",
    metadata: { insightId: "123" },
  });

  if (result.posted) {
    console.log("Posted to feed:", result.messageId);
  }
}
```

**After:**

```typescript
import { DeliveryService } from "@synap/api/services";

async function sendInsight(
  userId: string,
  workspaceId: string,
  content: string
) {
  const result = await DeliveryService.deliverToFeed({
    userId,
    workspaceId,
    content: {
      body: content,
      sourceType: "ai_proactive",
      sourceId: "insight-123",
      metadata: { insightId: "123" },
    },
  });

  if (result.success) {
    const feedDelivery = result.deliveries.find((d) => d.surface === "feed");
    console.log("Posted to feed:", feedDelivery?.id);
  }
}
```

**Key Changes:**

- Import from `@synap/api/services` instead of utils
- `proactiveType` → `sourceId` in metadata
- `result.posted` → `result.success`
- `result.messageId` → `result.deliveries[0].id`

---

### 2. Migrating from `NotificationService.create()`

**File:** `packages/api/src/notifications/NotificationService.ts`

**Before:**

```typescript
import { NotificationService } from "@synap/api/notifications";

async function notifyProposalCreated(
  userId: string,
  workspaceId: string,
  proposalId: string,
  proposalType: string
) {
  await NotificationService.create({
    type: "proposal.created",
    workspaceId,
    userId,
    sourceType: "proposal",
    sourceId: proposalId,
    data: {
      proposalType,
      description: `New ${proposalType} proposal`,
    },
  });
}
```

**After:**

```typescript
import { DeliveryService } from "@synap/api/services";

async function notifyProposalCreated(
  userId: string,
  workspaceId: string,
  proposalId: string,
  proposalType: string
) {
  await DeliveryService.deliverToNotification({
    userId,
    workspaceId,
    notificationType: "proposal.created",
    content: {
      title: "New Proposal",
      body: `New ${proposalType} proposal created`,
      sourceType: "proposal",
      sourceId: proposalId,
    },
  });
}
```

**When to keep using `NotificationService.create()`:**

- Complex data objects in `data` field
- Custom grouping keys
- Specific expiration times
- When you need the notification ID for later reference

---

### 3. Migrating from Direct Message Insertion

**Before:**

```typescript
import { db, messages } from "@synap/database";
import { MessageRole, MessageAuthorType, MessageCategory } from "@synap/database/schema";

async function postToFeed(userId: string, content: string) {
  const channel = await getFeedChannel(userId);

  await db.insert(messages).values({
    id: crypto.randomUUID(),
    channelId: channel.id,
    content,
    role: MessageRole.SYSTEM,
    authorType: MessageAuthorType.BOT,
    messageCategory: MessageCategory.SYSTEM_NOTIFICATION,
    userId,
    metadata: { sourceType: "system" }
  });

  // Don't forget to emit socket event!
  emitChatEvent({ ... });
}
```

**After:**

```typescript
import { DeliveryService } from "@synap/api/services";

async function postToFeed(userId: string, content: string) {
  await DeliveryService.deliverToFeed({
    userId,
    content: {
      body: content,
      sourceType: "system",
    },
  });
  // Socket event, side effects, and event log are handled automatically
}
```

**Benefits:**

- Less boilerplate
- Automatic side effects
- Consistent error handling
- Deduplication support

---

### 4. Migrating from Custom Multi-Surface Code

**Before:**

```typescript
async function notifyUser(userId: string, message: string) {
  // Post to feed
  await postProactiveMessage({
    userId,
    workspaceId,
    content: message,
    proactiveType: "alert",
  });

  // Also send notification
  await NotificationService.create({
    type: "custom.alert",
    workspaceId,
    userId,
    sourceType: "system",
    data: { message },
  });

  // Also post to chat
  await postToChat(userId, message);
}
```

**After:**

```typescript
async function notifyUser(userId: string, message: string) {
  await DeliveryService.deliver({
    userId,
    workspaceId,
    content: {
      title: "Alert",
      body: message,
      sourceType: "system",
    },
    surfaces: [
      { type: "feed" },
      { type: "notification", notificationType: "custom.alert" },
      { type: "chat" },
    ],
  });
}
```

**Benefits:**

- Single API call
- Atomic result checking
- Concurrent delivery
- Consistent metadata

---

## Jobs Package: No Changes Needed

The jobs package maintains its own routing via `routeProactiveMessage()` to avoid circular dependencies with the API package.

**Keep using:**

```typescript
import { routeProactiveMessage } from "@synap/jobs/utils/proactive-post";

// This is the CORRECT way for cron workers
await routeProactiveMessage({
  userId,
  workspaceId,
  content: "Morning briefing",
  proactiveType: "morning_briefing",
});
```

Do NOT try to import `DeliveryService` into jobs package code — it will cause circular dependency errors.

---

## Migration Checklist

- [ ] Identify all uses of `postProactiveMessage()`
- [ ] Identify all simple `NotificationService.create()` calls
- [ ] Identify all direct `db.insert(messages)` calls
- [ ] Replace with appropriate `DeliveryService` methods
- [ ] Update result handling (`posted` → `success`, `messageId` → `deliveries[].id`)
- [ ] Test deliveries in development
- [ ] Verify event log entries are created
- [ ] Update unit tests

---

## Testing After Migration

### Verify Feed Delivery

```typescript
const result = await DeliveryService.deliverToFeed({ ... });
expect(result.success).toBe(true);
expect(result.deliveries[0].surface).toBe("feed");
```

### Verify Notification Delivery

```typescript
const result = await DeliveryService.deliverToNotification({ ... });
expect(result.success).toBe(true);

// Check database
const notification = await db.query.notifications.findFirst({
  where: eq(notifications.id, result.deliveries[0].id)
});
expect(notification).toBeDefined();
```

### Verify Event Log

```sql
-- Check that events were created
SELECT * FROM events
WHERE type IN ('message.created', 'notification.created')
  AND timestamp > NOW() - INTERVAL '1 minute';
```

---

## Common Migration Issues

### Issue: "Cannot find module '@synap/api/services'"

**Solution:** Make sure you're importing from the correct path:

```typescript
// Correct
import { DeliveryService } from "@synap/api/services";

// If that doesn't work, use direct path
import { DeliveryService } from "../services/DeliveryService.js";
```

### Issue: Missing `sourceType`

**Error:** TypeScript error about missing `sourceType`

**Solution:** Add `sourceType` to content:

```typescript
content: {
  body: "...",
  sourceType: "system" // Required!
}
```

### Issue: Result checking fails

**Old code:**

```typescript
if (result.posted) { ... }  // Doesn't work anymore
```

**New code:**

```typescript
if (result.success) { ... }  // Correct
```

---

## Deprecated APIs

These APIs are deprecated but still functional:

| API                            | Status      | Replacement                                              |
| ------------------------------ | ----------- | -------------------------------------------------------- |
| `postProactiveMessage()`       | Deprecated  | `DeliveryService.deliverToFeed()`                        |
| `NotificationService.create()` | Still valid | `DeliveryService.deliverToNotification()` (simple cases) |

---

## Support

Having trouble migrating?

1. Check the [full API docs](./DeliveryService.md)
2. Review [quick start guide](./DeliveryService-QuickStart.md)
3. Ask in #dev-backend Slack channel
