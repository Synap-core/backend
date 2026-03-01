# Intelligence UX & Capabilities

> Last updated: 2026-03-01
> Scope: Everything a user sees and does in Synap's intelligence system — from chat to service management.

This document is the companion to `AI_INTERACTION_ARCHITECTURE.md`. Where that document explains _how the system works internally_, this one explains _what users experience and what they can do_. It is intended as a brainstorming reference before production sign-off.

---

## Table of Contents

1. [Mental Model — What Users Need to Understand](#1-mental-model)
2. [The Intelligence App — Overview](#2-the-intelligence-app)
3. [Core User Journeys](#3-core-user-journeys)
4. [Feature Breakdown with User Stories](#4-feature-breakdown-with-user-stories)
   - 4.1 Channels — AI Chat
   - 4.2 Commands — Prompt Library
   - 4.3 Agents — AI Team
   - 4.4 Services — Service Dashboard
   - 4.5 Settings — Workspace Configuration
5. [Capability Matrix — Working vs. Placeholder](#5-capability-matrix)
6. [Permission & Governance UX](#6-permission--governance-ux)
7. [Multi-Service Routing UX](#7-multi-service-routing-ux)
8. [UX Gaps & Brainstorm Items](#8-ux-gaps--brainstorm-items)
9. [User Personas](#9-user-personas)

---

## 1. Mental Model

For the intelligence UX to click, users need to understand three concepts:

### 1.1 Channels are where conversations happen

Every conversation lives in a **channel**. Not all channels are AI-enabled:

| Channel type      | What it is                                      | AI responds?               |
| ----------------- | ----------------------------------------------- | -------------------------- |
| `ai_thread`       | Standard AI conversation                        | ✅ Always                  |
| `branch`          | A sub-conversation forked from a parent message | ✅ Always                  |
| `entity_comments` | Discussion thread on a specific entity          | ❌ No                      |
| `document_review` | Review/comments on a document                   | ❌ No                      |
| `direct`          | DM between two users                            | ❌ No                      |
| `external_import` | Telegram/WhatsApp/Slack conversation            | ❌ (AI responds via relay) |
| `a2ai`            | Agent-to-agent communication bus                | ✅ When an agent posts     |

**Key UX implication:** the user needs to know at a glance whether the channel they're in is AI-powered. Currently there is no persistent visual cue — this is an open UX gap.

### 1.2 Actions require approval unless whitelisted

The AI never silently modifies data. Every write action is either:

- **Auto-approved** — listed in the workspace's auto-approve whitelist (default: search, read, recall memory, link context)
- **Proposed** — creates a card in the user's Inbox. User reviews and approves/rejects.

This is the governance model. From a UX perspective it means: **AI conversations produce proposals, not side-effects by default.**

### 1.3 Multiple intelligence services can coexist

A workspace can have more than one AI service connected (e.g., Synap Intelligence + OpenClaw). Each service has:

- A URL and capabilities
- A health status
- Optional MCP tools it exposes
- A default routing assignment

Users can route different capabilities to different services (e.g., "use OpenClaw for browser and shell tasks, use Synap Intelligence for everything else").

---

## 2. The Intelligence App

The Intelligence App is the primary AI surface. It is accessible from the workspace sidebar and opens as a full-panel view.

### Tab structure

```
┌─────────────────────────────────────────────────────────────┐
│  Overview │ Channels │ Commands │ Agents │ Services          │
│                                    [ServiceChip] [?]         │
└─────────────────────────────────────────────────────────────┘
```

**Tab purposes:**

| Tab      | Primary purpose                              | Who uses it          |
| -------- | -------------------------------------------- | -------------------- |
| Overview | Graph visualization of workspace AI activity | Power users          |
| Channels | AI conversation interface                    | Everyone             |
| Commands | Reusable prompt templates                    | Everyone             |
| Agents   | AI agent catalog and customization           | Advanced users       |
| Services | Health monitoring, routing, MCP management   | Admins / power users |

**Header chips (right side of tab bar):**

- One chip per connected intelligence service
- Shows: service name, health dot (green/yellow/red/gray), "ACTIVE" badge
- Click → dropdown: "Set as active" / "Change service" → settings
- `?` button → "How your AI works" help drawer

---

## 3. Core User Journeys

### Journey 1 — First-time user: "I want to chat with AI"

```
1. Open Intelligence app
   → Default tab: Channels
   → If no AI service connected: empty state "Your AI team awaits"
     → CTA: "Connect Intelligence Service" → Settings

2. If Synap Intelligence is configured (default):
   → See empty chat welcome screen "Ask anything"
   → Prompt suggestions shown as clickable pills
   → Click suggestion or type message → AI responds (streaming)
   → AI response appears with typing animation
   → Proposals appear inline if AI needed to do something

3. Continue conversation or create new thread
```

### Journey 2 — User wants to invoke a specific agent

```
Type message in Channels:
  @ai        → default general-purpose agent
  @cto       → CTO persona agent (technical decisions)
  @marketing → Marketing persona agent
  @research  → Research specialist
  @code      → Code writing specialist
  @writing   → Document writing specialist
  @pm        → Project manager persona

→ Message sent to workspace's intelligence service
→ Routing uses persona-specific system prompt
→ Response appears as that agent
```

### Journey 3 — Power user: "I want to create a reusable prompt"

```
1. Channels tab → Commands tab
2. Click "Create command"
3. Fill in: Title + Prompt template
   (e.g., "Weekly summary" → "Summarize everything that happened this week in {workspaceName}")
4. Save command
5. Run: click Run button → parameter form (if template has variables)
6. AI executes → result opens in new thread in Channels
7. Re-run any time from Commands tab or ⌘K palette
```

### Journey 4 — Admin: "I want to connect OpenClaw for shell/browser tools"

```
1. Services tab → see "Connected Services" section
2. See "OpenClaw" add-on card with "Activate" button
   (or navigate to Settings → Available Connections)
3. Click "Activate"
   → Calls PATCH /pods/:id/addons { openclaw: true }
   → Toast: "OpenClaw activation started"
   → Status polling begins in background
4. Wait for addon status to change to "running" (~30–90s)
5. OpenClaw appears in "Connected Services" with health dot
6. Click "Details" → ServiceDetailView
   → Tools & MCP tab shows MCP endpoint
   → Approve MCP tools: click "Approve" button
7. AI agents can now call OpenClaw tools (shell, browser, filesystem, messaging)
8. Optional: Set OpenClaw as active service or route specific capabilities to it
```

### Journey 5 — Admin: "I want to add a custom MCP server"

```
Settings → Intelligence → MCP Servers section:
1. Click "Add server"
2. Choose transport: HTTP or stdio
3. Fill in:
   - Server ID (slug, lowercase)
   - Display name
   - URL (for HTTP) OR Command (for stdio, e.g. "npx @playwright/mcp")
4. Save → server appears in list with "enabled" badge
5. Optional: Click "Test" (HTTP only) → pings /tools/list endpoint
   → Success: "Connected — 12 tools available"
6. AI agents in this workspace now have access to those tools on next request
```

### Journey 6 — User: "I want to understand AI actions before they happen"

```
1. Send message that might trigger writes
   e.g., "Create a contact entity for Alice"
2. AI responds + proposes the creation:
   → Inline proposal card appears in thread
   → Card shows: "Create entity: Contact — Alice"
3. User reviews → clicks Accept or Reject
4. If accepted → entity is created
5. If rejected → AI is notified, can try alternate approach

Alternative (for non-auto-approved writes without explicit approval):
→ AI creates proposal automatically
→ User sees notification badge on Inbox
→ Inbox shows proposal with full context
→ Approve/reject from Inbox
```

### Journey 7 — Admin: "I want to control what AI can do automatically"

```
Settings → Intelligence → AI Permissions:
Toggle checkboxes:
  ✓ Search & read entities      (on by default)
  ✓ Recall memory               (on by default)
  ✓ Read entities               (on by default)
  ✓ Read documents              (on by default)
  ✓ Link context to threads     (on by default)
  □ Create entities             (off by default — requires proposal)
  □ Edit entities               (off by default)
  □ Create documents            (off by default)
  □ Edit documents              (off by default)
  □ Create branches             (off by default)

→ Changes take effect immediately for this workspace
→ Per-user: cannot override workspace restrictions
```

---

## 4. Feature Breakdown with User Stories

### 4.1 Channels — AI Chat

**What it is:** The primary interface for conversational AI. Every workspace conversation lives here.

**User stories:**

- As a user, I can start a new AI conversation and receive a streamed response
- As a user, I can see which agent and service responded to my message
- As a user, I can attach entities and documents to a conversation for context
- As a user, I can branch a conversation to explore a different approach without losing the original
- As a user, I can view all branches in a visual timeline
- As a user, I can see inline proposals from AI actions and accept or reject them
- As a user, I can rename a thread by clicking its title
- As a user, I can use @agent mentions to invoke specific AI personas
- As a user, I can see when AI is responding (streaming indicator)
- As a user, I can see step-by-step what the AI is doing (tool calls, results)
- As a user, I can view parallel branches side-by-side
- As a workspace admin, I can view all AI channels across the workspace (filtered channel list)

**Key interactions:**

- Message input with @mention autocomplete for agent names
- Streaming response with live token rendering
- Inline proposal cards with Accept/Reject buttons
- Collapsible right detail sidebar (context items, proposals, metadata)
- Branch timeline visualization

**Current placeholders / known gaps:**

- No visual indicator on thread header showing AI-enabled vs comment-only
- External import channel type has no inbound webhook implemented
- Direct channel type exists in schema but has no UI creation flow

---

### 4.2 Commands — Prompt Library

**What it is:** A library of reusable AI prompt templates that can be parameterized and run on demand.

**User stories:**

- As a user, I can create a named prompt template for a task I run repeatedly
- As a user, I can run a command from the Commands tab or via ⌘K
- As a user, I can see my recent command runs with status (pending/complete/error)
- As a user, I can click a recent run to open the result thread in Channels
- As a user, I can edit an existing command to update its template
- As a user, I can delete a command

**Key interactions:**

- Create/edit command modal (title + template)
- Run command sheet (parameter form if template has variables)
- Recent runs collapsible section (last 5)
- Each run links to its conversation thread

**Current placeholders / known gaps:**

- Command templates do not yet support structured variable substitution UI (user just types the full prompt)
- No command sharing between users in the same workspace
- No command categories or tags for organization

---

### 4.3 Agents — AI Team

**What it is:** A catalog of available AI agents with their specializations, tools, and customizable instructions.

**User stories:**

- As a user, I can browse all AI agents available in my workspace
- As a user, I can filter agents by type (Core / Specialist / Persona)
- As a user, I can click an agent to see its full details
- As a user, I can read an agent's system prompt to understand how it behaves
- As a user, I can write custom instructions for an agent (saved per workspace)
- As a user, I can see which tools an agent has access to
- As a user, I can see which skills are installed in the workspace
- As a user, I can start an agent-to-agent (A2A) conversation with a compatible agent

**AgentDetailView tabs:**

| Tab       | Status         | What it shows                                                                          |
| --------- | -------------- | -------------------------------------------------------------------------------------- |
| About     | ✅ Complete    | Description, system prompt (expandable), custom instructions (editable + saved)        |
| Tools     | ✅ Complete    | Grid of tool cards with category badges (action/context/coordination) and descriptions |
| Skills    | ✅ Complete    | Workspace skills with name, description, status badge                                  |
| Memory    | ⚠️ Placeholder | Static text: "Memory facts will appear here when connected"                            |
| Activity  | ⚠️ Placeholder | Static text: "Execution history will appear here"                                      |
| Proposals | ⚠️ Placeholder | Empty proposal section                                                                 |
| Channels  | ✅ Functional  | "Start A2A Channel" button                                                             |

**Current placeholders / known gaps:**

- "Add agent" button exists but has no UI flow (TODO comment in code)
- Memory tab shows placeholder — no live memory facts
- Activity tab shows placeholder — no execution history
- Proposals tab shows empty section — not populated
- Skills are workspace-scoped, not agent-scoped (all agents see same skill list)
- No way to install/uninstall skills from UI (list only)

---

### 4.4 Services — Service Dashboard

**What it is:** The intelligence operations center. Shows service health, usage analytics, capability routing, and MCP management.

**User stories:**

**Service Health:**

- As a workspace admin, I can see which AI services are connected and their health status
- As a workspace admin, I can manually trigger a health check for any service
- As a workspace admin, I can see the last health check time (relative: "5m ago")
- As a workspace admin, I can drill into a service to see its full details

**ServiceDetailView tabs (per-service drilldown):**

| Tab         | Status      | What it shows                                                                  |
| ----------- | ----------- | ------------------------------------------------------------------------------ |
| Overview    | ✅ Complete | Health status, 30-day usage stats, capabilities checklist, description         |
| Tools & MCP | ✅ Complete | MCP endpoint URL, approve/revoke, native capabilities list                     |
| Skills      | ✅ Complete | Workspace skills (same as Agents tab skills)                                   |
| Connection  | ✅ Complete | Service ID, webhook URL, version, pricing, Hub Protocol explanation, docs link |

**Usage Analytics:**

- As a workspace admin, I can see message and token counts per service for the last 30 days
- As a workspace admin, I can compare service usage via horizontal bar charts
- As a workspace admin, I can see average response latency per service

**Capability Routing:**

- As a workspace admin, I can set a workspace-default intelligence service
- As a workspace admin, I can route specific capabilities to specific services (e.g., shell → OpenClaw)
- As a user, I can see which routing overrides are active ("override" badges)
- As a user, I can set a personal service preference that overrides the workspace default

**MCP Management:**

- As a workspace admin, I can see the MCP endpoint for each connected service
- As a workspace admin, I can approve or revoke MCP tools per service
- As a workspace admin, I can add workspace-level MCP servers (applies to all agents)
- As a user, I can see MCP servers configured in the workspace

**Current gaps:**

- Health check for built-in Synap Intelligence service is not available (no refresh button for it)
- No health check history or uptime graph (only last check time)
- No automatic periodic health check polling (only manual)
- Service-specific configuration (API key rotation, custom webhooks) not exposed

---

### 4.5 Settings — Workspace Intelligence Configuration

**Location:** Workspace Settings → Intelligence

**What it covers:**

| Section               | Status               | Purpose                                             |
| --------------------- | -------------------- | --------------------------------------------------- |
| Current service       | ✅ Read-only display | Shows active service name + capabilities            |
| Available connections | ✅ Complete          | Register, activate, or remove intelligence services |
| Personal preference   | ✅ Complete          | Per-user service override                           |
| AI Permissions        | ✅ Complete          | Auto-approve whitelist (10 permission toggles)      |
| MCP Servers           | ✅ Complete          | Add/edit/delete/test workspace MCP servers          |
| Guide card            | ✅ Complete          | Link to Hub Protocol documentation                  |

**User stories (Settings-specific):**

- As a workspace admin, I can connect a custom intelligence service (Webhook URL + API key)
- As a workspace admin, I can activate a provisioned add-on (OpenClaw) with one click
- As a user, I can override the workspace AI service with my personal preference
- As a workspace admin, I can configure which AI actions auto-execute vs require approval
- As a workspace admin, I can add external MCP tool servers to the workspace
- As a workspace admin, I can test connectivity to HTTP MCP servers before enabling them

---

## 5. Capability Matrix

### Intelligence App Capabilities

| Capability                        | Status         | Notes                                                  |
| --------------------------------- | -------------- | ------------------------------------------------------ |
| AI chat (streaming)               | ✅ Complete    | Streaming SSE, step indicators                         |
| @agent mentions                   | ✅ Complete    | @ai, @cto, @marketing, @research, @code, @writing, @pm |
| Conversation branching            | ✅ Complete    | Fork, timeline view, parallel view                     |
| Inline proposals                  | ✅ Complete    | Accept/reject from thread                              |
| Context linking                   | ✅ Complete    | Attach entities/documents to thread                    |
| Command library                   | ✅ Complete    | Create, run, view history                              |
| ⌘K command palette                | ✅ Complete    | Run commands from anywhere                             |
| Agent catalog                     | ✅ Complete    | Browse, filter by type                                 |
| Agent custom instructions         | ✅ Complete    | Saved per workspace per agent                          |
| Agent tool listing                | ✅ Complete    | Shows tools with category badges                       |
| Agent skills listing              | ✅ Complete    | Workspace-scoped                                       |
| Service health monitoring         | ✅ Complete    | Health dot, last check, manual refresh                 |
| Service usage analytics           | ✅ Complete    | 30-day messages/tokens/latency                         |
| Per-service detail view           | ✅ Complete    | 4-tab drilldown (new)                                  |
| Capability routing matrix         | ✅ Complete    | Per-capability service assignment                      |
| MCP approval per service          | ✅ Complete    | Approve/revoke per workspace                           |
| Workspace MCP servers CRUD        | ✅ Complete    | Add/edit/delete/test                                   |
| OpenClaw activation               | ✅ Complete    | "Activate" → polls provisioning                        |
| AI permissions management         | ✅ Complete    | 10-toggle auto-approve whitelist                       |
| Personal service preference       | ✅ Complete    | Per-user override                                      |
| A2AI channels (agent-to-agent)    | ✅ Functional  | Start from AgentDetailView                             |
| External channels (Telegram etc.) | ⚠️ Schema only | DB exists, no inbound webhook                          |
| Direct channels (DM)              | ⚠️ Schema only | No UI creation flow                                    |
| Agent memory view                 | ⚠️ Placeholder | Shows static text                                      |
| Agent activity / run history      | ⚠️ Placeholder | Shows static text                                      |
| Add agent flow                    | ⚠️ Missing     | Button exists, no UI                                   |
| Skill install/uninstall           | ⚠️ List only   | No marketplace UI                                      |
| Health check history              | ❌ Missing     | Only last check time shown                             |
| Service configuration UI          | ❌ Missing     | No API key rotation, no webhook edit                   |

---

## 6. Permission & Governance UX

### Where governance surfaces

| Location                    | What user sees                     | Action available               |
| --------------------------- | ---------------------------------- | ------------------------------ |
| Inline in thread            | Proposal card with action summary  | Accept / Reject                |
| Inbox                       | Proposal list with context link    | Approve / Reject / View thread |
| Settings → AI Permissions   | Checklist of auto-approved actions | Toggle on/off                  |
| AgentDetailView → Proposals | Per-agent proposal list            | Accept / Reject (placeholder)  |

### Default auto-approve whitelist (visible in Settings)

These are on by default and users understand them as "safe reads":

- Search & read entities
- Recall memory
- Read entities
- Read documents
- Link context (entities/docs to threads)

These are off by default and require proposal unless enabled:

- Create entities
- Edit entities
- Create documents
- Edit documents
- Create branches

### UX clarity gaps

1. **No workspace-level governance log** — there is no page showing "all AI actions taken this week (auto-approved + proposed)"
2. **Proposals are ephemeral** — once approved/rejected they disappear from Inbox; no history
3. **No granularity within categories** — "Create entities" is all-or-nothing; can't say "allow creating Tags but not Contacts"
4. **The user doesn't know if a permission affects the current conversation** — no feedback like "this action was auto-approved because of your settings"

---

## 7. Multi-Service Routing UX

### Routing priority (from user perspective)

```
Is user's personal service preference set for this capability?
  → YES: use that service
  → NO: Is workspace capability override set for this capability?
       → YES: use that service
       → NO: use workspace default service
```

### Where users configure this

| Scope                    | Location                                | What they set                                       |
| ------------------------ | --------------------------------------- | --------------------------------------------------- |
| Personal (per-user)      | Settings → Personal Preference          | Override workspace default for "default" capability |
| Workspace default        | Services → Capability Routing → Default | Fallback for all capabilities                       |
| Workspace per-capability | Services → Capability Routing           | chat/analysis/shell/browser/filesystem              |

### UX clarity gaps

1. **Routing is not visible at message-send time** — user doesn't know which service will respond
2. **Personal preference only has a "default" capability**, not per-capability (unlike workspace routing)
3. **Service chips in header** show "ACTIVE" but don't communicate routing for specific capabilities
4. **No explanation of when routing matters** — user needs to understand that routing only matters when they have 2+ services

---

## 8. UX Gaps & Brainstorm Items

These are open questions and opportunities for improvement before production sign-off.

### 8.1 Discoverability

**Problem:** New users don't know what AI can do or how to invoke it.

**Current state:**

- Help chip (`?`) in Intelligence tab bar explains basics
- Empty state in Agents tab shows feature pills
- No guided onboarding for intelligence features

**Brainstorm:**

- [ ] First-message nudges ("Try asking me to summarize your recent entities")
- [ ] Discoverable @mention autocomplete in chat input
- [ ] "AI capabilities" tooltip on channels that show what actions are available
- [ ] Welcome message from AI when a new AI channel is created

---

### 8.2 Channel Type Visibility

**Problem:** Users don't know if a channel will trigger AI or not.

**Current state:** No visual cue distinguishing AI channels from comment threads.

**Brainstorm:**

- [ ] AI indicator icon (⚡ or ✦) in channel list sidebar next to AI thread titles
- [ ] Header badge in chat view: "AI-powered channel" / "Comment thread"
- [ ] Different background or accent color for AI vs non-AI channels
- [ ] Tooltip on channel type icon

---

### 8.3 Proposal Workflow Clarity

**Problem:** When does something become a proposal vs auto-execute?

**Current state:** User must know from Settings what's on/off. No feedback at conversation time.

**Brainstorm:**

- [ ] Ghost preview before AI sends: "I'm about to create 3 entities — approve?" (summary before execution)
- [ ] Micro-badge on messages that produced auto-approved actions: "✓ 2 auto-approved"
- [ ] Settings shortcut from proposal card: "Always auto-approve this type"
- [ ] Governance log page: timeline of all AI actions with approval status

---

### 8.4 OpenClaw / Add-On Activation Flow

**Problem:** Activation is a one-click "Activate" that kicks off background provisioning. User has no visibility into progress.

**Current state:** Toast "OpenClaw activation started", then nothing visible until reload.

**Brainstorm:**

- [ ] Provisioning progress indicator on the service card (with live status: "Downloading → Starting → Registering → Ready")
- [ ] Service card transitions from "Activate" → spinner → "Configuring" → "Running" without needing page reload
- [ ] Notification / toast when provisioning completes ("OpenClaw is ready")
- [ ] Error state with retry button if provisioning fails

---

### 8.5 MCP Server Discoverability

**Problem:** Users don't know what MCP servers exist or what they provide.

**Current state:** User must know the server URL/command in advance. No discovery.

**Brainstorm:**

- [ ] Curated list of popular MCP servers with one-click add:
  - Playwright (browser) — `npx @playwright/mcp`
  - Filesystem — `npx @modelcontextprotocol/server-filesystem`
  - PostgreSQL — `npx @modelcontextprotocol/server-postgres`
  - Slack — managed HTTP endpoint
- [ ] After adding, show tool count fetched from the server ("12 tools available")
- [ ] Tools catalog page: browse all tools across all connected MCP servers
- [ ] "Discover more" link → external MCP server registry

---

### 8.6 Agent Customization Depth

**Problem:** Custom instructions per agent work, but users may not realize they affect all conversations.

**Current state:** Custom instructions textarea in AgentDetailView with Save button.

**Brainstorm:**

- [ ] Preview of how instructions affect the next message ("Your custom instructions will be included in this conversation")
- [ ] Per-conversation instruction override (different from workspace-level)
- [ ] Instruction templates: start from a library of presets
- [ ] Character count and guidance on effective instruction writing

---

### 8.7 Intelligence Settings Complexity

**Problem:** Settings page has 5+ sections. New users may be overwhelmed.

**Current state:** Linear scroll through all sections.

**Brainstorm:**

- [ ] Progressive disclosure: collapse advanced sections by default
- [ ] "Quick setup" wizard for first connection
- [ ] Inline tips explaining what each permission means in practice
- [ ] Section separating "Basic" (current service, personal preference) from "Advanced" (MCP servers, routing)

---

### 8.8 Skills — No Management UI

**Problem:** Skills can be listed but not installed, enabled, disabled, or removed from UI.

**Current state:** Read-only list in AgentDetailView and ServicesTab.

**Brainstorm:**

- [ ] Skill toggle (enable/disable per workspace)
- [ ] Skill install from URL or file upload
- [ ] Link to skill marketplace (ClawHub or internal catalog)
- [ ] Per-skill "What does this do?" expandable description
- [ ] Skill conflict detection (two skills override same behavior)

---

### 8.9 Missing: Inbox as Intelligence Hub

**Problem:** Proposals exist but the Inbox is separate from the Intelligence app.

**Brainstorm:**

- [ ] "Inbox" section inside the Intelligence app showing pending proposals from AI
- [ ] Badge count on the "Channels" tab showing pending proposals
- [ ] Proposal cards in thread linked bidirectionally: click in Inbox → jumps to thread message
- [ ] Bulk approve/reject for batch AI operations ("Approve all 5 entity creations")

---

### 8.10 Missing: Agent-to-Agent UX

**Problem:** A2AI channels can be created from AgentDetailView but the concept isn't explained and the flow is disconnected.

**Brainstorm:**

- [ ] Dedicated "A2A" section in Channels tab sidebar (filtered channel list)
- [ ] Explain A2AI in the help dropdown ("AI agents can talk to each other in A2A channels")
- [ ] Visual diff between A2AI channel and human AI channel (icon, color accent)
- [ ] A2AI use cases surfaced: "Set up an OpenClaw → Synap AI relay for Telegram"

---

## 9. User Personas

### The Everyday User

**Goal:** Use AI to accelerate daily tasks without thinking about the machinery.

**Touchpoints:**

- Channels tab (daily)
- Commands tab (weekly)
- Inbox for proposals (as needed)

**Needs:**

- AI responds reliably
- @mentions work intuitively
- Proposals are clear and easy to act on
- No surprise side-effects

**Key pain points today:**

- Doesn't know which channel is AI-powered vs comment-only
- Not sure when AI will ask permission vs just do things

---

### The Power User

**Goal:** Extract maximum productivity, build custom workflows, use specialized agents.

**Touchpoints:**

- Agents tab (browsing, customizing)
- Commands tab (building library)
- @mentions (specific agents)
- Branching (exploring options)

**Needs:**

- Custom instructions per agent
- Parameterized command templates
- Branch comparison view
- Reliable streaming

**Key pain points today:**

- Agent memory and activity sections are placeholders
- No per-agent skill assignment
- Command templates don't support structured variables yet

---

### The Workspace Admin

**Goal:** Configure AI for the team. Connect services, set permissions, manage MCPs.

**Touchpoints:**

- Settings → Intelligence (frequently)
- Services tab (monitoring)
- Provisioning flow for add-ons

**Needs:**

- One-click add-on activation with progress feedback
- Clear service health monitoring
- Granular permission control
- MCP server management

**Key pain points today:**

- Provisioning shows toast but no progress indicator
- No governance log
- MCP server discovery requires knowing server URLs in advance
- Can't rotate service API keys from UI

---

### The Developer / Integrator

**Goal:** Extend Synap with custom intelligence services and MCP servers.

**Touchpoints:**

- Settings → Add connection
- ServiceDetailView → Connection tab
- External documentation

**Needs:**

- Clear Hub Protocol documentation
- ServiceDetailView shows registration details
- Test connectivity from UI

**Key pain points today:**

- Hub Protocol doc link goes to external docs (not yet published)
- No API key generation UI for Hub Protocol keys
- Service registration modal doesn't explain expected endpoints

---

## Appendix: Routing Logic Summary

For reference — the full routing decision tree from a user perspective:

```
User sends message in channel
   │
   ├─ Channel is NOT ai_thread or branch?
   │    → AI does not respond (entity_comments, document_review, direct)
   │
   └─ Channel IS ai_thread or branch:
        │
        ├─ User has personal service preference?
        │    → YES: use personal preference
        │
        └─ NO: Check workspace capability routing for the action type
             │
             ├─ Has workspace override for this capability?
             │    → YES: use that service
             │
             └─ NO: use workspace default service
                  │
                  └─ No workspace default? → use INTELLIGENCE_HUB_URL env var

AI executes tool
   │
   ├─ Action is in workspace autoApproveFor[]?
   │    → YES: execute immediately, silent
   │
   └─ NO: create proposal → notify user inbox
        │
        ├─ User approves → execute
        └─ User rejects → AI notified on next turn
```
