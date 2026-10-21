# Webhooks

> Verified against code on 2026-10-20 (backend@cc4b2d81).

Inbound webhooks let other systems push events into a pod; outbound webhooks
let a pod notify other systems. Both go through the same event chain as any
other write ([event-chain.md](event-chain.md)).

## Inbound

All inbound webhooks are mounted under `/api/webhooks` in `apps/api/src/index.ts`.

| Path                            | Sender                       | Authentication                                                                                | Handler                                        |
| ------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `POST /inbound/:subscriptionId` | any external service         | `X-Synap-Signature: sha256=<hex>`, HMAC-SHA256 of the raw body with the subscription's secret | `packages/api/src/routers/webhooks-inbound.ts` |
| `POST /messaging`               | messaging provider (Unipile) | provider header checked by the connector's `parseWebhook` (`unipile-auth`)                    | same file                                      |
| `POST /calcom/:token`           | Cal.com                      | `:token` selects the config; `x-cal-signature-256` HMAC (no `sha256=` prefix)                 | same file                                      |
| `POST /fireflies/:token`        | Fireflies                    | `:token`; plus `x-hub-signature` HMAC when a signing secret is configured                     | same file                                      |
| `POST /mailgun/:token`          | Mailgun                      | `:token`; Mailgun signature (HMAC of timestamp + nonce)                                       | same file                                      |
| `POST /postiz/:token`           | Postiz                       | `:token` only (Postiz sends no signature)                                                     | same file                                      |
| `POST /n8n/inbox`               | n8n                          | `X-Webhook-Secret`                                                                            | `apps/api/src/webhooks/n8n.ts`                 |
| `POST /kratos`                  | Ory Kratos                   | `X-Webhook-Secret`                                                                            | `apps/api/src/webhooks/kratos.ts`              |
| `POST /intelligence/callback`   | Intelligence Service         | `Authorization: Bearer`; required, never fails open                                           | `apps/api/src/webhooks/intelligence.ts`        |

Rules the handlers share:

- Secrets and signatures are compared with `crypto.timingSafeEqual` after a
  length check.
- **Generic inbound.** An unknown or inactive subscription and a bad signature
  return the same 401, so subscription ids cannot be enumerated. Bodies are
  capped at 1 MB. A valid call updates `last_triggered_at` and emits
  `external_webhook.received` with the payload, so an automation can trigger on
  it (`eventPattern: "external_webhook.received.completed"`, filter on payload
  fields).
- **Token-path providers** (`:token`): the token selects the provider's config on
  its tool (`metadata.<provider>.webhook`); an unknown token is a 404. Cal.com
  and Fireflies dedup on their own ids, and a backfill poller recovers events a
  webhook missed. Fireflies acknowledges first and fetches the transcript in a
  `fireflies-ingest` job.
- **Messaging** answers 200 even when parsing fails, so the provider does not
  retry a payload it will never accept.
- Writes go through service functions that call `emitSideEffects()`
  (`MessagingAccountService` for messaging accounts, `syncUserFromKratos` for
  Kratos), never through a bare insert. The resulting events
  (`external_message.received`, `messaging_account.*`, `inbox_item.received`,
  `inbox_item.analyzed`, `user.updated`, ...) are listed in
  `OperationalEventTypes`.

**Connector sync is not a webhook here.** The connector broker's webhook lands on
the control plane, which then calls the pod's
`POST /api/connectors/sync-trigger`. See [sync-sources.md](sync-sources.md).

### Adding an inbound provider

1. Add a route to `webhooks-inbound.ts` (or a router in `apps/api/src/webhooks/`
   mounted under `/api/webhooks/<provider>`), static paths before parameterised
   ones.
2. Verify authentication first, timing-safe.
3. Parse the payload with a Zod schema.
4. Write through a service that calls `emitSideEffects()` with the workspace.
5. Add any new event type to `OperationalEventTypes`
   (`packages/events/src/event-types.ts`).

## Outbound

Subscriptions live in `webhook_subscriptions` (url, event types, secret,
optional workspace, owner `user_id`, and `api_key_id` when an API key created
it). They are managed through tRPC `webhooks` (`packages/api/src/routers/webhooks.ts`:
`create`, `list`, `update`, `delete` and workspace variants) and through Hub
Protocol `POST/GET /api/hub/webhooks`, `DELETE /api/hub/webhooks/:id`
(`routers/hub-protocol/rest/webhooks.ts`, requires `hub-protocol.write`; a key
sees only its own subscriptions).

Every outbound POST is sent by one worker, the `webhook-delivery` queue
(`packages/jobs/src/workers/webhook-worker.ts`). Two producers feed it:

1. the domain-event reactor in `emitSideEffects` (every event except
   sync-origin writes), wire format `event.v1`: body
   `{ type, subjectId, userId, data, timestamp }`, headers
   `X-Synap-Event-Type`, `X-Synap-Event-Id`, `X-Synap-Signature: <hex>`;
2. `dispatchWebhooksForEvent` (`packages/api/src/utils/webhook-delivery.ts`, chat
   events and entity property updates), wire format `chat.v1`: body
   `{ event, data, timestamp }`, headers `X-Synap-Event`,
   `X-Synap-Signature: sha256=<hex>`.

Both formats are kept byte-compatible for existing subscribers; every request
also carries `X-Synap-Webhook-Format` and a stable `X-Synap-Delivery-Id`, and
consumers dedupe on the delivery id. The body is frozen at enqueue, so a pg-boss
retry resends the same bytes under the same signature. Each attempt is logged
in `webhook_deliveries`.

Audience rules:

- **Match:** an empty `eventTypes` list means every event (only legacy rows;
  the create APIs require at least one type).
- **Workspace:** a workspace-bound subscription receives only events whose
  subject is in that workspace.
- **Readers only:** a subscription receives an event only if its owner may read
  the subject (channel read rule, entity access layer). A failed audience read
  delivers to nobody.
- **Key-bound:** a subscription created by an API key is delivered only while
  that key is active, unrevoked and unexpired, and only for subjects the key's
  grant can read.

## History

- The generic inbound endpoint was `POST /api/webhooks/inbound/{keyId}` with an
  API-key bearer; it is now keyed by subscription id and signed with the
  subscription's secret.
- Hub webhook subscriptions once required a `webhook:manage` key scope; that
  scope was retired on 2026-10-06 and the routes check `hub-protocol.write`.
