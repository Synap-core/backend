# Event chain and signal routing

> Verified against code on 2026-10-20 (backend@cc4b2d81). Migrated from Synap's
> internal team docs on 2026-10-20. The realtime naming section of the original page now
> lives in [realtime.md](realtime.md) and
> [../decisions/realtime-event-naming.md](../decisions/realtime-event-naming.md).

Every state change in a pod reaches two places: the `events` table (the
append-only audit chain) and a set of pg-boss jobs that react to it. Proposals
are review states inside that same chain. This page covers the chain, the
automation-triggerable event types, and how AI and automation output is routed
to a surface.

## The two halves

```
mutation
  ├─ auditLog(...)            → events table: {subjectType}.{action}.{phase}
  └─ emitSideEffects(...)     → registered reactors, each a pg-boss job:
        search-index            Typesense
        entity embedding        vector index (skipped where vector search is off)
        webhook-delivery        outbound webhooks
        cross-thread-notify     cross-thread notifications
        automation-trigger-match  automations react
        ...
```

- `auditLog()` (`packages/api/src/utils/audit-log.ts`) writes an event row;
  repositories that extend `BaseRepository` write the `.completed` event
  themselves (`emitCompleted`, `packages/database/src/repositories/base-repository.ts`).
- `emitSideEffects()` (`packages/events/src/side-effects.ts`) runs the reactors
  registered in `packages/events/src/reactors.ts` in registration order. A new
  reaction is a new reactor, never an edit to the emit loop. If pg-boss is
  unavailable the call logs and returns; it never fails the mutation.
- **Sync-origin writes** (`origin: "sync"`, a connector mirroring data in) do
  not trigger outbound webhooks or cross-thread notifications. They still reach
  the automation matcher, so an automation can opt in. A sync run reports once
  at its end with `connector_sync.complete.completed`.

## Proposals in the chain

For a governed mutation the chain is:

```
<subject>.<action>.requested     correlationId = X
        │
pending proposal                  data.correlationId = X
        │                         data.requestedEventId = id of the .requested event
<subject>.<action>.validated     same correlationId (on approval)
        │
<subject>.<action>.completed     same correlationId (materialised)
```

- A mutation router records `.requested` and calls `checkPermissionOrPropose()`.
  If review is needed it calls `createPendingProposal()`
  (`packages/api/src/utils/permission-check.ts`).
- Explicit proposal endpoints call `createEventBackedProposal()`
  (`packages/api/src/utils/event-backed-proposal.ts`), which records
  `.requested` and then delegates to `createPendingProposal()`. An agent write
  that exactly matches an existing pending proposal returns that proposal
  without recording a second `.requested` event.
- Approval emits `.validated` with the same `correlationId` (the executors in
  `packages/api/src/routers/proposals/executors/`); materialisation emits
  `.completed`.

The proposal row holds review and provenance (status, reviewer, attribution,
summary, reasoning); the `events` table holds the timeline. Enriched proposal
responses carry a `review` object (`ProposalReviewModel` in
`packages/types/src/proposals/index.ts`) with `correlationId` and the correlated
`events`. Clients render the timeline from `review.events` instead of
rebuilding the trace.

## Automation-triggerable events

`OperationalEventTypes` in `packages/events/src/event-types.ts` is the single
list of event types that `emitSideEffects` can produce, that an automation's
`eventPattern` can name, and that `GET /api/hub/events?types[]=...` can filter.
Each entry has a `type`, a label, a domain, a description and the `filterKeys`
a trigger may filter on. The pattern is `{singular-domain}.{action}.{modifier}`,
for example:

| Type                                | When                                                             |
| ----------------------------------- | ---------------------------------------------------------------- |
| `entity.create.completed`           | an entity was created                                            |
| `entity.update.completed`           | fields or properties changed (`changedKeys`, `previous.<field>`) |
| `entity.transition.completed`       | a lifecycle status moved through `moveStatus`                    |
| `proposal.approved.completed`       | a proposal was approved                                          |
| `capture.complete.completed`        | the capture pipeline finished                                    |
| `connector_sync.complete.completed` | a connector sync run finished                                    |
| `channel_message.created.completed` | a message was posted to a channel                                |

Read the file for the full list (29 types on 2026-10-20). `GeneratedEventTypes`
in `generator.ts` uses a different, table-based pattern for schema
documentation; automations never match those strings.

## Automation trigger config

The trigger kind is the `automations.trigger_type` column; the per-kind
settings are the typed `AutomationTriggerConfig` in
`packages/database/src/schema/automations.ts`: `eventPattern` and generic
dot-notation `filters` for event triggers, `expression` for cron,
`webhookSubscriptionId` for webhook triggers, and typed filters per source
(`provider` and `syncStatus` for connector syncs, `channelId`, `messageRole`
and `shape` for channel messages, `relationType` and `changeType` for
relations, `proposalEventType` for proposals, `profileSlug`, `entityId`,
`projectId`).

## Delivery routing

AI and automation output that is meant for a person is routed by domain to one
or more surfaces, according to `workspace.settings.deliveryPreferences`
(`DeliveryPreferences` in `packages/database/src/schema/workspaces.ts`).

| Domain       | Source                                                      | Default surface |
| ------------ | ----------------------------------------------------------- | --------------- |
| `proactive`  | cron briefings, digests, insights, nudges                   | `feed`          |
| `ai_insight` | Intelligence Service posts (`POST /api/hub/proactive/post`) | `feed`          |
| `automation` | automation `channel_message` output nodes                   | `feed`          |
| `connector`  | connector sync completion                                   | `notification`  |

Surfaces: `feed` (the proactive feed channel), `chat` (the personal chat
channel), `notification` (a notification row), `external` (a bound Discord,
Telegram or other messaging channel, with `provider` and `channelRef`), and
`suppress` (drop the signal).

Two entry points share the preferences and defaults:

- `routeSignal()` (`packages/api/src/utils/delivery-router.ts`) for
  Intelligence Service and automation output. When the signal is
  agent-initiated, external delivery goes through the external-send capability
  gate. A caller may pass `externalOverride` to target a specific external
  channel.
- `routeProactiveMessage()` (`packages/jobs/src/utils/proactive-post.ts`) for
  cron workers. Jobs cannot import the API package, so external delivery is
  delegated to `routeSignal` through `registerSignalRouter`, which the API
  registers at boot.
