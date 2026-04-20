# Governance — reference

Synap queues some agent writes for human approval. This file covers what triggers a proposal, the auto-approve whitelist, how to handle each response status, and agent-user semantics.

## Response statuses

Every write endpoint returns a `status` field. Handle all three.

```json
{ "status": "approved", "id": "ent_…", "message": "…" }
  → The write committed. Use { id } normally.

{
  "status":     "proposed",
  "proposalId": "prp_…",
  "summary":    "Delete task \"Q2 plan review\"",
  "reasoning":  "Destructive actions require your approval",
  "reviewPath": "/proposals/prp_…",
  "reviewUrl":  "https://studio.synap.live/proposals/prp_…",
  "message":    "…"
}
  → Queued for user review. Surface `summary` + `reviewUrl` to the user; do not retry.

{ "status": "denied", "reason": "…" }
  → Policy blocked the write. Explain the reason. Do not retry.
```

**`"proposed"` is not an error.** If your retry logic treats it as one, the system will create duplicate proposals.

## What triggers a proposal

Two independent factors:

### 1. Agent identity

If the Hub API key has an associated `agentUserId`, the backend treats the writer as an agent. Agent writes are checked against the workspace's auto-approve whitelist. Anything outside the whitelist is proposed.

If there's no agentUserId (human user with a personal API key), writes go through unless the workspace has `aiGovernance.forceProposals = true`.

### 2. Action type

The auto-approve whitelist is a list of `subjectType.action` pairs. For example `entity.create`, `document.read`, `view.create`.

## Default auto-approve whitelist

Agents can perform these actions directly without a proposal:

**Reads** (always, no gating):

- `search.*`
- `entity.read`, `document.read`, `relation.read`
- `memory.recall`
- `context.*`
- `filesystem.read`

**Writes** (auto-approved by default):

- `entity.create`, `entity.update`
- `relation.create`
- `document.create`
- `memory.store` (always auto-approved, never proposed)
- `view.create`
- `profile.create`, `profile.update`
- `property_def.create`, `property_def.update`
- `channel.create`
- `bento.arrange`
- `filesystem.write_workspace` (OpenClaw sandbox only)

**Proposal-gated** (always require approval when done by agents):

- `entity.delete`, `entity.archive`, `entity.purge`
- `view.update`, `view.delete`
- `profile.delete`
- `property_def.delete`
- `workspace.create`, `workspace.update`, `workspace.delete`

## Destructive action override

In **agent-owned workspaces** (workspaces where the owner is an agent user, not a human), destructive actions (`delete`, `archive`, `purge`) **always propose** even if they appear in the whitelist. This prevents an agent from wiping its own workspace without human sign-off.

## Workspace overrides

Each workspace has an `aiGovernance` settings object that can:

- **Replace the whitelist entirely** (`aiGovernance.autoApproveFor = ["entity.read", "search.*"]`) — this becomes the full allowed list; defaults no longer apply
- **Switch to agent-owned mode** (`settings.governanceMode = "agent-owned"`) — destructive actions (delete/archive/purge) always propose regardless of whitelist
- **Change who approves** (`aiGovernance.proposalApprovalPolicy = "admins_only" | "any_editor" | "owner_and_admins"`)

Don't try to infer the workspace's policy — either check explicitly (see "Runtime introspection" below) or just write and handle whatever `status` comes back.

## Don't set `source` manually

`source` is set by the backend based on the auth context. Setting it manually in the request body is ignored. If your API key has an agentUserId, writes are tagged `source: "agent"` automatically.

## The proposal lifecycle

When a write is proposed:

1. A row is created in the `proposals` table: `{ id, proposal, request, status: "pending" }`.
2. A notification is sent to the workspace admins.
3. The `proposed` response is returned to you with `proposalId`.
4. A human reviews in Synap's Proposals page, approves or rejects.
5. On approve: the request is replayed with proper permissions. On reject: the write is discarded.

You do not poll or wait. The user's experience is asynchronous.

## Agent users

An agent user is a pod-wide user with `agentMetadata.writesRequireProposal` set. Created by `POST /api/hub/setup/agent`. Each agent user has:

- `agentType`: a free-form string (`"claude-code"`, `"openclaw"`, `"raycast"`, `"custom"`)
- `agentMetadata`: arbitrary JSON for config
- Hub API keys scoped to `hub-protocol.read` + `hub-protocol.write` + `mcp.*`

The `agentUserId` on a Hub API key binds all writes done with that key to the agent user. Multiple keys can share one agent user.

## `userId` vs `agentUserId` in request bodies

For every write that takes `userId`, pass the **human user's ID**, not the agent's. The agent user is derived from the API key. Both IDs are tracked — the human appears in `createdBy`, the agent appears in `performedBy`.

```json
POST /api/hub/entities
{
  "userId":       "usr_antoine",    // the human
  "workspaceId":  "ws_…",
  "agentUserId":  "usr_claude_code", // optional, defaults from API key
  "profileSlug":  "task",
  …
}
```

If you pass the API key owner (often a system account) as `userId`, the entity appears in no one's feed. Always pass the real user.

## Handling proposed writes gracefully

When a write is proposed, surface three things to the user: what was queued, why, and how to act on it. The response carries everything you need — don't invent paraphrases.

**The formula:**

```
"I queued **{summary}** for your review. {reasoning}. Review: {reviewUrl}"
```

**Concrete examples:**

```
good: "I queued **Delete task \"Q2 plan review\"** for your review.
       Destructive actions need your approval.
       https://studio.synap.live/proposals/prp_abc"

good: "I queued **Create entity \"Acme Corp\"** for your review.
       https://studio.synap.live/proposals/prp_def"

good: "Queued 3 changes for your review — I'll post the links after each:
       1. https://studio.synap.live/proposals/prp_1 — Delete task "X"
       2. https://studio.synap.live/proposals/prp_2 — Delete task "Y"
       3. https://studio.synap.live/proposals/prp_3 — Delete task "Z""

bad:  "Error: write was not approved."
bad:  "Something needs your attention in Synap."        ← too vague
bad:  "I tried to delete that but I'm not sure it worked." ← sounds like a failure
```

**Rules:**

- Use the `summary` field **verbatim**, in bold. It's already short and human-readable.
- Include `reviewUrl` as a raw URL — let the client render it as a link.
- One line of chat per proposal. Don't bury the link in a paragraph.
- If the user asks "can you just do it?" — tell them no, it's queued; they can open the link to approve.
- **Don't wait or poll.** Move on with the conversation. The user approves in their own time; you'll see the effect when they ask you to read the data again.

**When multiple writes in one turn produce multiple proposals:** list them, one line each, with their links. Don't aggregate into a single "some stuff was queued" message.

**Clients without rich link rendering** (plain terminals, voice, SMS-style interfaces): still say the URL — the user can copy-paste it. Even if they can't click, they know where to go.

## Runtime introspection (preferred over hardcoded rules)

When you need to know the actual policy for a workspace — e.g., to tell the user "I can create entities directly, but deleting them will need your approval" — call:

```
GET /api/hub/workspaces/{workspaceId}/governance

→ {
    workspaceId: "ws_…",
    effective: {
      autoApproveFor: [           // the actual whitelist at this workspace
        "entity.create", "entity.update", "relation.create", "document.create",
        "view.create", "profile.create", "property_def.create", "memory.*", …
      ],
      governanceMode: "default" | "agent-owned",
      proposalApprovalPolicy: "owner_and_admins" | "any_editor" | "admins_only",
      destructiveAlwaysPropose: false,   // true when governanceMode === "agent-owned"
      destructiveActions: ["delete", "archive", "purge"]
    },
    source: "workspace" | "default",     // where `autoApproveFor` came from
    defaults: {
      autoApproveFor: [ /* the backend default list, for comparison */ ]
    }
  }
```

An action is auto-approved when:

- it matches an entry in `effective.autoApproveFor` (exact match or `subject.*` glob), AND
- it is NOT in `destructiveActions` when `destructiveAlwaysPropose` is true

Prefer this endpoint over the tables in this file — they snapshot the default at the time of writing and don't reflect workspace customization.
