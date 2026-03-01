# AI Interaction Architecture

## How Intelligence Works Inside Synap

**Version:** 1.0 — February 2026
**Scope:** `synap-backend`, `synap-intelligence-service`, `synap-control-plane-api`, `synap-app`

---

## Table of Contents

1. [The Core Idea](#1-the-core-idea)
2. [Architecture Overview](#2-architecture-overview)
3. [The Three Layers of AI Interaction](#3-the-three-layers-of-ai-interaction)
4. [Hub Protocol — The Universal AI Gateway](#4-hub-protocol--the-universal-ai-gateway)
5. [Channel Types — Where Conversations Live](#5-channel-types--where-conversations-live)
6. [A2AI Channels — Agent-to-Agent Communication](#6-a2ai-channels--agent-to-agent-communication)
7. [OpenClaw — The World Interface](#7-openclaw--the-world-interface)
8. [External Messaging — Telegram First](#8-external-messaging--telegram-first)
9. [MCP — Tool Discovery Standard](#9-mcp--tool-discovery-standard)
10. [Governance — Every Write is Governed](#10-governance--every-write-is-governed)
11. [The Synap OS Skill — Teaching OpenClaw](#11-the-synap-os-skill--teaching-openclaw)
12. [Extending to Other Intelligence Services](#12-extending-to-other-intelligence-services)
13. [What Was Built — Implementation Summary](#13-what-was-built--implementation-summary)
14. [Design Decisions and Trade-offs](#14-design-decisions-and-trade-offs)

---

## 1. The Core Idea

Synap is a **workspace intelligence platform**. Its core strength is organizing and reasoning over structured knowledge: entities, documents, views, relationships. The AI that lives inside Synap is excellent at answering questions about _your data_.

But Synap's AI cannot browse the web, send a Telegram message, run shell commands, or interact with services outside the workspace. For that, you need a "world interface."

**The fundamental insight driving this architecture:**

> Synap = the brain. External agents = the hands.

Rather than building every tool internally (a browser, a shell, messaging connectors, filesystem access), Synap exposes a clean, governed API gateway — **Hub Protocol** — that lets any capable external agent act on behalf of users inside a Synap workspace. Synap's own AI can then call those external tools via **MCP (Model Context Protocol)**, getting the best of both worlds.

This is not a hierarchy. Synap's IS and external agents like OpenClaw are **peers**, each with their area of expertise, communicating through a shared protocol.

---

## 2. Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────────┐
│                          SYNAP WORKSPACE                                  │
│                                                                            │
│   ┌──────────────┐     ┌───────────────────┐     ┌────────────────────┐  │
│   │   Frontend   │────▶│   Backend App      │────▶│  Intelligence Hub  │  │
│   │  (Next.js)   │     │  (tRPC + Hono)     │     │  (Hono SSE + LLM)  │  │
│   └──────────────┘     └─────────┬─────────┘     └────────────────────┘  │
│                                  │                         │               │
│                                  ▼                         ▼               │
│                         ┌────────────────┐       ┌────────────────────┐  │
│                         │   Data Pod     │       │  MCP Client        │  │
│                         │  (PostgreSQL   │       │  (tool discovery)  │  │
│                         │  + Governance) │       └─────────┬──────────┘  │
│                         └────────┬───────┘                 │              │
│                                  │ Hub Protocol            │ /mcp         │
└──────────────────────────────────┼─────────────────────────┼──────────────┘
                                   │                         │
                    ┌──────────────▼─────────────────────────▼──────────────┐
                    │                   OPENCLAW                              │
                    │  (Node.js agent — shell, browser, filesystem,           │
                    │   Telegram, WhatsApp, Slack, Discord, iMessage...)      │
                    │                                                          │
                    │  Connects TO Synap via: Hub Protocol                    │
                    │  Exposes tools TO Synap via: MCP server at /mcp         │
                    └─────────────────────────────────────────────────────────┘
```

**Key components:**

| Component        | Role                                                | Transport                     |
| ---------------- | --------------------------------------------------- | ----------------------------- |
| Backend App      | Auth, routing, channel management, AI orchestration | tRPC over HTTP                |
| Data Pod         | PostgreSQL + governance layer. Zero intelligence.   | tRPC (Hub Protocol)           |
| Intelligence Hub | AI brain — LLM + tools + streaming                  | SSE (POST /api/chat/stream)   |
| Hub Protocol     | Governed API gateway for external agents            | REST (Bearer token)           |
| MCP Client       | Synap IS ← external tools                           | HTTP Streamable Transport     |
| OpenClaw         | World interface — tools + messaging channels        | Hub Protocol (in) + MCP (out) |

---

## 3. The Three Layers of AI Interaction

### Layer 1 — Internal: Synap IS ↔ Data Pod

The Intelligence Hub talks directly to the Data Pod via tRPC. This is the trusted internal path. All AI tool calls (read entity, search, create document) go through Hub Protocol which auto-brands requests and routes them through `checkPermissionOrPropose`.

```
Intelligence Hub → POST {dataPodUrl}/trpc/hubProtocol.entities.readEntity
                 → Bearer hub-protocol-api-key
                 → checkPermissionOrPropose()
                   → autoApproveFor["entity.read"] → GRANTED immediately
                   → "entity.write" → creates proposal in inbox
```

### Layer 2 — Inbound: External Agents → Data Pod (Hub Protocol)

External agents (OpenClaw, any MCP client, custom scripts) can interact with Synap data by authenticating with a Hub Protocol API key. Every write goes through governance. Every read is either auto-approved (in the whitelist) or creates a proposal.

```
OpenClaw → POST {podUrl}/trpc/hubProtocol.channels.sendExternalMessage
         → Bearer openclaw-hub-api-key
         → autoApproved if "a2ai.*" in workspace autoApproveFor
         → else: creates Proposal → user sees in Inbox → approves/rejects
```

### Layer 3 — Outbound: Synap IS → External Tools (MCP)

When OpenClaw registers as an intelligence service, it provides an `mcpEndpoint` (`http://openclaw:18789/mcp`). The backend injects this into the `mcpServers` array sent to Intelligence Hub on every `sendMessage` call. The Intelligence Hub connects to OpenClaw's MCP server and gains access to its full tool library:

```
User types → sendMessage → resolveIntelligenceService
           → mcpServers includes { id: "openclaw", url: "http://openclaw:18789/mcp" }
           → Intelligence Hub connects to MCP
           → LLM can now call: openclaw_shell, openclaw_browser, openclaw_send_telegram, ...
```

This is automatic. No special prompt engineering needed. The LLM sees the available tools and uses them contextually.

---

## 4. Hub Protocol — The Universal AI Gateway

Hub Protocol is the REST API that any external agent uses to read and write Synap workspace data. It is implemented as a set of tRPC procedures under the `hubProtocol.*` namespace.

### Authentication

Every Hub Protocol request must carry a Bearer token matching an API key in the `api_keys` table with the appropriate scopes:

- `hub-protocol.read` — read operations (entities, documents, search, context)
- `hub-protocol.write` — write operations (create entities, send messages, post to A2AI)

The API key middleware auto-brands the request context:

```typescript
ctx.source = "intelligence";
ctx.isHubProtocol = true;
ctx.userId = apiKey.userId; // the human owner of the key
```

The `agentUserId` field on write routes is **always an explicit input** — it is never inferred from auth context. This prevents privilege escalation.

### Available Namespaces

| Namespace                       | What it does                                                                                     |
| ------------------------------- | ------------------------------------------------------------------------------------------------ |
| `hubProtocol.context.*`         | Read workspace context, summaries, recent activity                                               |
| `hubProtocol.search.*`          | Typesense-backed semantic search                                                                 |
| `hubProtocol.entities.*`        | CRUD on entities — all writes go through governance                                              |
| `hubProtocol.documents.*`       | Read/create documents                                                                            |
| `hubProtocol.channels.*`        | Create channels, send messages, A2AI operations                                                  |
| `hubProtocol.branches.*`        | Create research branches                                                                         |
| `hubProtocol.linking.*`         | Create relationships between entities                                                            |
| `hubProtocol.skills.*`          | Discover installed skills                                                                        |
| `hubProtocol.proposals.*`       | Read/update governance proposals                                                                 |
| `hubProtocol.backgroundTasks.*` | Long-running task tracking                                                                       |
| `hubProtocol.services.*`        | Register/update intelligence services (trusted provisioning path — auto-sets `mcpApproved=true`) |

### Governance Integration

Every Hub Protocol write call passes through `checkPermissionOrPropose()`:

```typescript
// permission-check.ts
const result = await checkPermissionOrPropose({
  userId,
  workspaceId,
  agentUserId,
  action: "entity.create",
  subjectType: "entity",
  data: { type: "note", title: input.title },
  db,
});

if (result.type === "denied") throw new TRPCError({ code: "FORBIDDEN" });
if (result.type === "proposed")
  return { status: "proposed", proposalId: result.proposalId };
// result.type === "granted" → proceed
```

---

## 5. Channel Types — Where Conversations Live

Synap's channels table is the universal container for all conversations. Each channel has a `channel_type` that determines behavior:

| Type              | Description                                        | AI triggers?               |
| ----------------- | -------------------------------------------------- | -------------------------- |
| `ai_thread`       | Standard AI conversation                           | Yes — always               |
| `branch`          | Sub-thread branched from a parent message          | Yes — always               |
| `entity_comments` | Discussion attached to a specific entity           | No                         |
| `document_review` | Review/comment thread on a document                | No                         |
| `view_discussion` | Discussion attached to a view                      | No                         |
| `direct`          | Direct message between two users                   | No                         |
| `external_import` | Imported conversation from Telegram/WhatsApp/Slack | No (AI responds via relay) |
| `a2ai`            | Agent-to-agent async communication                 | Yes — when agent posts     |

The `sendMessage` procedure in `channels.ts` handles all message routing. For `ai_thread` and `branch`, the AI responds inline. For `external_import`, the AI responds via `relayToExternalChannel`. For `a2ai`, the AI responds via `triggerA2AIResponse` (called from Hub Protocol after agent posts).

---

## 6. A2AI Channels — Agent-to-Agent Communication

### What They Are

An A2AI channel is an asynchronous message bus between AI agents. It has no requirement for a human to be the author. Synap's Intelligence Service and external agents like OpenClaw can exchange messages as peers.

**Use cases:**

- OpenClaw detects a Telegram message, posts it to A2AI → Synap IS processes it, posts a reply → OpenClaw polls the reply → delivers it to Telegram
- Synap IS identifies a task requiring browser automation → posts request to A2AI → OpenClaw reads it, executes the task, posts result back
- Future: Multi-agent coordination where specialized agents collaborate on a user's behalf

### Channel Properties

```typescript
{
  channelType: "a2ai",
  title: "Research Task: Competitor pricing",
  metadata: {
    topic: "Analyze SaaS competitor pricing and create comparison entity",
    visibility: "open",    // or "closed"
    participants: [],      // agent userIds (required for closed)
  },
  agentId: "orchestrator",  // primary responsible Synap agent
}
```

### Open vs Closed

**Open channels** are discoverable by any agent that can authenticate with Hub Protocol. The first time a new agent posts, a lightweight governance proposal is created. Once approved (or auto-approved via `autoApproveFor: ["a2ai.*"]`), that agent is a recognized participant.

**Closed channels** have a named `participants` list. Non-participants receive a `FORBIDDEN` error immediately with no proposal.

### Message Flow

```
1. User creates A2AI channel via trpc.chat.createA2AIChannel
   → title, topic, visibility, participants

2. OpenClaw discovers available channels via:
   POST {podUrl}/trpc/hubProtocol.channels.listA2AIChannels
   → { workspaceId, agentUserId }

3. OpenClaw posts a message via:
   POST {podUrl}/trpc/hubProtocol.channels.postToA2AIChannel
   → { agentUserId, channelId, workspaceId, content }

4. Backend governance check:
   - closed → must be in participants or FORBIDDEN
   - open, first post → proposal created, status: "proposed" returned
   - open, known agent → auto-approved or standard whitelist

5. Message inserted → triggerA2AIResponse() fires asynchronously
   → Intelligence Hub receives the message → LLM responds
   → Assistant message saved to channel

6. OpenClaw polls for response:
   POST {podUrl}/trpc/hubProtocol.channels.pollA2AIChannel
   → { channelId, since: ISO timestamp, limit: 20 }
   → returns new messages since last poll
```

---

## 7. OpenClaw — The World Interface

### What OpenClaw Is

[OpenClaw](https://github.com/openclaw/openclaw) is an open-source Node.js AI agent (formerly Clawdbot → Moltbot). It provides:

- **25 native tools**: shell execution, filesystem I/O, browser automation (Playwright), cron scheduling, session management, HTTP calls
- **13 messaging channels**: Telegram, WhatsApp, Slack, Discord, iMessage, Teams, SMS, email, and more
- **5,700+ community skills** on ClawHub — skills are SKILL.md files (YAML frontmatter + markdown instructions)
- **MCP server**: exposes all tools via `GET /mcp` using the Streamable HTTP transport
- **OpenAI-compatible endpoint**: accepts `POST /v1/chat/completions` — used by Synap's outbound relay

### How OpenClaw Connects to Synap

**Direction 1 — OpenClaw → Synap (via Hub Protocol)**

OpenClaw uses a Hub Protocol API key (`SYNAP_HUB_API_KEY`) to call Synap endpoints. This is how it writes data into Synap: creating channels, posting messages, creating entities from external conversations.

**Direction 2 — Synap AI → OpenClaw tools (via MCP)**

When OpenClaw registers as an intelligence service with an `mcpEndpoint`, the Intelligence Hub automatically connects to that MCP server before each LLM request. Synap's AI can then call OpenClaw's tools like any other tool — `openclaw_shell`, `openclaw_browser`, `openclaw_send_telegram`.

These are **opposite directions** and serve different purposes:

```
OpenClaw → Hub Protocol → Synap    (writing data INTO the workspace)
Synap AI → MCP Client  → OpenClaw  (CALLING tools that do things in the world)
```

### Provisioning Flow

```
Control Plane: POST /openclaw/provision
└─ Validate pod exists
└─ Generate Hub Protocol API key (scope: hub-protocol.read + hub-protocol.write)
└─ Store as intelligence_service record with mcpEndpoint
└─ Add OpenClaw container to pod's docker-compose
   └─ Env: SYNAP_POD_URL, SYNAP_HUB_API_KEY, SYNAP_WORKSPACE_ID
└─ Return { status: "provisioning", serviceId }

Control Plane: GET /openclaw/status?podId=X  (poll until ready)
└─ Returns: provisioning → installing_skill → ready

POST /openclaw/register (self-hosted path, or after cloud provisioning)
└─ Health check: GET {openclawUrl}/health → must return 200
└─ Register on pod: POST {podUrl}/trpc/intelligenceRegistry.register
   └─ capabilities: ["chat", "shell", "browser", "filesystem", "channels", ...]
   └─ mcpEndpoint: "{openclawUrl}/mcp"
└─ Create Hub API key: POST {podUrl}/trpc/apiKeys.create
└─ Return: { serviceId, url, hubApiKey, skillInstallCommand }
```

### What OpenClaw Enables

Once connected, Synap gains these capabilities through the AI:

| Tool                        | What the LLM can do                                |
| --------------------------- | -------------------------------------------------- |
| `openclaw_shell`            | Run shell commands on the pod server               |
| `openclaw_browser`          | Browse websites, take screenshots, fill forms      |
| `openclaw_filesystem_read`  | Read files on the pod server                       |
| `openclaw_filesystem_write` | Write files (governed — workspace or system scope) |
| `openclaw_send_telegram`    | Send Telegram messages on behalf of the user       |
| `openclaw_send_slack`       | Post to Slack channels                             |
| `openclaw_send_whatsapp`    | Send WhatsApp messages                             |
| `openclaw_cron_create`      | Schedule recurring tasks                           |
| Community skills            | Any of 5,700+ skills installed by user             |

---

## 8. External Messaging — Telegram First

### The Relay Architecture

External messaging connects Synap to real-world communication platforms. The pattern uses **EXTERNAL_IMPORT** channels as the bridge:

```
Telegram → OpenClaw (webhook) → Hub Protocol sendExternalMessage → Synap channel
                                                                        ↓
                                                               Synap IS responds
                                                                        ↓
Telegram ← OpenClaw (outbound relay) ← relayToExternalChannel ← assistant message
```

### Inbound Path (Telegram → Synap)

1. A Telegram message arrives at OpenClaw's webhook
2. OpenClaw's AI (instructed by the `synap-os` skill) calls:
   ```
   POST {podUrl}/trpc/hubProtocol.channels.sendExternalMessage
   {
     agentUserId, workspaceId,
     externalSource: "telegram",
     externalChannelId: "tg_chat_1234567",
     senderName: "Alice",
     content: "Hey, can you check that report?",
   }
   ```
3. Backend finds the existing EXTERNAL_IMPORT channel (by `externalSource + externalChannelId`)
   — if none found, returns `{ status: "no_channel" }` → OpenClaw then calls `createExternalChannel` to propose creating a new one
4. Message inserted into channel with `role: USER, authorType: EXTERNAL`
5. `sendMessage` procedure picks it up, calls Intelligence Hub, gets response

### Outbound Path (Synap → Telegram)

After the Intelligence Hub responds and the assistant message is saved, `channels.ts` checks:

```typescript
if (channel.channelType === ChannelType.EXTERNAL_IMPORT &&
    channel.externalSource && channel.externalChannelId && fullContent) {
  relayToExternalChannel({ ... }).catch(logger.error);
}
```

`relayToExternalChannel` resolves the active OpenClaw service and calls:

```
POST {openclawEndpoint}/v1/chat/completions
Headers: x-openclaw-session-key: tg_chat_1234567
         x-openclaw-platform: telegram
Body: { messages: [{ role: "assistant", content: "Here is the report..." }] }
```

OpenClaw recognizes the session key, looks up the Telegram chat, and delivers the message.

### New Contact Flow

For the first message from a new contact, `createExternalChannel` (Hub Protocol) creates a governance proposal. The user sees it in their inbox:

> **Proposal**: Allow Telegram conversation with Alice (+1-555-0100) to be created as a Synap channel?

Once approved, future messages from Alice auto-route without proposals.

---

## 9. MCP — Tool Discovery Standard

**Model Context Protocol** (MCP) is the industry standard for tool exposure to LLMs. Announced by Anthropic in November 2024, it has since been adopted by OpenAI, Google, Microsoft, and AWS. Donated to Linux Foundation in December 2025. 97M monthly SDK downloads, 10,000+ servers.

### How Synap Uses MCP

Synap's Intelligence Hub acts as an **MCP client**. When processing a message, it connects to all configured MCP servers and makes their tools available to the LLM.

The `mcpServers` array is dynamically assembled per-request in `channels.ts`:

```typescript
// From workspace settings
const mcpServers = resolvedService.mcpServers || [];

// Auto-inject registered intelligence service MCP endpoints
if (resolvedService.mcpEndpoint) {
  mcpServers.push({
    id: resolvedService.serviceId,
    transport: "http",
    url: resolvedService.mcpEndpoint,
  });
}
```

### MCP Client Connection Management

The Intelligence Hub's `McpClientManager` handles connection pooling:

- **Lazy establishment**: connections are created on first use, not at startup
- **Caching**: keyed by server config (transport + url/command) — same server reused across requests in the same process
- **Transport support**: `stdio` (spawns a subprocess) and `http` (Streamable HTTP transport)
- **Lifecycle**: `evictServer(id)` for config changes, `cleanupAllMcpConnections()` on graceful shutdown
- **Enabled flag**: each `McpServerConfig.enabled` — disabled servers are skipped without deletion

### MCP Tool Naming Convention

All MCP-adapted tools follow the pattern `mcp_{serverId}_{toolName}`:

- Example: `mcp_playwright_navigate`, `mcp_openclaw_shell`, `mcp_whatsapp_sendMessage`
- Prevents collision with native Synap tools
- JSON Schema inputs are converted to Zod schemas for input validation
- MCP tools default to `category: "context"` — auto-approved in the governance whitelist

### Extending with MCP Servers

Because Synap uses MCP as its tool protocol, any existing MCP server can be added to a workspace's `mcpServers` configuration and the AI immediately gains access to its tools:

| MCP Server                                | What it adds                              |
| ----------------------------------------- | ----------------------------------------- |
| `@playwright/mcp` (Microsoft)             | Browser automation via accessibility tree |
| `@modelcontextprotocol/server-filesystem` | Scoped filesystem access                  |
| `mcp-server-git`                          | Git operations                            |
| `@modelcontextprotocol/server-postgres`   | Direct DB queries                         |
| WhatsApp MCP (lharries)                   | WhatsApp conversations                    |
| Slack official MCP                        | Slack read/write                          |
| Any OpenClaw tool via MCP                 | All 25 OpenClaw native tools              |

This means OpenClaw is not the only path to external tools — it's the first and most capable, but the architecture supports any MCP server transparently.

### Exposing Synap as an MCP Server (Future)

The reverse is also possible: Synap can expose its own MCP server, allowing Claude Desktop, Cursor, ChatGPT, or any MCP client to read and write Synap workspace data. This would make Synap a data layer for any AI tool, not just its own.

---

## 10. Governance — Every Write is Governed

### The Principle

No external agent can write to Synap without going through `checkPermissionOrPropose`. This is not optional — it is enforced at the Hub Protocol middleware level for all write calls.

### Permission Result States

```typescript
type PermissionResult =
  | { type: "granted" } // Proceed immediately
  | { type: "proposed"; proposalId: string } // User must approve
  | { type: "denied"; reason: string }; // Hard block — no proposal
```

### The Default Auto-Approve Whitelist

These actions are auto-approved for any Hub Protocol caller (unless workspace overrides):

```typescript
const DEFAULT_AUTO_APPROVE = [
  "search.*", // All searches
  "memory.recall", // Memory reads
  "entity.read", // Reading entities
  "document.read", // Reading documents
  "context.*", // All context reads
  "filesystem.read", // Reading files
  "filesystem.write_workspace", // Writing to ~/openclaw/workspace/**
];
```

Workspaces can expand this list via `workspace.settings.autoApproveFor` — e.g. adding `"a2ai.*"` to allow agents to join A2AI channels without proposals.

### Filesystem Governance

Filesystem actions have a path-level blocklist that fires **before** any role or whitelist check:

```typescript
const BLOCKED_FILESYSTEM_PATHS = [
  /synap[-_]backend/i, // Never touch synap code
  /synap[-_]intelligence/i,
  /synap[-_]realtime/i,
  /docker-compose/i, // Never touch docker configs
  /\.env(?:\.|$)/, // Never touch env files
  /^\/etc\//, // System directories
  /^\/usr\//,
  /^\/bin\//,
  /^\/root\//,
  /private\.key/i, // Private keys
  /\.pem$/i,
  /id_rsa/i,
];
```

If the path matches, the action is **denied** — not proposed. No user action can override a hard block.

### Proposal Inbox

When an action creates a proposal, the user sees it in their Synap inbox. They can approve or reject. Approved proposals execute the original action. Rejected proposals notify the agent.

Proposals are linked to the triggering message (`sourceMessageId`) so users have full context: "The AI tried to do X while responding to your message Y."

### Agent Users

Every AI agent that acts in a workspace is represented as a `users` table row:

```
users.userType = "agent"
users.email    = "agent-default-abc123@synap.agent"
users.agentMetadata.createdByUserId = "human-user-uuid"
```

Agents are workspace members with roles (editor by default). This means all RBAC checks apply to agents exactly as they apply to humans. There is no special "AI bypass" path.

---

## 11. The Synap OS Skill — Teaching OpenClaw

`synap-backend/skills/synap-os/SKILL.md` is the bridge between OpenClaw and Synap. It's a SKILL.md file (YAML frontmatter + markdown instructions) that teaches OpenClaw:

1. **Its identity** — "You are connected to a Synap workspace. Use Hub Protocol to interact with workspace data."
2. **What to auto-approve** — Search, read, memory recall. No proposal needed.
3. **What requires governance** — Creating entities, sending messages to new contacts, writing files outside the workspace directory.
4. **How to handle Telegram messages** — The inbound relay workflow.
5. **A2AI channel protocol** — How to post to and poll from A2AI channels.
6. **Filesystem rules** — Only `~/openclaw/workspace/**` without a proposal.

Installation:

```bash
openclaw skill install https://raw.githubusercontent.com/synap-app/synap-backend/main/skills/synap-os/SKILL.md
```

This is the "configuration as instruction" pattern. Rather than building a custom SDK, the skill teaches OpenClaw's general-purpose LLM to behave correctly when interacting with Synap.

---

## 12. Extending to Other Intelligence Services

### The Intelligence Registry

Any intelligence service can register with Synap:

```typescript
trpc.intelligenceRegistry.register({
  serviceId: "my-custom-agent",
  name: "Custom Research Agent",
  webhookUrl: "https://my-agent.example.com",
  apiKey: "...",
  capabilities: ["chat", "research", "data-analysis"],
  mcpEndpoint: "https://my-agent.example.com/mcp", // optional
});
```

Once registered, the intelligence routing system can route workspace messages to this service based on capability matching. Workspaces can configure which service to use for which capability.

### The ServiceCard / ServiceChip Pattern (Frontend)

The `@synap/agent-service` package provides:

- `WELL_KNOWN_SERVICES` — curated metadata for `default` (Synap IS) and `openclaw`
- `useAgentServices()` — returns `{ connectedServices, addOnCandidates }`
- `ServiceCard` — generic UI card for ConnectionsTab (built-in / add-on / activate / custom modes)
- `ServiceChip` — header chip showing service status

Adding a new intelligence service to the UI requires only adding an entry to `WELL_KNOWN_SERVICES`. The connection, activation, and status flows are handled generically.

### The MCP-First Principle

New external tool capabilities should be delivered via MCP servers, not via custom Hub Protocol procedures. This is because:

1. **MCP is the standard** — Any MCP server (open source, commercial, community) works immediately
2. **No backend code changes** — A new MCP server in `mcpServers` config is all that's needed
3. **LLM tool selection is automatic** — The LLM discovers tools from the MCP manifest and uses them contextually
4. **10,000+ servers already exist** — Browser, filesystem, git, databases, Slack, Telegram, WhatsApp — all available

Hub Protocol procedures are for **governance-critical writes** (creating workspace data, approving actions). Tool execution is MCP.

### Extending to Other Messaging Platforms

The external messaging architecture generalizes beyond Telegram:

1. Choose a platform (WhatsApp, Slack, Discord, Signal)
2. Configure OpenClaw to connect to that platform
3. Update the `synap-os` skill with platform-specific relay instructions
4. The rest of the architecture — EXTERNAL_IMPORT channels, relay, governance — works identically

The only new code needed per platform is the human-readable label and icon in the frontend (`PLATFORM_LABELS`, `PLATFORM_ICONS` in `ChatHeader.tsx`).

---

## 13. What Was Built — Implementation Summary

This section documents the specific code artifacts created or modified in the OpenClaw × Synap integration (February 2026).

### Schema Changes

**`synap-backend/packages/database/src/schema/channels.ts`**

- Added `ChannelType.A2AI = "a2ai"` to the enum and column definition
- Documented the A2AI channel type in JSDoc

**`synap-backend/packages/database/migrations-custom/0041_a2ai_channels.sql`**

- Comment-only migration (no ALTER TYPE needed — `channel_type` is a text column)
- Documents the A2AI metadata structure and valid values

### Backend — New Procedures

**`synap-backend/packages/api/src/routers/channels.ts`**

- `createA2AIChannel` — workspace procedure to create A2AI channels
- `relayToExternalChannel` — async helper for outbound external messaging
- Outbound relay call in `sendMessage` (EXTERNAL_IMPORT channels)

**`synap-backend/packages/api/src/routers/hub-protocol/channels.ts`** — rewritten with 4 new Hub Protocol procedures:

- `sendExternalMessage` — hot path for ongoing external conversations (Telegram/WhatsApp → Synap)
- `postToA2AIChannel` — external agent posts to A2AI channel with governance
- `pollA2AIChannel` — poll for new messages since timestamp
- `listA2AIChannels` — discover A2AI channels for a workspace

**`synap-backend/packages/api/src/utils/permission-check.ts`**

- `BLOCKED_FILESYSTEM_PATHS` — hard-blocked path regex list
- Extended `DEFAULT_AUTO_APPROVE` with `"filesystem.read"` and `"filesystem.write_workspace"`
- Path blocklist check fires before any role/whitelist check

### Infrastructure

**`synap-backend/deploy/docker-compose.yml`**

- Added commented OpenClaw service template (enabled by provisioning)
- Added `openclaw_config` and `openclaw_workspace` volumes

**`synap-control-plane-api/src/routes/openclaw.ts`**

- `POST /openclaw/provision` — start cloud-managed OpenClaw
- `POST /openclaw/register` — register self-hosted OpenClaw instance
- `GET /openclaw/status` — poll provisioning status
- `DELETE /openclaw/deprovision` — remove OpenClaw instance

### Intelligence

**`synap-backend/skills/synap-os/SKILL.md`**

- Complete skill file teaching OpenClaw to use Synap's Hub Protocol
- Covers read ops, write ops (governance), external relay, A2AI channels, filesystem rules

### Frontend

**`synap-app/packages/core/ui-system/src/components/ChannelTypeBadge.tsx`**

- Added `"a2ai"` channel type with `Network` icon (green, emerald theme)

**`synap-app/packages/features/ai-chat/src/components/ChatHeader.tsx`**

- A2AI badge: green Network icon + "A2A" label
- EXTERNAL_IMPORT platform badge: `PLATFORM_ICONS` + `PLATFORM_LABELS` maps (Telegram, WhatsApp, Slack, Gmail, SMS)

**`synap-app/packages/core/channels/src/store/useChannelStore.ts`**

- Added `"a2ai"` to `ChannelTypeFilter` union

**`synap-app/packages/core/channels/src/components/ChannelList/ChannelList.tsx`**

- Added `"a2ai"` to filter logic, `FILTER_LABELS`, `FILTER_ORDER`

### Agent Types (Reference)

Agent types registered in `agent-registry.ts` and `tool-registry.ts`:

| Type                      | Description                       | Notes                                         |
| ------------------------- | --------------------------------- | --------------------------------------------- |
| `default`                 | General-purpose chat agent        | Full tool access                              |
| `meta`                    | Orchestration / routing decisions | Context tools only                            |
| `knowledge-search`        | Deep research and semantic search | Search + web + memory                         |
| `code`                    | Code writing and debugging        | Code tools + search                           |
| `writing`                 | Document writing and editing      | Document CRUD + context                       |
| `action`                  | Workflow execution                | Entity/document CRUD + proposals              |
| `onboarding`              | New user setup flows              | Workspace creation tools                      |
| `workspace-creation`      | Workspace scaffolding             | Workspace tools                               |
| `persona:cto`             | CTO persona                       | Default tools + CTO system prompt             |
| `persona:marketing`       | Marketing persona                 | Default tools + marketing system prompt       |
| `persona:sales`           | Sales persona                     | Default tools + sales system prompt           |
| `persona:project-manager` | PM persona                        | Default tools + PM system prompt              |
| `persona:research`        | Research persona                  | Search-focused tools + research system prompt |

Persona agents share the same tool access as `default` but carry persona-specific system prompt instructions. Users invoke them via `@cto`, `@marketing`, etc. in the chat input.

### MCP Validation (No New Code)

Confirmed that `intelligence_services.mcpEndpoint` flows through:

1. `intelligence-routing.ts` → `ResolvedService.mcpEndpoint`
2. `channels.ts sendMessage` → injected into `mcpServers` array
3. Intelligence Hub → connects to MCP server → LLM gains tools

OpenClaw's MCP tools become available to Synap's AI automatically on registration.

---

## 14. Design Decisions and Trade-offs

### Why Hub Protocol (not OAuth, not REST, not WebSocket)

Hub Protocol is tRPC — the same type-safe RPC system used throughout Synap. This means:

- External agents use the same API as internal consumers
- Type safety is maintained end-to-end (same Zod schemas)
- Governance (`checkPermissionOrPropose`) is applied uniformly at the procedure level
- No separate gateway to maintain

The trade-off: agents must speak tRPC JSON format. The `synap-os` skill and example curl commands in SKILL.md make this straightforward.

### Why OpenClaw as the First External Agent

OpenClaw is open-source (MIT), Node.js (compatible with the Synap stack), and has the widest messaging channel support available. Its creator joining OpenAI in February 2026 creates some governance uncertainty — but the MIT license means the project cannot be "taken private." The community fork path is clear if needed.

### Why Fire-and-Forget for A2AI Triggers

`triggerA2AIResponse` is called without `await` after an agent posts to an A2AI channel. This keeps the Hub Protocol response latency low (the agent gets an immediate `{ status: "sent" }` ack). The trade-off: if Intelligence Hub is temporarily unavailable, the A2AI response is dropped silently. A future improvement would queue the trigger in a job queue (PgBoss) for retry.

### Why A2AI Channels Are Text (Not PG Enum)

The `channel_type` column is a text column with a TypeScript enum — not a PostgreSQL `CREATE TYPE` enum. This means new channel types (like `a2ai`) can be added without a PostgreSQL `ALTER TYPE` migration. The trade-off is slightly weaker database-level constraint enforcement, but the TypeScript enum + Drizzle validation provides equivalent safety at the application layer.

### Why Telegram First (Not WhatsApp)

WhatsApp's unofficial Baileys library violates WhatsApp's Terms of Service and can result in account bans. WhatsApp official API requires Meta business verification (4–8 weeks) and charges per message ($0.01–0.06). Telegram is free, requires no approval, and can be set up in 1–3 days. The architecture is platform-agnostic — WhatsApp official can be added later by updating the `synap-os` skill.

---

## 15. Phase 2 — MCP Scoping & OpenClaw Co-Location (2026-02-27)

### MCP Server Sources

There are now two distinct sources of MCP tools, with different approval mechanisms:

| Source             | Storage                                   | How approved                                                                            | UI location                                               |
| ------------------ | ----------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| **Service MCPs**   | `intelligence_services.mcpEndpoint`       | `mcpApproved` boolean set by workspace admin via `trpc.intelligenceRegistry.approveMcp` | Intelligence App → Services tab → per-service MCP section |
| **Workspace MCPs** | `workspace.settings.mcpServers[]` (JSONB) | Adding to list = approval (editor+ role required)                                       | Workspace Settings → Intelligence → MCP Servers section   |

The Intelligence Hub merges both sources before each LLM request. Service MCPs that have `mcpApproved=false` are skipped even if the service is registered.

### Service MCP Approval Flow

```
Service registers with mcpEndpoint set
        │
        ├─ Via control-plane provisioning (OpenClaw, ZeroClaw)
        │    → mcpApproved = true  (auto — trusted path)
        │
        └─ Via manual registration
             → mcpApproved = false (requires workspace admin approval)
                    │
                    ▼
             Intelligence Settings → Services tab
             → MCPEndpointRow shows "PENDING APPROVAL" badge
             → Workspace editor/admin clicks "Approve"
             → trpc.intelligenceRegistry.approveMcp({ serviceId })
             → Approval is workspace-scoped (editor+ role in that workspace)
             → Each workspace independently approves/revokes MCP tools
             → mcpApproved = true
             → Badge switches to "APPROVED" (green)
```

**Revoking approval**: `trpc.intelligenceRegistry.revokeMcp` sets `mcpApproved=false`. Tools are no longer injected — the service itself remains active (chat/analysis capabilities unaffected).

### Workspace MCP Servers CRUD

`workspace.settings.mcpServers` is an array of `McpServerConfig` objects stored in the JSONB settings column. Two new tRPC procedures manage it:

```
trpc.workspaces.getMcpServers({ workspaceId })
  → McpServerConfig[]

trpc.workspaces.updateMcpServers({ workspaceId, servers: McpServerConfig[] })
  → { count: number }
  — requires editor+ role
  — uses JSONB merge: settings || '{"mcpServers": [...]}'::jsonb
```

The frontend (Intelligence Settings → MCP Servers section) provides:

- List view with transport type, URL/command, enabled badge
- "Test" button for HTTP servers: POST `{url}/tools/list` → shows tool count
- "Enable/Disable" toggle → calls `updateMcpServers` with updated `enabled` flag
- "Add Server" modal: transport selector (HTTP/stdio), ID, name, URL/command
- "Delete" button per server

### OpenClaw Default Co-Location

OpenClaw defaults to **off** on pod creation, controlled by the `OPENCLAW_DEFAULT_ENABLED` environment variable in the control plane (defaults to `"false"`). The `createPodSchema` accepts an explicit per-request override:

```typescript
addons: z.object({
  zeroclaw: z.boolean().optional().default(false),
  openclaw: z.boolean().optional(), // explicit override; falls back to OPENCLAW_DEFAULT_ENABLED
});
```

Pod creation logic: `body.addons?.openclaw ?? env.OPENCLAW_DEFAULT_ENABLED`. This means:

- **Default install**: OpenClaw **off** (zero unwanted provisioning costs)
- **SaaS operator opt-in**: set `OPENCLAW_DEFAULT_ENABLED=true` in control plane env to auto-provision for all new pods
- **Per-pod override**: pass `addons: { openclaw: true }` in the creation request
- **Users can always activate later**: Intelligence Settings → Available Connections → "Activate"

**Addon state machine** (`addons.openclaw.status`):

| Status         | Meaning                                                         |
| -------------- | --------------------------------------------------------------- |
| `provisioning` | Job enqueued, waiting for Docker pull + startup                 |
| `running`      | Healthy, MCP server available                                   |
| `stopped`      | Disabled by user (`PATCH /pods/:id/addons { openclaw: false }`) |
| `error`        | Provisioning failed (see job logs)                              |

### Shared Hub API Key Utility

`createHubApiKeyOnPod()` was extracted from `zeroclaw.ts` into `synap-control-plane-api/src/lib/hub-key.ts`:

```typescript
async function createHubApiKeyOnPod(
  podUrl: string,
  podApiKey: string,
  serviceId: string,
  serviceName: string
): Promise<string | null>;
```

Both OpenClaw and ZeroClaw provisioning use this shared utility. The function creates a Hub Protocol API key on the pod with scopes `["hub-protocol.read", "hub-protocol.write"]`.

### OpenClaw Provision Job (Trigger.dev)

`synap-control-plane-api/src/jobs/openclaw-provision.ts` is a Trigger.dev job scaffold:

1. Poll `http://openclaw:3050/health` up to 10 times (10s intervals)
2. Create Hub Protocol API key via `createHubApiKeyOnPod()`
3. Register OpenClaw on pod: `POST /trpc/hubProtocol.services.register`
4. Update `addons.openclaw.status = "running"` with `url` + `mcpEndpoint`

> TODO: Step 1 requires Docker deployment on pod server. A pod agent API will be added to handle Docker container lifecycle. The current job polls the internal address assuming OpenClaw is already running via docker-compose.

### Intelligence Settings Page Updates

The Intelligence Settings page (`/workspace/settings/intelligence/page.tsx`) now has:

1. **OpenClaw activation** — `ServiceCard` for `addOnCandidates` now has `onActivate`:
   - Calls `PATCH /pods/:id/addons { openclaw: true }` via `useUpdatePodAddons()` hook
   - Uses first pod from `usePods()` as the target pod
   - Toast on success: "OpenClaw activation started"

2. **Workspace MCP Servers section** — new `WorkspaceMcpServersSection` component:
   - Lists servers from `trpc.workspaces.getMcpServers`
   - Enable/disable toggle per server
   - Test button for HTTP servers
   - Delete button per server
   - "Add Server" modal with transport type selector
