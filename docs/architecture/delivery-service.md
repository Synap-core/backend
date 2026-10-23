# DeliveryService

> Verified against code on 2026-10-20 (backend@cc4b2d81).

`DeliveryService` (`packages/api/src/services/DeliveryService.ts`) is the one
code path that puts a message in front of a person: a post in their proactive
feed, a message in their personal chat channel, or a notification. Which
surfaces a given signal goes to is decided one level up, by the delivery router
(`routeSignal`, see [event-chain.md](event-chain.md#delivery-routing)); this
service performs the delivery.

## API

All methods are static and return a `DeliveryResult`.

| Method                            | Use                                                            |
| --------------------------------- | -------------------------------------------------------------- |
| `deliver(request)`                | deliver one content to one or more surfaces                    |
| `deliverToFeed(request)`          | shorthand for the feed surface                                 |
| `deliverToProactiveFeed(options)` | AI-initiated feed posts, with preference check and daily dedup |
| `deliverToChat(request)`          | shorthand for the chat surface                                 |
| `deliverToNotification(request)`  | shorthand for a notification (`notificationType` required)     |

`DeliveryRequest`: `userId`, optional `workspaceId`, `content`
(`title?`, `body`, `sourceType`: `ai_proactive` | `automation` | `user` |
`external` | `system`, `sourceId?`, `actions?`, `metadata?`), `surfaces`,
`priority?` (`low` | `normal` | `high` | `urgent`), `deduplicationKey?`,
`expiresAt?`, `enableRetry?` (default true), `retryOptions?`.

`DeliverySurface`:

| `type`         | Fields                                | Effect                                         |
| -------------- | ------------------------------------- | ---------------------------------------------- |
| `feed`         | `feedChannelId?`, `proactiveOptions?` | message in the person's proactive feed channel |
| `chat`         | `channelId?`                          | message in the personal chat channel           |
| `notification` | `notificationType`                    | notification row through `NotificationService` |
| `external`     | `platform`, `externalChannelId?`      | not implemented here: returns `success: false` |
| `email`        | none                                  | not implemented: returns `success: false`      |

External delivery (Discord, Telegram, ...) is done by the delivery router's
`external` surface, not by this service's `external` type.

`DeliveryResult`: `success` (true only if every surface succeeded), one entry
per surface (`surface`, `success`, `id?`, `error?`, `retries?`,
`circuitBreakerOpen?`), and `metrics` (`totalDurationMs`, `totalRetries`).
Callers inspect per-surface results; a partial failure is not thrown.

## Behaviour

- **Retries and circuit breakers.** Each surface write is retried with
  exponential backoff (`withRetryResult`, `API_RETRY_OPTIONS` from
  `@synap/shared-utils`) and guarded by a circuit breaker per surface type
  (`delivery-<surface>`).
- **Request dedup.** A `deduplicationKey` seen in the last 60 seconds makes the
  call a no-op that reports `id: "deduplicated"`. The window is in process
  memory, so it does not span API processes or restarts. Choose keys that
  describe the event (`proposal-created-<id>-<user>`), or include a time bucket
  for repeated signals.
- **Proactive feed** (`deliverToProactiveFeed`, `FeedDeliveryOptions`): when
  `checkPreferences` is on, a workspace whose proactive AI preferences are
  disabled or muted (`mutedUntil` in the future) receives nothing. With
  `deduplicate` (default on) only one message per `proactiveType`
  (`morning_briefing`, `weekly_digest`, `health_check`, `nudge`, `insight`,
  `suggestion`, `alert`) is posted per day; a second answers
  `already_sent_today`. It creates the feed channel if needed
  (`ensureProactiveFeedChannel`), emits `proactive.post.completed` when
  `emitEvents` is on, and can add a notification alongside.
- Feed and chat messages are broadcast to connected clients; notifications go
  through `NotificationService`, which persists and broadcasts them.

## Example

```ts
import { DeliveryService } from "../services/DeliveryService.js";

const result = await DeliveryService.deliver({
  userId,
  workspaceId,
  content: {
    title: "Proposal waiting",
    body: "An agent proposed a change to Project Alpha.",
    sourceType: "system",
    sourceId: proposalId,
  },
  surfaces: [
    { type: "notification", notificationType: "proposal.created" },
    { type: "feed" },
  ],
  deduplicationKey: `proposal-created-${proposalId}-${userId}`,
});
for (const d of result.deliveries) {
  if (!d.success) logger.warn({ surface: d.surface, error: d.error });
}
```

## Rules

- Do not insert into `messages` to post to a feed or chat; use this service.
- Cron jobs in `@synap/jobs` cannot import `@synap/api`; they use
  `routeProactiveMessage()` (`packages/jobs/src/utils/proactive-post.ts`).
- `packages/api/src/utils/proactive-channel-post.ts` is a deprecated re-export
  kept for old imports; `postProactiveMessage()` became
  `DeliveryService.deliverToProactiveFeed()`.
