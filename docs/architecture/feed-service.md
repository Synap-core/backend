# Feeds and pluggable sources

> Verified against code on 2026-10-20 (backend@cc4b2d81). Migrated from Synap's
> internal team docs on 2026-10-20. Most of the original pages described a REST
> API and environment variables that no longer exist; see "History".

A pod pulls external content (feeds, search results, filings, any JSON API)
through one pluggable source system: a **source config** says how to reach a
source, a **subscription** says who follows it and where the cursor is, and a
**provider** knows how to fetch it.

## Data model

`packages/database/src/schema/source-configs.ts`:

- `source_configs`: `user_id`, `provider_type`, `name`, `description`,
  `config` (JSON, may hold `vault://` references), `metadata`, and the last
  connection test (`last_tested_at`, `last_test_status`, `last_test_error`).
- `source_subscriptions`: `user_id`, the config it follows, `params`, `cursor`,
  `last_fetched_at`, `last_item_at`, `status` (`active` by default, `error` with
  `error_message` after a failed fetch).

## Providers

Providers implement `ISourceProvider` (`packages/feed-service/src/providers/`)
and register themselves in the `SourceProviderRegistry` singleton when
`@synap/feed-service` is imported (`src/index.ts`). Built in:

| `provider_type` | Fetches                                                                                                                                                                                                               |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `http-api`      | any JSON HTTP API: `endpoint`, method, headers, body, an `itemsPath` into the response and a field `mapping` to the common `SourceItem` shape                                                                         |
| `cp-relay`      | forwards the fetch to a relay (typically the control plane) at `POST <relayUrl>/api/sources/relay` with `upstreamType` and `upstreamConfig`, for upstreams the pod should not call directly or that need a shared key |

A pod that does not want a relay never creates a `cp-relay` config. A new
provider is a new `ISourceProvider` registered in `src/index.ts`.

## Pipeline

1. `feed-scheduler` (cron, every minute, `packages/jobs/src/workers/feed-scheduler.ts`)
   enqueues `feed-source-execute` for each active subscription whose last fetch
   is older than its poll cadence.
2. `feed-source-executor` loads the subscription and its config, resolves
   `vault://` references as the owner, calls the provider, saves the returned
   cursor and timestamps, and marks the subscription `error` with a message on
   failure (vault or provider).
3. The items go to the `feed-source-items` queue, consumed by the
   entity-extract worker.

## API

| tRPC router           | Procedures                                                                                                     | Gate      |
| --------------------- | -------------------------------------------------------------------------------------------------------------- | --------- |
| `sourceConfigs`       | `list`, `listProviders`, `create`, `update`, `delete`, `testConnection`                                        | pod admin |
| `sourceSubscriptions` | `list`, `listBySourceConfig`, `get`, `create`, `update`, `delete`, `pause`, `resume`, `updateCursor`           | the user  |
| `feeds`               | `list` (subscriptions with health), `recentItems`, `updateLastFetched`, `healthSummary`, `countBySourceConfig` | the user  |

## The package's own pipeline

`@synap/feed-service` also exports the older `FeedService` pipeline (provider,
classifier, publisher): classifiers `ISClassifier` (Intelligence Service),
`KeywordClassifier`, `NoopClassifier`, and `ChannelMessagePublisher`. The
package [README](../../packages/feed-service/README.md) documents it; note that
it still names a `DirectRSSProvider` the package no longer contains.

## RSSHub

`deploy/docker-compose.yml` keeps an optional `rsshub` profile (`rsshub` and
`browserless`, bound to `127.0.0.1`, on the sandbox network; set
`RSSHUB_ACCESS_KEY`). No provider in the pod reads `RSSHUB_URL`; reaching
RSSHub would go through a source config.

## History

- Before the pluggable source system, feeds were channels of type `FEED` with a
  `feedConfig`, managed through a REST API under `/api/feeds` (create, trigger,
  items, engagement, stats, preferences) and an `RSS_PROVIDER_TYPE` setting
  (`direct`, `rsshub`, `cpproxy`, `custom`). Neither the REST API nor those
  settings exist now. `packages/database/migrations/feed-service-migration.ts`
  converted the old channel configs; channels of type `FEED` are still used to
  render items, but no longer drive scheduling.
