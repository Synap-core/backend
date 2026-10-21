# Backend architecture notes

Design notes for the parts of the pod that agents and contributors cite while
changing code. Each page states the commit it was last verified against. For
what a pod is, start with [../ARCHITECTURE-OVERVIEW.md](../ARCHITECTURE-OVERVIEW.md).

| Page                                                       | Covers                                                                    |
| ---------------------------------------------------------- | ------------------------------------------------------------------------- |
| [overview.md](overview.md)                                 | Processes, packages and the write path                                    |
| [migrations.md](migrations.md)                             | Migration rules, the runner's guarantees, schema coherence                |
| [property-def-scoping.md](property-def-scoping.md)         | Global, profile-base and workspace-overlay property definitions           |
| [event-chain.md](event-chain.md)                           | Audit events, side effects, proposals in the chain, delivery routing      |
| [realtime.md](realtime.md)                                 | Presence, domain events, Yjs co-editing, persistence                      |
| [hub-protocol.md](hub-protocol.md)                         | The `/api/hub` REST surface: middleware, idempotency, sub-tokens, streams |
| [api-keys.md](api-keys.md)                                 | Key types, scopes, grants, mint sites                                     |
| [auth-and-federation.md](auth-and-federation.md)           | Sessions, federated sign-in, trusted issuers, federation routes           |
| [webhooks.md](webhooks.md)                                 | Inbound providers and outbound delivery                                   |
| [sync-sources.md](sync-sources.md)                         | Adding a connector sync source                                            |
| [import-pipeline.md](import-pipeline.md)                   | Identity resolution and the import write path                             |
| [delivery-service.md](delivery-service.md)                 | Delivering to feed, chat and notifications                                |
| [feed-service.md](feed-service.md)                         | Pluggable sources and subscriptions                                       |
| [official-catalog-signing.md](official-catalog-signing.md) | The Control Plane contract for signing Synap's official catalog           |

Decisions with lasting consequences are recorded in [../decisions/](../decisions/).
