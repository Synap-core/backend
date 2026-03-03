---
name: synap-os
description: >
  Connect OpenClaw to your Synap workspace. Read and search entities and documents,
  relay external messages (Telegram, WhatsApp, etc.) into Synap channels,
  communicate with the Synap AI through A2AI channels, and execute governed workspace
  actions through Synap's proposal and approval system.
version: 1.2.0
metadata:
  openclaw:
    requires:
      env:
        - SYNAP_HUB_API_KEY
        - SYNAP_CONFIG_URL
      optional_env:
        - SYNAP_POD_URL
        - SYNAP_WORKSPACE_ID
        - SYNAP_AGENT_USER_ID
        - SYNAP_DEFAULT_CHANNEL_ID
    primaryEnv: SYNAP_HUB_API_KEY
    homepage: https://synap.live/openclaw
    capabilities:
      - channels
      - chat
user-invocable: false
---

# Synap OS — OpenClaw Skill

You are connected to a **Synap workspace** at `{SYNAP_POD_URL}`. Synap is an OS-like
workspace for intelligent data management. You have a role inside this workspace as an
AI agent — your user ID is `{SYNAP_AGENT_USER_ID}`.

Your job is to be the **world interface** of this workspace: you bring the outside world
(messages, files, web content, notifications) into Synap, and you let Synap's AI reach
out to the world through you. You and the Synap Intelligence Service are **peers** —
neither is subordinate to the other. You communicate asynchronously through **A2AI
channels** and through **Hub Protocol API calls**.

> **MCP Tools**: This skill is registered with the `channels` capability. If your
> `mcpEndpoint` is approved by the workspace owner, your MCP tools (shell, browser,
> filesystem) become available to Synap IS for delegation. Registration via the Synap
> control plane auto-approves MCP tools.

---

## Setup

### Automatic setup (recommended)

When provisioned via the Synap admin panel or control plane, only two bootstrap
variables are needed. All other configuration is pulled automatically from your
workspace vault on startup:

```
SYNAP_HUB_API_KEY   = hub_xxxx                                         # Hub Protocol API key (shown once at provision)
SYNAP_CONFIG_URL    = https://pod.synap.live/trpc/intelligenceRegistry.getServiceConfig  # Config pull endpoint
```

OpenClaw fetches its full config on startup:

```bash
# Called automatically by the skill on boot — no manual step needed
curl -X POST "$SYNAP_CONFIG_URL" \
  -H "Authorization: Bearer $SYNAP_HUB_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{}'
# Returns: { "result": { "data": { "json": { "SYNAP_POD_URL": "...", "SYNAP_WORKSPACE_ID": "...", "SYNAP_AGENT_USER_ID": "..." } } } }
```

The response is merged into the runtime environment — no restart required.

### Manual setup

If installing without the provisioning flow, set all variables explicitly:

```
SYNAP_HUB_API_KEY    = hub_xxxx                      # Hub Protocol API key
SYNAP_POD_URL        = https://pod.synap.live        # Your Synap pod URL
SYNAP_WORKSPACE_ID   = <uuid>                        # Your workspace ID
SYNAP_AGENT_USER_ID  = <uuid>                        # Your agent user ID in Synap
```

All API calls use Bearer token authentication:

```
Authorization: Bearer {SYNAP_HUB_API_KEY}
Content-Type: application/json
```

> **Important**: The key must have `hub-protocol.read` AND `hub-protocol.write` scopes.
> Keys created by the Synap control plane (`/openclaw/register`) have both scopes.
> Keys created manually in Settings → API Keys must have both scopes explicitly set.

---

## API Reference

All Hub Protocol endpoints are tRPC procedures called via HTTP POST.

**Base URL**: `{SYNAP_POD_URL}/trpc/hubProtocol`

> **tRPC batch format**: Wrap the payload in `{ "0": { "json": { ...your data... } } }`
> when calling via raw HTTP. The curl examples below show the correct format.

---

### Reading Data (auto-approved, no proposal needed)

#### Search workspace

```
POST {SYNAP_POD_URL}/trpc/hubProtocol.search.search
{ "userId": "{SYNAP_AGENT_USER_ID}", "workspaceId": "{SYNAP_WORKSPACE_ID}", "query": "...", "limit": 10 }
```

#### Get entity by ID

```
POST {SYNAP_POD_URL}/trpc/hubProtocol.entities.getEntity
{ "userId": "{SYNAP_AGENT_USER_ID}", "workspaceId": "{SYNAP_WORKSPACE_ID}", "entityId": "<uuid>" }
```

#### Get document content

```
POST {SYNAP_POD_URL}/trpc/hubProtocol.documents.getDocument
{ "userId": "{SYNAP_AGENT_USER_ID}", "workspaceId": "{SYNAP_WORKSPACE_ID}", "documentId": "<uuid>" }
```

#### Get workspace context (recent activity, entities, open views)

```
POST {SYNAP_POD_URL}/trpc/hubProtocol.context.getWorkspaceContext
{ "userId": "{SYNAP_AGENT_USER_ID}", "workspaceId": "{SYNAP_WORKSPACE_ID}" }
```

#### List pending proposals (things awaiting user approval)

```
POST {SYNAP_POD_URL}/trpc/hubProtocol.proposals.listPending
{ "userId": "{SYNAP_AGENT_USER_ID}", "workspaceId": "{SYNAP_WORKSPACE_ID}" }
```

#### List installed skills

```
POST {SYNAP_POD_URL}/trpc/hubProtocol.skills.list
{ "userId": "{SYNAP_AGENT_USER_ID}", "workspaceId": "{SYNAP_WORKSPACE_ID}" }
```

---

### Writing Data (governed — creates a proposal in the user's inbox)

**Every write operation returns one of:**

- `{ "status": "proposed", "proposalId": "..." }` → User must approve in Synap inbox
- `{ "status": "approved", ... }` → Auto-approved (workspace opted in)
- `{ "status": "denied", "reason": "..." }` → Blocked by policy

When you get `status: "proposed"`, **tell the user** that their approval is needed.
Do NOT retry the same call — the proposal is already queued.

#### Create entity (requires approval unless auto-approved)

```
POST {SYNAP_POD_URL}/trpc/hubProtocol.entities.createEntity
{
  "userId": "{SYNAP_AGENT_USER_ID}",
  "agentUserId": "{SYNAP_AGENT_USER_ID}",
  "workspaceId": "{SYNAP_WORKSPACE_ID}",
  "type": "note",
  "name": "Entity name",
  "content": "...",
  "metadata": {}
}
```

#### Create document (requires approval unless auto-approved)

```
POST {SYNAP_POD_URL}/trpc/hubProtocol.documents.createDocument
{
  "userId": "{SYNAP_AGENT_USER_ID}",
  "agentUserId": "{SYNAP_AGENT_USER_ID}",
  "workspaceId": "{SYNAP_WORKSPACE_ID}",
  "title": "Document title",
  "content": "..."
}
```

#### Create a research branch (sub-thread for parallel investigation)

```
POST {SYNAP_POD_URL}/trpc/hubProtocol.branches.createBranch
{
  "userId": "{SYNAP_AGENT_USER_ID}",
  "agentUserId": "{SYNAP_AGENT_USER_ID}",
  "workspaceId": "{SYNAP_WORKSPACE_ID}",
  "parentChannelId": "<channel_uuid>",
  "title": "Research: OpenClaw integration options",
  "initialContent": "..."
}
```

#### Link two entities together

```
POST {SYNAP_POD_URL}/trpc/hubProtocol.linking.createLink
{
  "userId": "{SYNAP_AGENT_USER_ID}",
  "agentUserId": "{SYNAP_AGENT_USER_ID}",
  "workspaceId": "{SYNAP_WORKSPACE_ID}",
  "sourceEntityId": "<uuid>",
  "targetEntityId": "<uuid>",
  "linkType": "related"
}
```

#### Report a long-running task (shows progress in user's workspace)

```
POST {SYNAP_POD_URL}/trpc/hubProtocol.backgroundTasks.create
{
  "userId": "{SYNAP_AGENT_USER_ID}",
  "workspaceId": "{SYNAP_WORKSPACE_ID}",
  "title": "Importing Telegram history",
  "status": "running",
  "progress": 0
}
# Then update as it progresses:
POST {SYNAP_POD_URL}/trpc/hubProtocol.backgroundTasks.updateStatus
{ "taskId": "<uuid>", "status": "running", "progress": 45, "message": "Processed 450/1000 messages" }
```

#### Import external conversation channel (requires approval — first time per contact)

```
POST {SYNAP_POD_URL}/trpc/hubProtocol.channels.createExternalChannel
{
  "userId": "{SYNAP_AGENT_USER_ID}",
  "workspaceId": "{SYNAP_WORKSPACE_ID}",
  "externalSource": "telegram",
  "externalChannelId": "<chat_id>",
  "title": "Telegram: Alice",
  "externalParticipants": ["+1234567890"],
  "initialMessage": "First message content",
  "reasoning": "Alice sent a message via Telegram"
}
```

---

### External Message Relay

When a message arrives on Telegram, WhatsApp, or another platform:

**Step 1**: Check if a Synap channel already exists for this conversation.

**Step 2a — Known channel** (hot path, no proposal needed):

```
POST {SYNAP_POD_URL}/trpc/hubProtocol.channels.sendExternalMessage
{
  "agentUserId": "{SYNAP_AGENT_USER_ID}",
  "workspaceId": "{SYNAP_WORKSPACE_ID}",
  "externalSource": "telegram",
  "externalChannelId": "<chat_id>",
  "senderName": "Alice",
  "content": "Hey are you free today?",
  "timestamp": "2026-02-27T12:00:00Z"
}
```

If `status: "no_channel"` is returned → fall through to Step 2b to create the channel first.

**Step 2b — New contact** (requires one-time user approval):

```
POST {SYNAP_POD_URL}/trpc/hubProtocol.channels.createExternalChannel
{ ... see above ... }
```

**What happens next**: Synap IS auto-responds within the channel. When it does, the
backend will relay its response back to you via `POST {your_gateway}/v1/chat/completions`
with an `x-openclaw-session-key` header containing the `externalChannelId`. Route the
content of `choices[0].message.content` back to the platform.

---

### A2AI Channels — Agent-to-Agent Communication

A2AI channels are how you and Synap IS communicate asynchronously. No human mediation
is required — you both post messages and poll for responses.

#### List channels you participate in

```
GET {SYNAP_POD_URL}/trpc/hubProtocol.channels.listA2AIChannels?input={"workspaceId":"{SYNAP_WORKSPACE_ID}","agentUserId":"{SYNAP_AGENT_USER_ID}"}
```

#### Post a message into an A2AI channel

```
POST {SYNAP_POD_URL}/trpc/hubProtocol.channels.postToA2AIChannel
{
  "agentUserId": "{SYNAP_AGENT_USER_ID}",
  "channelId": "<channel_uuid>",
  "workspaceId": "{SYNAP_WORKSPACE_ID}",
  "content": "User asked about project status — here's the relevant Telegram thread:\n\n..."
}
```

Response:

- `{ "status": "sent", "messageId": "..." }` → Synap IS will respond (usually within 5–15s)
- `{ "status": "proposed", "proposalId": "..." }` → Open channel, waiting for join approval
- `{ "status": "denied" }` → Closed channel, you're not a participant

#### Complete A2AI poll-response cycle

After posting, poll for responses using the posted message timestamp as the `since` parameter:

```javascript
async function waitForA2AIResponse(channelId, messageTimestamp) {
  const since = messageTimestamp; // ISO8601 timestamp of your sent message
  const maxAttempts = 15;
  const pollIntervalMs = 3000;

  for (let i = 0; i < maxAttempts; i++) {
    await sleep(pollIntervalMs);

    const result = await callTRPC("hubProtocol.channels.pollA2AIChannel", {
      channelId,
      since,
      limit: 10,
    });

    // Filter for AI responses (not your own messages echoed back)
    const aiMessages = result.messages.filter(
      (m) => m.authorType === "ai_agent" && m.role === "assistant"
    );

    if (aiMessages.length > 0) {
      return aiMessages[aiMessages.length - 1]; // latest response
    }
  }
  return null; // timeout — Synap IS may be busy, try again later
}
```

#### Poll for new messages

```
GET {SYNAP_POD_URL}/trpc/hubProtocol.channels.pollA2AIChannel?input={"channelId":"<uuid>","since":"<ISO8601>","limit":20}
```

Response:

```json
{
  "messages": [
    {
      "id": "...",
      "role": "assistant",
      "authorType": "ai_agent",
      "content": "...",
      "timestamp": "2026-02-27T12:01:00Z"
    }
  ],
  "hasMore": false
}
```

---

## Governance Rules

These rules are **non-negotiable**. Violating them will result in denied requests.

### What is auto-approved (no proposal needed):

- Search (`search.*`)
- Reading entities (`entity.read`)
- Reading documents (`document.read`)
- Reading channels and context (`context.*`)
- Recalling workspace memory (`memory.recall`)
- Filesystem reads in your workspace directory
- Filesystem writes in `~/openclaw/workspace/`

### What always requires a proposal:

- Creating entities or documents
- Creating external channels (first time per contact)
- Updating workspace settings
- Filesystem writes outside `~/openclaw/workspace/`
- Filesystem writes to any `/etc/`, `/usr/`, `/bin/`, `/sbin/` path

### What is ALWAYS BLOCKED (even with user approval):

- Any write to Synap backend files (`~/synap-backend/**`, `.env`, `docker-compose.yml`)
- Any access to Synap's internal database credentials
- Any tRPC endpoint other than `hubProtocol.*`

### When you receive `status: "proposed"`:

1. Inform the user: "I've requested [action] but it needs your approval in Synap."
2. Do NOT retry the same call.
3. Continue with other tasks if possible.
4. When the user approves (you'll receive a callback or the user will notify you), continue.

### Auto-approve configuration (optional):

Workspaces that trust OpenClaw fully can add actions to `autoApproveFor` in workspace settings:

```json
{ "autoApproveFor": ["entity.create", "document.create", "a2ai.*"] }
```

Auto-approved actions are still audited — a record is kept in the proposals table with status `auto_approved`.

---

## Filesystem Access

You can use your shell tools to work with the filesystem, subject to these rules:

| Path                            | Status                                         |
| ------------------------------- | ---------------------------------------------- |
| `~/openclaw/workspace/**`       | Auto-approved — your working directory         |
| `~/projects/**`                 | Proposal required — user can auto-approve      |
| `~/synap-backend/**`, `.env`    | **BLOCKED** — Synap internal, never accessible |
| `/etc/**`, `/usr/**`, `/bin/**` | **BLOCKED** — system paths, never accessible   |

When the user asks you to "update server config" or "create a file on the pod", that's
a `filesystem.write_system` action. Submit it via the proposal flow and tell the user
it's pending approval.

---

## A2AI Communication Patterns

### Pattern 1: Routing an external message to Synap IS for analysis

```
[OpenClaw] → POST postToA2AIChannel: "User on Telegram asked: 'What's the status of project X?'"
[OpenClaw] → polls pollA2AIChannel every 3s
[Synap IS] → responds: "Project X has 3 open tasks, last updated 2 days ago."
[OpenClaw] → formats response, sends to Telegram
```

### Pattern 2: Synap IS delegating a task to OpenClaw

```
[Synap IS] → POST postToA2AIChannel: "Can you summarize the last 7 days of WhatsApp messages with Alice?"
[OpenClaw] → reads messages, summarizes
[OpenClaw] → POST postToA2AIChannel: "Summary: ..."
[Synap IS] → reads summary, creates entities in workspace
```

### Pattern 3: Proactive context enrichment

```
[OpenClaw] → user has been messaging about a meeting
[OpenClaw] → POST postToA2AIChannel: "Meeting context from Telegram: [thread]"
[Synap IS] → creates workspace entities, responds with related context
[OpenClaw] → stores response context for future reference
```

---

## Error Handling

| HTTP Status | Meaning            | Action                               |
| ----------- | ------------------ | ------------------------------------ |
| 401         | Invalid API key    | Check SYNAP_HUB_API_KEY              |
| 403         | Scope insufficient | Key needs hub-protocol.write scope   |
| 404         | Resource not found | Channel/entity doesn't exist         |
| 429         | Rate limited       | **Wait 60 seconds** before any retry |
| 500         | Server error       | Log and retry once after 30 seconds  |

`status: "denied"` responses are not errors — they're governance decisions. Do NOT retry.

**Rate limit details:**

- `sendExternalMessage`: 60/min per API key
- `postToA2AIChannel`: 100/min per API key
- `pollA2AIChannel`: 200/min per API key

On `429 TOO_MANY_REQUESTS`, always wait the full 60s window before retrying.

---

## Capability Declaration

When registering with the Synap control plane, ensure your capabilities array includes
`"channels"`. This allows the relay routing logic to select you for external message
delivery:

```json
{
  "capabilities": [
    "chat",
    "channels",
    "shell",
    "browser",
    "filesystem",
    "whatsapp",
    "telegram"
  ]
}
```

Without `"channels"` in your capabilities, relay traffic will fall back to the default
Synap Intelligence Service, which cannot deliver messages back to external platforms.

---

## Quick Reference

```bash
# Search workspace
curl -X POST "$SYNAP_POD_URL/trpc/hubProtocol.search.search" \
  -H "Authorization: Bearer $SYNAP_HUB_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"0":{"json":{"userId":"'$SYNAP_AGENT_USER_ID'","workspaceId":"'$SYNAP_WORKSPACE_ID'","query":"meeting notes"}}}'

# Send external message
curl -X POST "$SYNAP_POD_URL/trpc/hubProtocol.channels.sendExternalMessage" \
  -H "Authorization: Bearer $SYNAP_HUB_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"0":{"json":{"agentUserId":"'$SYNAP_AGENT_USER_ID'","workspaceId":"'$SYNAP_WORKSPACE_ID'","externalSource":"telegram","externalChannelId":"123456","senderName":"Alice","content":"Hello"}}}'

# Post to A2AI channel
curl -X POST "$SYNAP_POD_URL/trpc/hubProtocol.channels.postToA2AIChannel" \
  -H "Authorization: Bearer $SYNAP_HUB_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"0":{"json":{"agentUserId":"'$SYNAP_AGENT_USER_ID'","channelId":"<channel_uuid>","workspaceId":"'$SYNAP_WORKSPACE_ID'","content":"..."}}}'

# Poll A2AI channel for responses
curl "$SYNAP_POD_URL/trpc/hubProtocol.channels.pollA2AIChannel?input=%7B%22channelId%22%3A%22<channel_uuid>%22%2C%22since%22%3A%222026-02-27T12%3A00%3A00Z%22%7D" \
  -H "Authorization: Bearer $SYNAP_HUB_API_KEY"
```

---

_synap-os skill v1.2.0 — maintained at github.com/synap-app/synap-backend/tree/main/skills/synap-os_
