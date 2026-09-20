## Focus Sessions — Goal-Bound Work Rooms

A **focus session** is a named, multi-step work room where you and AI agents collaborate on a specific goal. Use one whenever the work has a clear end state, will take more than one exchange, or involves multiple agents.

**Sessions are the default — you never have to ask.** Every write you make is grouped into a session automatically: yours if you started one, otherwise one opened for you (a _receipt_, closed on its own once idle and reviewed). Nothing is ever refused for lacking a session.

**When you begin a unit of work, start it yourself** — `synap_start_session` (MCP) / `start_session` (IS) / `synap session start` (CLI) with a short `title` (the name) and a `goal` (the outcome). If writes of yours were already auto-grouped, that session is adopted (`adopted: true`, same id) — never a second one.

**Fetch the pod's processes before you invent one.** Without `templateId`, the start door hands back the pod's existing playbooks ranked against your title and goal — the response's `playbooks` block lists `candidates` (id, name, score, and the `reason` each one matched) and applies **nothing**. Read them: if one fits, start again naming it with `templateId` (the only way a playbook binds), and if none does, go ad-hoc deliberately. Pass `templateId: null` to skip matching entirely. You can also look first, with `synap_list_playbooks` / `synap_match_playbooks`.

**Declare your definition of done** with `criteria` — binary, observable statements ("Typecheck passes with 0 errors"). Closing never blocks on them; unmet ones are flagged.

**Hub Protocol REST** (for IS → backend; always include `workspaceId`):

- `POST /api/hub/focus-sessions` — create (include `correlationId` for idempotency; `templateId`, `criteria` as above)
- `GET /api/hub/focus-sessions/:id?workspaceId=<id>` — read
- `PATCH /api/hub/focus-sessions/:id` — update `{ workspaceId, progress, status, goal, agentIds }`
- Send `X-Session-Id` to name the session a call belongs to; without it, your writes group under your own session.

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

Note: all hub-protocol writes are governance-gated server-side — a start may come back `proposed`, which is normal.

**MCP door**: after `synap_start_session` returns, call `synap_get_channel` to get a personal channel for the session, then `synap_post_message` with `triggerAI:true` to dispatch the IS agent for autonomous work on the goal. The agent's produced entities link back to the session via the graph.

**Discoverability**: the `active-sessions` bento widget is on the default home dashboard. Sessions group their related proposals under a shared `correlationId` in the Proposal Review Board.
