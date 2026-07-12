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
