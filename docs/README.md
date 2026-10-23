# Documentation in this repository

User, self-hosting and API documentation is published at
<https://docs.synap.live>. The files here are the ones that sit next to the
code they describe.

## Start here

| File                                                   | What it is                                                                         |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| [`ARCHITECTURE-OVERVIEW.md`](ARCHITECTURE-OVERVIEW.md) | What Synap is: the data model, the unit of work, governance. Cites its sources.    |
| [`DEVELOPER.md`](DEVELOPER.md)                         | Building on a pod: the public SDK, bring-your-own-agent over MCP, self-hosting.    |
| [`../CONTRIBUTING.md`](../CONTRIBUTING.md)             | Working on this repository: setup, tests, migrations, commits.                     |
| [`../deploy/README.md`](../deploy/README.md)           | Self-hosting a pod: install, update, back up, restore.                             |
| [`development/README.md`](development/README.md)       | Where the engineering notes for each part of the backend live.                     |
| [`architecture/README.md`](architecture/README.md)     | Design notes per subsystem: write path, event chain, realtime, Hub Protocol, keys. |
| [`decisions/README.md`](decisions/README.md)           | Decision records: context, decision, alternatives, state today.                    |

> `ARCHITECTURE-OVERVIEW.md` is the source of truth for the public claims the
> root `README.md` makes. If the model changes, update it in the same commit.

## Reference (generated)

Generated from source by `pnpm docs:reference`; do not edit by hand.

| File                                                       | What it is                                     |
| ---------------------------------------------------------- | ---------------------------------------------- |
| [`reference/mcp-tools.md`](reference/mcp-tools.md)         | Every tool the pod's MCP server lists          |
| [`reference/events.md`](reference/events.md)               | The event types an automation trigger can name |
| [`reference/hub-openapi.json`](reference/hub-openapi.json) | OpenAPI document of the Hub Protocol REST API  |

## Operating a pod

| File                                                             | What it is                                                  |
| ---------------------------------------------------------------- | ----------------------------------------------------------- |
| [`marketplace-source.md`](marketplace-source.md)                 | Publishing a marketplace source a pod can add               |
| [`DEPLOY-HYGIENE.md`](DEPLOY-HYGIENE.md)                         | Rules for any host running the pod's Compose stack          |
| [`../deploy/DEPLOY-INTEGRITY.md`](../deploy/DEPLOY-INTEGRITY.md) | How a from-source deploy proves it runs the intended commit |
| [`../deploy/runbooks/`](../deploy/runbooks/)                     | Key rotation runbooks (field-encryption key, Ory secrets)   |

## Design notes

| File                                               | What it is                                                     |
| -------------------------------------------------- | -------------------------------------------------------------- |
| [`LIBRARY.md`](LIBRARY.md)                         | The Library: what a pod keeps from captures, imports and links |
| [`IMPORT_CURATE_BUILD.md`](IMPORT_CURATE_BUILD.md) | The import, curate and build flow                              |

Plans, research and decision briefs are not kept in this repository; the team
keeps them in its own Synap pod.
