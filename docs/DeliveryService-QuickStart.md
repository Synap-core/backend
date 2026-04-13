# DeliveryService Quick Start Guide

> Get up and running with DeliveryService in 5 minutes.

---

## Installation

DeliveryService is part of `@synap/api`. No additional installation needed.

```typescript
import { DeliveryService } from "@synap/api/services";
```

---

## Hello World

Send your first delivery:

```typescript
import { DeliveryService } from "@synap/api/services";

// Send a simple notification
await DeliveryService.deliverToNotification({
  userId: "user-123",
  workspaceId: "ws-456",
  notificationType: "welcome.message",
  content: {
    title: "Welcome!",
    body: "Thanks for joining Synap.",
    sourceType: "system",
  },
});
```

---

## Common Patterns

### 1. Notify User of Action

```typescript
await DeliveryService.deliverToNotification({
  userId,
  workspaceId,
  notificationType: "entity.created",
  content: {
    title: "Entity Created",
    body: `Created entity "${entityName}"`,
    sourceType: "system",
    sourceId: entityId,
  },
});
```

### 2. Post to Feed

```typescript
await DeliveryService.deliverToFeed({
  userId,
  workspaceId,
  content: {
    body: "Daily briefing is ready",
    sourceType: "ai_proactive",
  },
});
```

### 3. Multi-Surface Alert

```typescript
await DeliveryService.deliver({
  userId,
  workspaceId,
  content: {
    title: "Meeting Soon",
    body: "Your meeting starts in 5 minutes",
    sourceType: "system",
  },
  surfaces: [
    { type: "notification", notificationType: "meeting.reminder" },
    { type: "chat" },
  ],
  priority: "high",
});
```

### 4. With Action Buttons

```typescript
await DeliveryService.deliverToNotification({
  userId,
  workspaceId,
  notificationType: "proposal.created",
  content: {
    title: "New Proposal",
    body: "AI wants to create a task",
    sourceType: "agent",
    actions: [
      { label: "Review", action: "navigate", data: { proposalId } },
      { label: "Dismiss", action: "dismiss", data: { proposalId } },
    ],
  },
});
```

---

## Choosing the Right Surface

| If you want to...         | Use Surface    | Method                        |
| ------------------------- | -------------- | ----------------------------- |
| Show in notification bell | `notification` | `deliverToNotification()`     |
| Post to activity feed     | `feed`         | `deliverToFeed()`             |
| Send to chat              | `chat`         | `deliver()` with chat surface |
| Send to multiple places   | Multiple       | `deliver()` with array        |

---

## Adding Deduplication

Prevent duplicate deliveries:

```typescript
await DeliveryService.deliver({
  userId,
  workspaceId,
  content: { ... },
  surfaces: [...],
  deduplicationKey: `my-event-${userId}-${entityId}`
});
```

**Key format:** Make it unique per event + user + (optional) time bucket.

---

## Handling Results

Always check if delivery succeeded:

```typescript
const result = await DeliveryService.deliver({ ... });

if (result.success) {
  console.log("Delivered to:", result.deliveries.map(d => d.surface));
} else {
  console.error("Failed:", result.deliveries.filter(d => !d.success));
}
```

---

## Next Steps

- Read the [full API documentation](./DeliveryService.md)
- Learn about [migration from old patterns](./DeliveryService-Migration.md)
- Check [best practices](./DeliveryService.md#6-best-practices)
