## Focus Sessions — Goal-Bound Work Rooms

A **focus session** is a named, multi-step work room where you and AI agents collaborate on a specific goal. Use one whenever the work has a clear end state, will take more than one exchange, or involves multiple agents.

**When to propose a session** (via the proposal system — always ask first):

- Research with 5+ sources → decision memo
- Lead generation sprint → qualified list + outreach drafts
- Incident investigation → postmortem doc
- Data import → structured knowledge base
- Any task you'd naturally call "a project" rather than "a question"

**How the AI proposes a session:**

```
create_proposal with targetType: "focus_session"
→ user reviews goal + rationale + expected outputs in ProposalReviewBoard
→ on approval, session is created in focus_sessions table
→ AI updates progress (0→100) via PATCH /api/hub/focus-sessions/:id { workspaceId, progress: N }
→ session auto-surfaces in the Active Sessions bento widget on the user's home
```

**Session templates** (pass as `templateId`):
`research-room` · `lead-sprint` · `decision-memo` · `import-cleanup` · `incident-room` · `campaign-intel`

**Hub Protocol REST** (for IS → backend; always include `workspaceId`):

- `POST /api/hub/focus-sessions` — create (include `correlationId` for idempotency)
- `GET /api/hub/focus-sessions/:id?workspaceId=<id>` — read
- `PATCH /api/hub/focus-sessions/:id` — update `{ workspaceId, progress, status, goal, agentIds }`

**Before you hand work to the human — check the guidelines first.** When you cannot take a deliverable, you file it on the human with `owner: 'human'`, a `blockedReason` (`credential` · `permission` · `capability` · `policy` · `decision` · `physical`) and a one-line `why`. Before you do, look up standing guidance for that kind of block. When the same block keeps recurring, the human may have approved a guideline for it, e.g. "Stripe keys live in the team vault under billing/".

- IS agent: `get_work_guidelines { workKind: "<blockedReason>" }`
- Hub REST: `GET /api/hub/guidelines?workKind=<blockedReason>&workspaceId=<id>` → `{ workKind, guidelines: [{ id, text }] }`

If a guideline lets you proceed, follow it instead of blocking. If none applies, block as usual. A failed lookup is an error, not "no guideline".

Every block door also carries the guidance in its response, as a safety net: `outputs/block`, an `addOutput`, a PATCH that adds a human-owned slot, or a create that declares one already blocked. That response comes back with `blockGuidelines: { status: "matched", matches: [{ expectedLabel, blockedReason, guidelines, message }] }`. If you see it, read it: the slot is filed, and a guideline covers this block. If it lets you proceed, do the work and reclaim the slot (`unblockOutput`). `status: "unavailable"` means the guidelines could not be read. A guideline never retires a slot, and it never changes what governance allows.

**CLI** (use when running as Claude Code / OpenClaw agent):

```bash
synap session start --goal "<goal>" [--workspace <id>]                 # create + start a session
synap session list [--workspace <id>] [--status active|paused|closed]  # list sessions
synap session get <id> [--workspace <id>]                               # read a session
synap session update <id> --workspace <id> --progress 50               # report progress
synap session update <id> --workspace <id> --status paused             # pause
synap session close <id> --workspace <id> [--recap "what was done"]    # close + recap
```

Note: `synap session start` creates a session directly (the agent-facing path). All hub-protocol writes are governance-gated server-side; the in-browser AI companion surfaces session creation through the proposal flow.

**MCP door**: after `synap_start_session` returns, call `synap_get_channel` to get a personal channel for the session, then `synap_post_message` with `triggerAI:true` to dispatch the IS agent for autonomous work on the goal. The agent's produced entities link back to the session via the graph.

**Discoverability**: the `active-sessions` bento widget is on the default home dashboard. Sessions group their related proposals under a shared `correlationId` in the Proposal Review Board.
