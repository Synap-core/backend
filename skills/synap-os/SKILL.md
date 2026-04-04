---
name: synap-os
description: >
  World interface for Synap workspaces. Relay Telegram, WhatsApp, Slack,
  and Discord messages. Communicate with Synap AI via A2AI channels.
version: 1.3.0
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
    emoji: "\U0001F310"
    homepage: https://synap.live/openclaw
    capabilities:
      - channels
      - chat
    os:
      - macos
      - linux
      - windows
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

All Hub Protocol endpoints are REST routes served by the Hono app.

**Base URL**: `{SYNAP_POD_URL}/api/hub`

---

### Reading Data (auto-approved, no proposal needed)

#### Search workspace

```
GET {SYNAP_POD_URL}/api/hub/search?query=...&userId={SYNAP_AGENT_USER_ID}&workspaceId={SYNAP_WORKSPACE_ID}&limit=10
```

#### Get entity by ID

```
GET {SYNAP_POD_URL}/api/hub/entities/<uuid>?userId={SYNAP_AGENT_USER_ID}&workspaceId={SYNAP_WORKSPACE_ID}
```

#### Get document content

```
GET {SYNAP_POD_URL}/api/hub/documents/<uuid>?userId={SYNAP_AGENT_USER_ID}
```

#### Get workspace context (recent activity, entities, open views)

```
GET {SYNAP_POD_URL}/api/hub/users/{SYNAP_AGENT_USER_ID}/context?workspaceId={SYNAP_WORKSPACE_ID}
```

#### List pending proposals (things awaiting user approval)

```
GET {SYNAP_POD_URL}/api/hub/proposals?userId={SYNAP_AGENT_USER_ID}&workspaceId={SYNAP_WORKSPACE_ID}&status=pending
```

#### List installed skills

```
GET {SYNAP_POD_URL}/api/hub/skills/getSkills?userId={SYNAP_AGENT_USER_ID}&workspaceId={SYNAP_WORKSPACE_ID}
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
POST {SYNAP_POD_URL}/api/hub/entities
{
  "userId": "{SYNAP_AGENT_USER_ID}",
  "agentUserId": "{SYNAP_AGENT_USER_ID}",
  "workspaceId": "{SYNAP_WORKSPACE_ID}",
  "profileSlug": "note",
  "title": "Entity name",
  "properties": {},
  "reasoning": "Created via OpenClaw"
}
```

#### Create document (requires approval unless auto-approved)

```
POST {SYNAP_POD_URL}/api/hub/documents
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
POST {SYNAP_POD_URL}/api/hub/threads
{
  "userId": "{SYNAP_AGENT_USER_ID}",
  "workspaceId": "{SYNAP_WORKSPACE_ID}",
  "parentChannelId": "<channel_uuid>",
  "title": "Research: OpenClaw integration options",
  "branchPurpose": "..."
}
```

#### Link two entities together (create a relation)

```
POST {SYNAP_POD_URL}/api/hub/relations
{
  "userId": "{SYNAP_AGENT_USER_ID}",
  "agentUserId": "{SYNAP_AGENT_USER_ID}",
  "workspaceId": "{SYNAP_WORKSPACE_ID}",
  "sourceEntityId": "<uuid>",
  "targetEntityId": "<uuid>",
  "type": "related"
}
```

#### Report a long-running task (shows progress in user's workspace)

> **Note**: Background task endpoints are not yet available via the Hub Protocol REST API.
> This functionality is planned for a future release.

---

### External Message Relay

> **Note**: Dedicated external channel endpoints (`createExternalChannel`,
> `sendExternalMessage`) are not yet available via the Hub Protocol REST API.
> For now, use the thread/message endpoints below to relay external conversations.
> External channel support is planned for a future release.

When a message arrives on Telegram, WhatsApp, or another platform:

**Step 1**: Create or reuse a thread for this conversation.

```
POST {SYNAP_POD_URL}/api/hub/threads
{
  "userId": "{SYNAP_AGENT_USER_ID}",
  "workspaceId": "{SYNAP_WORKSPACE_ID}",
  "title": "Telegram: Alice"
}
```

**Step 2**: Post the message into the thread (with `autoRespond: true` to trigger IS):

```
POST {SYNAP_POD_URL}/api/hub/threads/<thread_uuid>/messages
{
  "role": "user",
  "content": "Hey are you free today?",
  "userId": "{SYNAP_AGENT_USER_ID}",
  "autoRespond": true
}
```

**What happens next**: Synap IS auto-responds within the channel. When it does, the
backend will relay its response back to you via `POST {your_gateway}/v1/chat/completions`
with an `x-openclaw-session-key` header containing the `externalChannelId`. Route the
content of `choices[0].message.content` back to the platform.

---

### A2AI Channels — Agent-to-Agent Communication

A2AI channels are how you and Synap IS communicate asynchronously. No human mediation
is required — you both post messages and poll for responses. In the Hub Protocol REST
API, A2AI channels are represented as **threads**.

#### List threads you participate in

```
GET {SYNAP_POD_URL}/api/hub/threads?userId={SYNAP_AGENT_USER_ID}&workspaceId={SYNAP_WORKSPACE_ID}
```

#### Post a message into an A2AI thread

```
POST {SYNAP_POD_URL}/api/hub/threads/<thread_uuid>/messages
{
  "role": "user",
  "content": "User asked about project status — here's the relevant Telegram thread:\n\n...",
  "userId": "{SYNAP_AGENT_USER_ID}",
  "autoRespond": true
}
```

Response:

- `{ "id": "...", ... }` → Message created. If `autoRespond` was true, Synap IS will respond (usually within 5-15s).

#### Complete A2AI poll-response cycle

After posting, poll for responses:

```javascript
async function waitForA2AIResponse(threadId, afterTimestamp) {
  const maxAttempts = 15;
  const pollIntervalMs = 3000;

  for (let i = 0; i < maxAttempts; i++) {
    await sleep(pollIntervalMs);

    const response = await fetch(
      `${SYNAP_POD_URL}/api/hub/threads/${threadId}/messages`,
      { headers: { Authorization: `Bearer ${SYNAP_HUB_API_KEY}` } }
    );
    const messages = await response.json();

    // Filter for AI responses after our message
    const aiMessages = messages.filter(
      (m) =>
        m.role === "assistant" &&
        new Date(m.timestamp) > new Date(afterTimestamp)
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
GET {SYNAP_POD_URL}/api/hub/threads/<thread_uuid>/messages
```

Response:

```json
[
  {
    "id": "...",
    "role": "assistant",
    "content": "...",
    "userId": "...",
    "timestamp": "2026-02-27T12:01:00Z"
  }
]
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
- Any access to endpoints outside the Hub Protocol (`/api/hub/*`)

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
[OpenClaw] → POST /api/hub/threads/<id>/messages (role=user, autoRespond=true): "User on Telegram asked: 'What's the status of project X?'"
[OpenClaw] → polls GET /api/hub/threads/<id>/messages every 3s
[Synap IS] → responds: "Project X has 3 open tasks, last updated 2 days ago."
[OpenClaw] → formats response, sends to Telegram
```

### Pattern 2: Synap IS delegating a task to OpenClaw

```
[Synap IS] → POST /api/hub/threads/<id>/messages: "Can you summarize the last 7 days of WhatsApp messages with Alice?"
[OpenClaw] → reads messages, summarizes
[OpenClaw] → POST /api/hub/threads/<id>/messages: "Summary: ..."
[Synap IS] → reads summary, creates entities in workspace
```

### Pattern 3: Proactive context enrichment

```
[OpenClaw] → user has been messaging about a meeting
[OpenClaw] → POST /api/hub/threads/<id>/messages: "Meeting context from Telegram: [thread]"
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

- `POST /threads/:id/messages`: 100/min per API key
- `GET /threads/:id/messages`: 200/min per API key

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
curl "$SYNAP_POD_URL/api/hub/search?query=meeting+notes&userId=$SYNAP_AGENT_USER_ID&workspaceId=$SYNAP_WORKSPACE_ID" \
  -H "Authorization: Bearer $SYNAP_HUB_API_KEY"

# Post message to A2AI thread (with auto-respond)
curl -X POST "$SYNAP_POD_URL/api/hub/threads/<thread_uuid>/messages" \
  -H "Authorization: Bearer $SYNAP_HUB_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"role":"user","content":"Hello from OpenClaw","userId":"'$SYNAP_AGENT_USER_ID'","autoRespond":true}'

# Poll thread for responses
curl "$SYNAP_POD_URL/api/hub/threads/<thread_uuid>/messages" \
  -H "Authorization: Bearer $SYNAP_HUB_API_KEY"

# Create an entity
curl -X POST "$SYNAP_POD_URL/api/hub/entities" \
  -H "Authorization: Bearer $SYNAP_HUB_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"userId":"'$SYNAP_AGENT_USER_ID'","agentUserId":"'$SYNAP_AGENT_USER_ID'","workspaceId":"'$SYNAP_WORKSPACE_ID'","profileSlug":"note","title":"Test","reasoning":"Created via OpenClaw"}'

# List threads
curl "$SYNAP_POD_URL/api/hub/threads?userId=$SYNAP_AGENT_USER_ID&workspaceId=$SYNAP_WORKSPACE_ID" \
  -H "Authorization: Bearer $SYNAP_HUB_API_KEY"
```

---

_synap-os skill v1.3.0 — maintained at github.com/synap-app/synap-backend/tree/main/skills/synap-os_
