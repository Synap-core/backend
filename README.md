# Synap pod

A Synap pod is a personal data server with a governed agent runtime on it. It
stores your records in your own PostgreSQL database, lets AI agents work on
them under rules you set, and records every change on an append-only event
chain. This repository is the pod: its API, workers, realtime server, operator
console, and the files and CLI that deploy and operate it. It is open source
(MIT) and self-hostable.

- **You own the data.** A pod is a PostgreSQL database you can export with
  `pg_dump`, self-host, or have hosted for you.
- **Agents propose, you approve.** An AI write either arrives as a proposal you
  review or runs under a rule you granted. Destructive, admin and
  scope-changing writes never auto-approve.
- **Bring your own agent.** Claude, ChatGPT, Cursor or any MCP client connects
  to the pod with permissions you grant. The pod does not meter or proxy your
  inference.

What Synap is, in detail, with the source of every claim:
[docs/ARCHITECTURE-OVERVIEW.md](docs/ARCHITECTURE-OVERVIEW.md).

## Quickstart: run a pod

On a Linux host with a domain pointing at it:

```bash
curl -fsSL https://github.com/synap-core/backend/releases/download/channel-stable/install.sh \
  | sudo bash -s -- --domain pod.example.com --email you@example.com

cd /opt/synap/deploy
sudo synap setup admin --email you@example.com --magic-link   # sign-in link for the first admin
```

The installer installs Docker if needed, downloads the latest stable release,
checks it, and starts the stack behind Caddy with automatic HTTPS.

- Self-hosting guide: <https://docs.synap.live/docs/run>
- The same guide in this repository, with every operator command:
  [deploy/README.md](deploy/README.md)
- Or let Synap host the pod for you: <https://www.synap.live/hosted>

## Connect an agent

From your own machine:

```bash
npm install -g @synap-core/cli
synap init --pod-url https://pod.example.com
synap connect claude-code        # or cursor, codex, …; `synap connect --list`
```

## Build on a pod

`@synap-core/sdk` is a typed tRPC client for the pod's API:

```ts
import { createSynapClient } from "@synap-core/sdk";

const synap = createSynapClient({
  podUrl: "https://pod.example.com",
  sessionToken: process.env.SYNAP_SESSION_TOKEN,
  workspaceId: "ws_...",
});

const entities = await synap.entities.list.query({ limit: 20 });
```

Agents and integrations that hold an API key use the Hub Protocol REST API
(`/api/hub/*`, client: `@synap-core/hub-rest-client`) or the pod's MCP server.
Authentication options and examples: [docs/DEVELOPER.md](docs/DEVELOPER.md).

## What a pod runs

| Service     | What it does                                                                       |
| ----------- | ---------------------------------------------------------------------------------- |
| `backend`   | The API (Hono): tRPC at `/trpc`, Hub Protocol REST at `/api/hub/*`, the MCP server |
| `realtime`  | Socket.IO events and Yjs collaborative documents                                   |
| `pod-admin` | The operator console                                                               |
| `postgres`  | PostgreSQL with TimescaleDB: records, the event chain, pg-boss job queues          |
| `kratos`    | Ory Kratos: sign-in, sessions, account recovery                                    |
| `typesense` | Full-text search (pgvector embeddings are behind `VECTOR_SEARCH_ENABLED`)          |
| `minio`     | File storage                                                                       |
| `redis`     | In-memory key-value store (LRU, 256 MB cap)                                        |
| `caddy`     | TLS and routing at the edge                                                        |

Optional services (monitoring, RSS, tunnels) are Compose profiles; see
[deploy/README.md](deploy/README.md).

## The model, briefly

- **Data model.** Every record is an entity of one **kind** (person, task,
  note, ...). The roles it plays (client, partner, ...) are **facets** on the
  same entity, not copies. **Views** are projections over the same records.
- **Unit of work.** A **project** is long-lived intent; a **track** is a method
  running inside one project; a **session** is a bounded piece of work with a
  scope you accept, and a channel where people and agents work on it. A session
  that works can become a **playbook**; an **automation** runs a playbook on an
  event, a schedule, a webhook or by hand.
- **Governance.** Agent writes go through one policy engine. Rules you grant
  can auto-approve some changes; deletes, admin changes and scope changes always
  come to you.

## Repository layout

| Path                             | What it holds                                                                    |
| -------------------------------- | -------------------------------------------------------------------------------- |
| `apps/api/`                      | The pod's HTTP server                                                            |
| `apps/pod-admin/`                | The operator console                                                             |
| `packages/`                      | API routers, database schema and migrations, workers, realtime, shared libraries |
| `skills/`                        | System skills shipped with every pod                                             |
| `deploy/`, `synap`, `install.sh` | The Compose stack, the operator CLI, the installer                               |
| `docs/`                          | Documentation that lives next to the code ([index](docs/README.md))              |

## Contributing

Setup, checks, migration rules and commit conventions:
[CONTRIBUTING.md](CONTRIBUTING.md). Please read the
[Code of Conduct](CODE_OF_CONDUCT.md), and report vulnerabilities privately as
described in [SECURITY.md](SECURITY.md).

## Community

- Discord: <https://discord.gg/xhRdQ7hG5h>
- X: <https://x.com/synapOSI>
- Issues: <https://github.com/Synap-core/backend/issues>

## License

[MIT](LICENSE).
