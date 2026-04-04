# synap-os

World interface for Synap workspaces. Relay messages from Telegram, WhatsApp, Slack, and Discord into your Synap pod. Communicate with Synap AI via A2AI channels.

## Install

```bash
openclaw skill install synap-os
```

## What It Does

| Feature                 | Description                                                  |
| ----------------------- | ------------------------------------------------------------ |
| **Message Relay**       | Telegram, WhatsApp, Slack, Discord messages → Synap channels |
| **A2AI Channels**       | Agent-to-agent async communication with Synap Intelligence   |
| **Entity CRUD**         | Create, read, update entities via Hub Protocol               |
| **Document Management** | Create and search Markdown documents                         |
| **Proposal Governance** | All writes go through Synap's approval system                |

## When to Use

- **synap-os**: Your agent IS the world interface — it receives external messages and relays them to Synap for processing
- **synap-memory**: Your agent just needs structured memory — no messaging relay needed

Use both together for a full-featured Synap-connected agent.

## Setup

Same as synap-memory. Requires a Synap pod (self-hosted or managed).

```bash
# Set required env vars
SYNAP_HUB_API_KEY=hub_xxxx
SYNAP_CONFIG_URL=https://pod.synap.live/trpc/intelligenceRegistry.getServiceConfig

# Install
openclaw skill install synap-os
```

## Environment Variables

| Variable                   | Required | Description                                                      |
| -------------------------- | -------- | ---------------------------------------------------------------- |
| `SYNAP_HUB_API_KEY`        | Yes      | Hub Protocol API key                                             |
| `SYNAP_CONFIG_URL`         | Yes      | Config pull endpoint (auto-fetches pod URL, workspace, agent ID) |
| `SYNAP_POD_URL`            | Auto     | Synap pod URL                                                    |
| `SYNAP_WORKSPACE_ID`       | Auto     | Workspace UUID                                                   |
| `SYNAP_AGENT_USER_ID`      | Auto     | Agent user UUID                                                  |
| `SYNAP_DEFAULT_CHANNEL_ID` | No       | Default channel for message relay                                |

## Related

- [synap-memory](https://github.com/synap-core/backend/tree/main/skills/synap-memory) — Knowledge graph (entities, docs, facts, relations)
- [Synap](https://synap.live) — Sovereign AI knowledge infrastructure

## License

MIT
