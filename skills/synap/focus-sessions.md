## Focus Sessions — Goal-Bound Work Rooms

A **focus session** is a named, multi-step work room where you and AI agents collaborate on a specific goal. Use one whenever the work has a clear end state, will take more than one exchange, or involves multiple agents.

**Sessions are the default — you never have to ask.** Every write you make is grouped into a session automatically: yours if you started one, otherwise one opened for you (a _receipt_, closed on its own once idle and reviewed). Nothing is ever refused for lacking a session.

**When you begin a unit of work, start it yourself** — `synap_start_session` (MCP) / `start_session` (IS) / `synap session start` (CLI) with a short `title` (the name) and a `goal` (the outcome). If writes of yours were already auto-grouped, that session is adopted (`adopted: true`, same id) — never a second one.

**Fetch the pod's processes before you invent one.** Without `templateId`, the start door hands back the pod's existing playbooks ranked against your title and goal — the response's `playbooks` block lists `candidates` (id, name, score, and the `reason` each one matched) and applies **nothing**. Read them: if one fits, start again naming it with `templateId` (the only way a playbook binds), and if none does, go ad-hoc deliberately. Pass `templateId: null` to skip matching entirely. You can also look first, with `synap_list_playbooks` / `synap_match_playbooks`.

**Declare your definition of done** with `criteria` — binary, observable statements ("Typecheck passes with 0 errors"). Two to five, not a checklist. **Propose them yourself and let the person validate or rewrite them**; they may equally be written by the person, but a session with none can only be reported on by opinion. Closing never blocks on them; unmet ones are flagged. Already open with no criteria? Set them with `synap_update_session` (it replaces the list wholesale).

**Declare what the work will produce** with `expectedOutputs` — the documents, entities and decisions this session owes. That list is what makes "done" derivable instead of announced, and it is what the person's board shows as still outstanding.

**Keep the session true as you work — the person watches it, not your chat.**

- **Stages.** A bound playbook seeds the session's `stages`; set `currentStage` with `synap_update_session` each time the work moves on. A hand-set `progress` says less than a stage does.
- **Person-only steps** are an `owner: 'human'` output with a `blockedReason` and a `why` (below) — never a line buried in your reply.
- **Room first.** Post progress, questions and results in the session room (below); your own chat may repeat them.
- **Grade before you say done.** `synap_evaluate_session { sessionId, evidence: { <criterionKey>: { passed, detail } } }` with the real evidence — the command output, the link, the count. Then `synap_complete_session`. Closing never blocks on criteria, but an ungraded one reads as unmeasured: a claim nobody checked.
- **The doors remind you.** `synap_update_session` and `synap_complete_session` replies (and Hub `PATCH /focus-sessions/:id` / `POST …/complete`) carry `nudges` (criteria still ungraded, no criteria, a stage never set, outputs owed by the person, and — once, on a session born without a playbook — the playbooks that fit it). `orient`'s `startHere.sessionsOwingGrade` lists your open sessions with ungraded criteria.

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

**The session room**: every session owns a GROUP room — `session.channelId`, minted at start and returned on the session. **Room first:** post progress, questions and results THERE with `synap_post_message` (`channelId: session.channelId`); your own chat may repeat them. Why: the person supervises from Relay, their phone, and cannot watch your chat — a cloud or background session is only supervisable through its room. Pass `kind: 'question'` when you need an answer (it notifies the person); the default `kind: 'update'` lands in the app without a push. @-name the person to notify them too. The room is roster-only (the owner, invited agents, the owner's AI), and an AI answers in it only when @-mentioned. Do not fetch a personal channel for session work — `synap_get_channel` is the user's 1:1 assistant thread, not the session's room. The session's produced entities link back to it via the graph.

**Discoverability**: the `active-sessions` bento widget is on the default home dashboard. Sessions group their related proposals under a shared `correlationId` in the Proposal Review Board.
