# synap-memory — Structured Knowledge for AI Agents

Give your OpenClaw agent a typed knowledge graph instead of flat text files.

## What It Does

- **Entities**: Create typed objects (tasks, people, projects, notes, etc.) with properties and relationships
- **Documents**: Store and retrieve long-form Markdown content
- **Facts**: Remember atomic pieces of knowledge across sessions
- **Relations**: Build a knowledge graph by linking entities together
- **Search**: Full-text + semantic search across all your data
- **Governance**: All AI writes are auditable — proposals for review when needed

## Quick Start

### Option A: Self-Hosted (Free)

1. **Start Synap**

   ```bash
   git clone https://github.com/synap-core/backend && cd backend/deploy
   cp .env.example .env  # Edit with your settings
   docker compose up -d
   ```

2. **Connect OpenClaw**

   ```bash
   ./setup-openclaw.sh
   ```

3. **Install the skill**
   ```bash
   openclaw skill install https://raw.githubusercontent.com/synap-core/backend/main/skills/synap-memory/SKILL.md
   ```

### Option B: Managed Pod ($15-20/mo)

1. Create a pod at [synap.live](https://synap.live)
2. Go to Settings → API Keys → Create key with `hub-protocol.read` + `hub-protocol.write` scopes
3. Set env vars:
   ```
   SYNAP_HUB_API_KEY=your-key
   SYNAP_POD_URL=https://your-pod.synap.live
   SYNAP_WORKSPACE_ID=your-workspace-id
   SYNAP_AGENT_USER_ID=your-agent-user-id
   ```
4. Install the skill:
   ```bash
   openclaw skill install https://raw.githubusercontent.com/synap-core/backend/main/skills/synap-memory/SKILL.md
   ```

## Environment Variables

| Variable              | Required | Description                                                                     |
| --------------------- | -------- | ------------------------------------------------------------------------------- |
| `SYNAP_HUB_API_KEY`   | Yes      | Hub Protocol API key (Bearer token)                                             |
| `SYNAP_POD_URL`       | Yes      | URL of your Synap pod (e.g., `http://backend:4000` or `https://pod.synap.live`) |
| `SYNAP_WORKSPACE_ID`  | Auto     | Workspace UUID (auto-fetched if SYNAP_CONFIG_URL set)                           |
| `SYNAP_AGENT_USER_ID` | Auto     | Agent user UUID (auto-fetched if SYNAP_CONFIG_URL set)                          |
| `SYNAP_CONFIG_URL`    | No       | Config endpoint for automatic setup                                             |

## How It Works

```
OpenClaw Agent
    │
    │  Hub Protocol REST (Bearer token auth)
    ▼
Synap Pod (PostgreSQL + Typesense + pgvector)
    │
    ├── Entities (typed objects with properties)
    ├── Documents (Markdown content)
    ├── Facts (atomic knowledge, keyword searchable)
    ├── Relations (entity-to-entity links)
    └── Proposals (governed writes, audit trail)
```

The skill uses **Hub Protocol REST** endpoints (`/api/hub/*`) for all operations.

## Related

- [synap-os](../synap-os/) — World-interface skill (channels, messaging, A2AI relay)
- [Synap Documentation](https://synap.live/docs)
- [Hub Protocol Specification](https://synap.live/docs/hub-protocol)
