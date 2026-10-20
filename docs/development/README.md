# Backend development

Setting up, testing and submitting a change: [`CONTRIBUTING.md`](../../CONTRIBUTING.md).

The engineering notes for each part of the backend live next to its code:

| Topic                                                        | Where                                                                                                  |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| Hub Protocol schemas (Intelligence Service and pod)          | [`packages/hub-protocol/README.md`](../../packages/hub-protocol/README.md)                             |
| Feed ingestion (RSS/Atom)                                    | [`packages/feed-service/README.md`](../../packages/feed-service/README.md)                             |
| Auth bootstrap (credential flows of the SDK and REST client) | [`packages/auth-bootstrap/README.md`](../../packages/auth-bootstrap/README.md)                         |
| Migration runner contract                                    | header of [`packages/database/src/scripts/migrate.ts`](../../packages/database/src/scripts/migrate.ts) |
| Deployment, Compose stack, operator CLI                      | [`deploy/README.md`](../../deploy/README.md)                                                           |
| Building an app or agent on a pod                            | [`docs/DEVELOPER.md`](../DEVELOPER.md)                                                                 |
