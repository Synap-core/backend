# synap-memory

Structured knowledge graph for AI agents. Replace flat text files with typed entities, documents, and facts stored in PostgreSQL.

## Install

```bash
openclaw skill install synap-memory
```

## What It Does

| Primitive     | Purpose                          | Example                            |
| ------------- | -------------------------------- | ---------------------------------- |
| **Entities**  | Typed objects with properties    | tasks, people, projects, companies |
| **Documents** | Long-form Markdown content       | meeting notes, reports, summaries  |
| **Facts**     | Atomic knowledge across sessions | "Marc prefers email over Slack"    |
| **Relations** | Entity-to-entity links           | person → works-at → company        |
| **Search**    | Full-text + semantic search      | "what do I know about Marc?"       |

All AI writes go through Synap's governance system — auditable, reversible, proposal-based.

## Setup

### Option A: Self-Hosted (Free)

```bash
# 1. Start Synap pod
git clone https://github.com/synap-core/backend && cd backend/deploy
cp .env.example .env
docker compose up -d

# 2. Create your account at https://your-domain/registration

# 3. Connect OpenClaw
./setup-openclaw.sh

# 4. Install the skill
openclaw skill install synap-memory
```

### Option B: Managed Pod (15/mo)

1. Sign up at [synap.live](https://synap.live)
2. Go to Settings > API Keys > Create key with `hub-protocol.read` + `hub-protocol.write` scopes
3. Set env vars:
   ```
   SYNAP_HUB_API_KEY=your-key
   SYNAP_POD_URL=https://your-pod.synap.live
   ```
4. Install: `openclaw skill install synap-memory`

## Environment Variables

| Variable              | Required | Description                         |
| --------------------- | -------- | ----------------------------------- |
| `SYNAP_HUB_API_KEY`   | Yes      | Hub Protocol API key                |
| `SYNAP_POD_URL`       | Yes      | Synap pod URL                       |
| `SYNAP_WORKSPACE_ID`  | Auto     | Auto-fetched via config endpoint    |
| `SYNAP_AGENT_USER_ID` | Auto     | Auto-fetched via config endpoint    |
| `SYNAP_CONFIG_URL`    | No       | Config pull endpoint (managed pods) |

## Architecture

```
OpenClaw Agent → Hub Protocol REST (/api/hub/*) → Synap Pod
                 Bearer: SYNAP_HUB_API_KEY        PostgreSQL + Typesense + pgvector
```

76+ REST endpoints. No MCP required. All operations use standard HTTP with JSON.

## Related

- [synap-os](https://github.com/synap-core/backend/tree/main/skills/synap-os) — World interface (channels, messaging, A2AI relay)
- [Synap](https://synap.live) — Sovereign AI knowledge infrastructure
- [Hub Protocol](https://synap.live/docs/hub-protocol) — Open REST API spec

## License

MIT
